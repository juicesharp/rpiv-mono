# scripts/ (rpiv-pi internal)

## Monorepo Context
This is the rpiv-pi-internal scripts directory — post-install user-runnable utilities shipped to consumers. Distinct from the monorepo-root `<repo>/scripts/`, which holds release-engineering tooling for the workspace itself (see `.rpiv/guidance/scripts/architecture.md`). Never confuse the two: scripts here run on a consumer machine; the root scripts orchestrate releases inside the monorepo.

## Responsibility
Standalone consumer-side utilities. Today the layer hosts a guidance-format migration CLI invoked by the `migrate-to-guidance` skill. Each utility runs without `npm install` (zero npm deps) and is shipped via the package's `files` array.

## Dependencies
Node.js built-ins only (`fs`, `path`, `child_process`). Zero npm dependencies — keeps every utility runnable on a consumer machine without an install step.

## Consumers
- **`migrate-to-guidance` skill** in `../skills/`: invokes the migration CLI directly via `node scripts/<name>.js --project-dir "${CWD}"`
- **No callers from inside `extensions/rpiv-core/`** — these scripts are user-runnable, not part of the extension runtime

## Module Structure
```
.                — Flat layout. One standalone CLI per file (plain JavaScript, not TypeScript).
                   Each file is self-contained: argv parsing, main(), JSON-on-stdout output,
                   `[rpiv:<name>]`-prefixed stderr diagnostics. No shared helpers.
```

## Architectural Boundaries
- **All-or-nothing writes** — collect every target path before writing; delete originals only after all writes succeed
- **No npm dependencies** — keeps utilities runnable on a fresh checkout without `npm install`
- **stdout = JSON, stderr = diagnostics** — the final report is machine-readable JSON on stdout; progress lines go to stderr with a `[rpiv:<name>]` prefix
- **Plain JavaScript** — distinct from `extensions/rpiv-core/` (TypeScript). Consumer-runnable without a TS toolchain

<important if="you are adding a new standalone CLI script to this layer">
## Adding a CLI Utility Script
1. Create `<name>.js`; write a `parseArgs(argv)` function for manual `argv` parsing (no third-party parser)
2. Use `// --- Section Name ---` comment dividers between logical phases
3. Write a `function main()` (sync) or `async function main()` (if async I/O needed)
4. Progress output: `process.stderr.write('[rpiv:<name>] …\n')`
5. Final machine-readable result: `process.stdout.write(JSON.stringify(report, null, 2))` — pretty-printed; all report fields always present, no optional keys
6. Call `main()` at the bottom; add `.catch` only for async main
7. Add the file to the package's `files` array so it ships to npm
</important>
