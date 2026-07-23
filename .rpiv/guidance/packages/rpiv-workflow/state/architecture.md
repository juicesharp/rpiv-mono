# state/

## Responsibility
Append-only JSONL audit store for workflow runs at `<cwd>/.rpiv/workflows/runs/<run-id>.jsonl`. Owns the versioned on-disk row schema (`STATE_SCHEMA_VERSION`), write protocol, and fail-soft readers, plus the per-run `runs/<run-id>/sessions/` leaf (`childSessionsDir`) where detached child sessions persist. Every write is one full `JSON.stringify(row) + "\n"` via `appendFileSync`; every read is shape-filtered (not positional) so partial writes degrade gracefully. **Leaf module** — no imports from `runner/` or `sessions/`.

## Dependencies
- Node built-ins: `node:crypto` (`paths.ts`), `node:path` (`paths.ts`; `resolve.ts` — `basename`), `node:fs` (`writes.ts`, `reads.ts`, `raw.ts`, `names.ts`)
- `../internal-utils.js` — `formatError` (the sole VALUE import from package internals); type-only: `Output`, `RunTrigger`, `Artifact`, `UnitRole`

## Consumers
- Writers: `../runner/runner.ts` (`writeHeader`), `../runner/chain-advance.ts` (`appendRoutingDecision`), package-root `../audit-rows.ts` (`appendStage`, via `recordStage`) and `../loop.ts` (`appendLoopCap`)
- Public surface (`../registration.ts`, re-exported by `../index.ts`): `listRuns`, `readHeader`, `readLastStage`, `readLoopCaps`, `resolveRun` (ref → header), `listArtifacts`, `runFileFor` (the ONE opaque path projection), `STATE_SCHEMA_VERSION` + types `SessionRef`/`WorkflowHeader`/`WorkflowStage`/`RunSummary`/`LoopCapRow`. `readAllStages`/`readRoutingDecisions` stay on the internal `state/index.ts` barrel only; `runsDir`/`stateFilePath` live on the test-only `../internal.ts` subpath. `notifyPartialArtifacts` (a runner-side helper) reads via `listArtifacts`

## Module Structure
```
index.ts   — Public barrel (only what other modules consume)
state.ts   — Row types (WorkflowHeader, WorkflowStage, RoutingDecision) + secondary barrel
paths.ts   — Pure: generateRunId (YYYY-MM-DD_HH-MM-SS-<4hex>); runsDir; stateFilePath; namesFilePath; runFileFor; childSessionsDir
raw.ts     — LEAF under reads + names: readFirstJsonlLine (BOUNDED prefix read) + enumerateRunIds (covered by raw.test.ts)
writes.ts  — tryAppendJsonl primitive + thin wrappers (writeHeader, appendStage, appendRoutingDecision, appendLoopCap)
reads.ts   — readJsonlRows primitive + shape predicates + per-row readers + listRuns
resolve.ts — resolveRun (ref → header): the name-aware composer ABOVE reads + names
names.ts   — Run-name claim index: claimName/releaseName, readNamesIndex, rebuildIndex, isValidName/VALID_NAME
```
`raw.ts` exists so `names.ts` never re-implements header reads / dir scans to dodge a cycle, and `readHeader`/`listRuns` cost a bounded first-line read per file instead of a whole-file parse.

## Append-only writer (single primitive)
```ts
// writes.ts — the ONLY place that mutates the file; all atomicity, dir creation, fail-soft logging live here — new record kinds add a thin wrapper, not a new write path.
function tryAppendJsonl(cwd: string, runId: string, row: unknown): boolean {
  try {
    mkdirSync(runsDir(cwd), { recursive: true });                                   // idempotent
    appendFileSync(stateFilePath(cwd, runId), `${JSON.stringify(row)}\n`, "utf-8"); // one POSIX write per row
    return true;
  } catch (e) { console.warn(`[rpiv-workflow] ...${formatError(e)}`); return false; } // never throw; caller gates on the boolean
}
// Wrappers all return the boolean: writeHeader (runWorkflow REFUSES the run start on false — lost header ⇒ unlistable/unresumable), appendStage, appendRoutingDecision, appendLoopCap.
```

