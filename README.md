# npm-preflight

A thin wrapper around `npm install` that detects `preinstall`, `install`, and `postinstall` lifecycle scripts in newly installed packages, prints them to you, and asks for confirmation before letting them run.

> Vibe coded. Use at your own risk — this is a personal tool, not a hardened security product. It catches a real class of supply-chain attack but won't stop a determined attacker, and it won't catch malicious code that runs at `require` time rather than during install.

## Why

Every `npm install` you run is an implicit decision to execute arbitrary code from every package in the resolved dependency tree. Most of the time that code is benign (`node-gyp`, `esbuild`, `sharp`), but `postinstall` is also the most common foothold for malicious npm packages. `npm-preflight` makes that decision explicit.

## Install

```sh
npm install -g npm-preflight
```

That puts `npm-preflight` on your `PATH`. No runtime dependencies — it's a single Node script.

## Usage

Use it exactly like `npm`:

```sh
npm-preflight install <package>           # add a local dep
npm-preflight install -g <package>        # global install
npm-preflight install                     # install from package.json
npm-preflight add <package>               # alias also works
```

Anything that isn't an install command is forwarded to `npm` unchanged:

```sh
npm-preflight view some-pkg               # → npm view some-pkg
npm-preflight --version                   # → npm --version
```

### What you'll see

When a newly installed package has lifecycle scripts:

```
  ⚠  Lifecycle scripts detected

Direct dependencies (1):

  esbuild@0.28.0
    postinstall: node install.js

Transitive dependencies (1):
  • some-pkg@1.2.3 [install]

Run lifecycle scripts for 2 package(s)? [y/N]
```

- **Direct**: packages you explicitly asked for. Their full script bodies are shown.
- **Transitive**: packages pulled in by your direct deps. Listed with names and which lifecycle hooks they declare. To inspect a script body: `npm view <name> scripts`.

Answer `y` to run the scripts (`npm rebuild`). Answer anything else to skip — files stay extracted on disk but no script executes.

## How it works

1. Snapshots `node_modules` (or the global prefix's `lib/node_modules` when `-g` is used).
2. Runs `npm install --ignore-scripts` with your original arguments. Files extract, scripts don't run.
3. Diffs the snapshot. Only newly added packages are inspected.
4. Reads each new package's `package.json` and looks for `preinstall`, `install`, `postinstall`.
5. On `y`, runs `npm rebuild` (scoped to the new packages when you passed names on the command line). On `n`, leaves files in place but no script ever runs.

Because the inspection happens after resolution, you see the actual versions and scripts npm picked — not just whatever the registry currently advertises.

## Limitations

- **Not a sandbox.** If you say `y`, the scripts run with your full user permissions. This tool only gives you a chance to read what they are first.
- **Files are still on disk after `n`.** Saying no skips script execution but the package contents are extracted. A future `npm install` or `npm rebuild` in that directory may run the scripts. Run `npm uninstall <pkg>` if you want it fully gone.
- **Only covers `npm install` / `i` / `add`.** Other entry points (`npm ci`, `npm update`, `pnpm`, `yarn`) are not wrapped.
- **Doesn't catch require-time malware.** A package that runs malicious code on `require()` rather than via lifecycle scripts will not be flagged.

## License

MIT
