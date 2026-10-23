# Startup import resolution

Pi loads this package's published TypeScript sources directly through Jiti. On the
entry point's eager import graph, relative specifiers should name the actual `.ts`
files. A `.js` specifier whose target exists only as `.ts` still works, but makes
Jiti perform fallback resolution even when its transform cache is warm.

This change only updates those static import/export specifiers and permits `.ts`
imports in the repository's existing no-emit TypeScript check. It does not change
registration order, the optional i18n contract, or the questionnaire UI's lazy
loading/prewarm behavior. The import-graph test guards the eager graph without
placing a machine-dependent timing threshold in CI.

The same rule now applies repo-wide: every package names the real `.ts` file in
relative imports, enforced by `scripts/check-ts-import-specifiers.mjs`
(`npm run check:ts-specifiers`).

## Reproduce

From the repository root, with npm, Git, tar, and a Pi CLI supporting `PI_TIMING=1`:

```sh
node scripts/benchmark-ask-user-question-startup.mjs --baseline 1ffa165c --runs 15 > before-after.json
node scripts/benchmark-ask-user-question-startup.mjs --baseline 1ffa165c --runs 15 --with-i18n > before-after-i18n.json
```

Use `--pi /path/to/pi` to select a different Pi installation. The default baseline
is `HEAD`, useful when comparing uncommitted edits; after committing the fix,
explicitly select its parent or the original upstream commit instead.

The script:

- Packs the baseline Git revision and current working tree with `npm pack
  --ignore-scripts`, then extracts their published files into equal-depth paths.
- Gives both packages identical packed `rpiv-config` sources from the current
  checkout, and optionally identical `rpiv-i18n` sources. Host-provided libraries
  remain supplied by Pi. It installs nothing and does not run package scripts.
- Uses an isolated home, agent directory, and working directory, with discovery
  and startup network operations disabled. It does not read the user's Pi
  settings or credentials and does not make model calls.
- Starts a fresh process per sample; discards two warm-ups per variant and then
  alternates execution order. Run on an otherwise idle machine.
- Fails on load errors or missing module/factory timings, emits raw samples and
  summary statistics as JSON, and removes its temporary package trees.

`importMs` is Pi's extension-import timing, including shared loader setup because
this extension loads first. `wallMs` measures the complete empty print-mode
process, **not** time until an interactive editor is ready. Neither measures
first-ever/cold-cache installation or first-question rendering.

## Example measurements

Pi 1.2.0, Node v26.0.0, macOS arm64; baseline
`1ffa165c224b5489fb5774a6652ef2e1c3bc6b2a`; 15 measured fresh processes per variant,
following two warm-ups each:

| Optional i18n | Metric | Baseline median | Patched median |
| --- | --- | ---: | ---: |
| Absent | Extension import | 97 ms | 23 ms |
| Absent | Whole process | 327.74 ms | 252.84 ms |
| Present | Extension import | 99 ms | 25 ms |
| Present | Whole process | 330.06 ms | 254.88 ms |

The improvement is approximately **74 ms of import time** and **75 ms of
whole-process time** in both configurations. Factory time stayed at 0–1 ms.
Import ranges were 96–104 vs 22–24 ms without i18n, and 98–110 vs 24–27 ms with it.
The same 15-sample benchmark also improves startup on the two Node majors used
by CI (same Pi version and machine):

| Node | Optional i18n | Import median, before → after | Whole-process median, before → after |
| --- | --- | ---: | ---: |
| 22.23.3 | Absent | 82 → 22 ms | 250.94 → 189.46 ms |
| 22.23.3 | Present | 84 → 22 ms | 253.30 → 190.52 ms |
| 24.21.0 | Absent | 85 → 20 ms | 262.31 → 190.02 ms |
| 24.21.0 | Present | 85 → 22 ms | 252.85 → 190.17 ms |

The package suite passes all 787 tests on both Node 22 and 24, including the new
startup-import regression test and the existing real-TUI factory, RPC, locale,
and lazy-load tests. The full monorepo suite passes 6,906 tests on Node 26 and
on Node 24 with coverage enabled; all repository coverage thresholds pass.

Results depend on the host, loader version, filesystem, and caches; they are not a
universal latency guarantee.