Invariants: no row is ever rewritten or deleted; the stage-number allocator advances once per activation REGARDLESS of `appendStage`'s boolean (a lost row's number is never reused) — only `stagesCompleted` and the returned `stageNumber` gate on it; routing-append failures surface as warnings (telemetry, never gate the chain).

## Header + record stream layout (shape-discriminated, not positional)
```jsonl
{"runId":"2026-05-20_15-30-45-ab12","workflow":"mid","input":"…","ts":"…","v":2,"trigger":{…}}
{"stageNumber":1,"stage":"plan","skill":"plan","status":"completed","ts":"…","output":{…},"session":{"id":"…"}}
{"type":"routing","fromStageIndex":1,"fromStage":"plan","decision":"build","ts":"…"}
{"stageNumber":2,"stage":"build","status":"completed","ts":"…","session":null}
```

Discriminators are shape, not position: header has `runId+workflow+input+ts`; routing carries `type:"routing"`; stage has numeric `stageNumber`. Header goes first so `listRuns` scales as N × first-line-parse, not N × full-file-parse. **Script-stage rows omit `skill`** — `JSON.stringify` drops the undefined key. Every stage row carries a REQUIRED `session: SessionRef | null` (the Pi session that backed the activation; `null` = explicit "no session involved" — script stages, preflight halts); a `collected: true` marker distinguishes a non-terminal collect-all fan-out unit halt (resume rebuilds a `failedOutput` sentinel by `unitIndex`) from a hard terminal-failure row.

## Line-level reader with corruption tolerance
```ts
// reads.ts — every line is parsed in its own try/catch.
function readJsonlRows<T>(cwd: string, runId: string, match: (row: unknown) => row is T): T[] {
  const rows: T[] = [];
  for (const line of lines) {
    try { parsed = JSON.parse(line); } catch { console.warn(`...skipping malformed JSONL row...`); continue; } // truncated trailing line MUST NOT erase prior rows
    if (match(parsed)) rows.push(parsed);                                     // shape-filter
  }
  return rows;
}
const isWorkflowStage   = (r): r is WorkflowStage => /* deep guard: numeric stageNumber, status ∈ enum, output.artifacts array when output present, parent ⇒ numeric unitIndex */;
const isRoutingDecision = (r): r is RoutingDecision => (r as any)?.type === "routing";
const isWorkflowHeader  = (r): r is WorkflowHeader => /* runId + workflow + input + ts */;
export function readHeader(cwd, runId): WorkflowHeader | undefined {  /* BOUNDED first-line read via raw.ts */ }
export function readLastStage(cwd, runId): WorkflowStage | undefined { /* last of readJsonlRows(isWorkflowStage) */ }
export function listRuns(cwd): RunSummary[] { /* readdirSync(runsDir(cwd)) + readHeader per file */ }
```

Truncation tolerance comes from per-line `JSON.parse` isolation: ENOSPC / SIGKILL mid-`appendFileSync` corrupts only the trailing line. DISPLAY readers shape-filter and silently skip rows they don't recognise (forward-compatible by ignoring). The trail is also resume's SYSTEM OF RECORD: the header carries `v` (`STATE_SCHEMA_VERSION`, now 2 — completion rows placed by `unitIndex`, `collected:true` sentinel rebuild); `reconstructState` refuses any other version — INCLUDING v1 and absent-`v` trails, which resolve to 1 — with `version-mismatch` ("start a fresh run"; no in-place migration). The strict `readAllStagesForResume` reader refuses stage-shaped rows that fail the deep guard or lack the `session` key (`hasValidSessionRef`) rather than skipping them; display readers stay lenient and never touch `session`.

