#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const INSTALL_ALIASES = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal',
  'isnt', 'isnta', 'isntal', 'isntall',
  'add'
]);

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const ansi = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = ansi('1');
const dim = ansi('2');
const red = ansi('31');
const yellow = ansi('33');
const cyan = ansi('36');

function execNpm(args, opts = {}) {
  const result = spawnSync('npm', args, { stdio: 'inherit', ...opts });
  return result.status ?? 1;
}

function execNpmCapture(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function parseArgs(argv) {
  if (argv.length === 0 || !INSTALL_ALIASES.has(argv[0])) {
    return { isInstall: false };
  }
  const packages = [];
  let global = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-g' || a === '--global') { global = true; continue; }
    if (a.startsWith('-')) continue;
    packages.push(a);
  }
  return { isInstall: true, packages, global };
}

function getInstallLocation(global) {
  if (!global) return path.join(process.cwd(), 'node_modules');
  const { status, stdout } = execNpmCapture(['prefix', '-g']);
  if (status !== 0 || !stdout) {
    throw new Error('Could not determine npm global prefix');
  }
  return path.join(stdout, 'lib', 'node_modules');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function packageJsonPath(nmPath, name) {
  if (name.startsWith('@')) {
    const [scope, pkg] = name.split('/');
    return path.join(nmPath, scope, pkg, 'package.json');
  }
  return path.join(nmPath, name, 'package.json');
}

function snapshotNodeModules(nmPath) {
  const out = new Map();
  if (!fs.existsSync(nmPath)) return out;
  let entries;
  try {
    entries = fs.readdirSync(nmPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scopePath = path.join(nmPath, entry.name);
      let scopedEntries;
      try { scopedEntries = fs.readdirSync(scopePath, { withFileTypes: true }); }
      catch { continue; }
      for (const scoped of scopedEntries) {
        if (!scoped.isDirectory()) continue;
        const fullName = `${entry.name}/${scoped.name}`;
        const pkg = readJson(path.join(scopePath, scoped.name, 'package.json'));
        if (pkg) out.set(fullName, pkg.version || '0.0.0');
      }
    } else {
      const pkg = readJson(path.join(nmPath, entry.name, 'package.json'));
      if (pkg) out.set(entry.name, pkg.version || '0.0.0');
    }
  }
  return out;
}

function getDirectDepsFromPackageJson(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (!pkg) return new Set();
  return new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ]);
}

function packageNameFromSpec(spec) {
  if (spec.startsWith('@')) {
    const idx = spec.indexOf('@', 1);
    return idx === -1 ? spec : spec.slice(0, idx);
  }
  const idx = spec.indexOf('@');
  return idx === -1 ? spec : spec.slice(0, idx);
}

function inspectScripts(nmPath, names) {
  const findings = [];
  for (const name of names) {
    const pkg = readJson(packageJsonPath(nmPath, name));
    if (!pkg) continue;
    const scripts = pkg.scripts || {};
    const lifecycle = {};
    for (const key of LIFECYCLE_SCRIPTS) {
      if (scripts[key]) lifecycle[key] = scripts[key];
    }
    if (Object.keys(lifecycle).length > 0) {
      findings.push({ name, version: pkg.version, scripts: lifecycle });
    }
  }
  return findings;
}

function renderFindings(direct, transitive) {
  const lines = [''];
  lines.push(bold(red('  ⚠  Lifecycle scripts detected')));
  lines.push('');

  if (direct.length > 0) {
    lines.push(bold(`Direct dependencies (${direct.length}):`));
    for (const f of direct) {
      lines.push('');
      lines.push(`  ${bold(f.name)}@${f.version}`);
      for (const key of LIFECYCLE_SCRIPTS) {
        if (f.scripts[key]) {
          lines.push(`    ${yellow(key)}: ${f.scripts[key]}`);
        }
      }
    }
    lines.push('');
  }

  if (transitive.length > 0) {
    lines.push(bold(`Transitive dependencies (${transitive.length}):`));
    for (const f of transitive) {
      const types = LIFECYCLE_SCRIPTS.filter((k) => f.scripts[k]).join(', ');
      lines.push(`  ${dim('•')} ${f.name}@${f.version} ${dim(`[${types}]`)}`);
    }
    lines.push('');
    lines.push(dim('  Tip: inspect any with `npm view <name> scripts`'));
    lines.push('');
  }

  return lines.join('\n');
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (!parsed.isInstall) {
    process.exit(execNpm(argv));
  }

  const directDepNames = parsed.packages.length > 0
    ? new Set(parsed.packages.map(packageNameFromSpec))
    : getDirectDepsFromPackageJson(process.cwd());

  let nmPath;
  try {
    nmPath = getInstallLocation(parsed.global);
  } catch (err) {
    console.error(red(`npm-vet: ${err.message}`));
    process.exit(1);
  }

  const before = snapshotNodeModules(nmPath);

  console.log(dim('▸ Installing with --ignore-scripts to inspect lifecycle hooks first...'));
  const installCode = execNpm(['install', '--ignore-scripts', ...argv.slice(1)]);
  if (installCode !== 0) process.exit(installCode);

  const after = snapshotNodeModules(nmPath);
  const newPackages = [];
  for (const [name, version] of after) {
    if (before.get(name) !== version) newPackages.push(name);
  }

  if (newPackages.length === 0) {
    console.log(dim('▸ No new packages were added.'));
    process.exit(0);
  }

  const findings = inspectScripts(nmPath, newPackages);

  if (findings.length === 0) {
    console.log(dim(`▸ ${newPackages.length} package(s) installed; no lifecycle scripts found.`));
    process.exit(0);
  }

  const direct = findings.filter((f) => directDepNames.has(f.name));
  const transitive = findings.filter((f) => !directDepNames.has(f.name));

  console.log(renderFindings(direct, transitive));

  const answer = await prompt(`Run lifecycle scripts for ${findings.length} package(s)? [y/N] `);
  if (answer === 'y' || answer === 'yes') {
    const rebuildArgs = ['rebuild'];
    if (parsed.global) rebuildArgs.push('-g');
    if (parsed.packages.length > 0) {
      rebuildArgs.push(...findings.map((f) => f.name));
    }
    process.exit(execNpm(rebuildArgs));
  }

  console.log('');
  console.log(yellow('Lifecycle scripts skipped.') + ' Files are on disk but no scripts executed.');
  const removeTargets = parsed.packages.length > 0
    ? [...directDepNames].join(' ')
    : '<package-name>';
  console.log(dim(`  To undo: npm uninstall ${parsed.global ? '-g ' : ''}${removeTargets}`));
  console.log(dim('  Note: future `npm install` or `npm rebuild` may still run these scripts.'));
  process.exit(0);
}

main().catch((err) => {
  console.error(red(`npm-vet error: ${err.message}`));
  process.exit(1);
});