## Path resolution (pure)
```ts
// paths.ts — no I/O; one source of truth for the on-disk layout. `.rpiv/workflows/` is shared with the loader (config.ts + packs/); state owns the runs/ leaf only.
export const runsDir           = (cwd: string) => join(cwd, ".rpiv", "workflows", "runs");
export const stateFilePath     = (cwd, runId)  => join(runsDir(cwd), `${runId}.jsonl`);
export const namesFilePath     = (cwd)        => join(runsDir(cwd), "names.json");
export const childSessionsDir  = (cwd, runId)  => join(runsDir(cwd), runId, "sessions"); // detached child-session files keyed by SessionRef.id — INTERNAL
export const runFileFor        = (cwd, run: { runId }) => stateFilePath(cwd, run.runId); // the ONLY public layout projection — OPAQUE, no sibling-path derivation
export const generateRunId     = (now = new Date(), suffix = randomBytes(2).toString("hex")) => /* YYYY-MM-DD_HH-MM-SS-<4hex> — filename-sortable; 4-hex tail prevents sub-second /wf collisions */;
```

## Architectural Boundaries
- **Sole owner of the `*.jsonl` trails under `.rpiv/workflows/runs/`** — only `writes.ts::tryAppendJsonl` mutates them (creating the dir on first write), only `reads.ts`/`raw.ts` read them. The per-run `runs/<runId>/sessions/` leaf is DEFINED here (`childSessionsDir`) but populated by the detached execution host (`runner/runner.ts` resolves it into the host ctx), read by `sessions/locate.ts`, and pruned by `pruneOrphanedChildSessions` (run-end orphan sweep, `rmSync`). `load/` owns the sibling `config.ts` + `packs/` under the shared `.rpiv/workflows/` parent (never created by either layer), so the two share the parent without setup coupling.
- **One-way ingest from runner** — runner never reads its own JSONL mid-run; in-memory `state` is the source of truth during a run
- **Read-only for external inspectors** — past-runs UIs use `listRuns` (header-only) + `readLastStage` / `readLoopCaps` / `listArtifacts`; no write helpers or layout paths exposed (`runFileFor` is the one opaque projection)
- **Strict layering** — `state/` MUST NOT import `runner/` or `sessions/`; that would invert the dependency and let runtime concerns leak into the audit log
- **Fail-soft writes** — wrappers return booleans; `writeHeader` gates the run start, `appendStage` failure yields an undefined `stageNumber` (the allocator still advances), routing + loop-cap rows are telemetry (warn, never gate)
- **No `fsync`** — relies on OS buffering; single-row `appendFileSync` is effectively atomic on local FS

<important if="you are adding a new record kind">
## Adding a Record Kind
1. Define the discriminated-union variant in `state.ts` — pick a `type` literal that no existing shape carries; never reuse `stageNumber`
2. Add an appender in `writes.ts` — thin wrapper around `tryAppendJsonl`; decide whether callers gate on the return (state-affecting) or surface failure (telemetry only) — mirror `appendStage` vs `appendRoutingDecision`
3. Add a type-guard + reader projection in `reads.ts` ONLY if a consumer needs to read it back: `const isFoo = (r): r is Foo => (r as any)?.type === "foo"`; `export function readFoos(cwd, runId) { return readJsonlRows(cwd, runId, isFoo); }`
4. Re-export from `state.ts`'s barrel (surfaced via the internal `state/index.ts`); add to `../registration.ts` ONLY if external consumers need it — types in `export type {...}`, functions in `export {...}`. Bump `STATE_SCHEMA_VERSION` only if the resume fold must consume the new kind
5. Test in `state.test.ts`: round-trip via the new reader AND assert pre-existing readers (`readAllStages`, `readRoutingDecisions`) still skip the new kind — shape isolation is the contract that lets new kinds land without migration
</important>
