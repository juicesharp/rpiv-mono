# outcomes/

## Responsibility
Framework-shipped catalogue of `ArtifactCollector` / `ArtifactParser` primitives plus composite `Outcome` bundles (`sideEffectOutcome`, `gitCommitOutcome`). Pure leaf consumer of `../output-spec.ts` types + `../handle.ts` / `../transcript.ts` / `../internal-utils.ts` helpers. **Host-agnostic** — knows nothing about Pi tool names, `.rpiv/` paths, schema validation, or rpiv-pi conventions; convention layers live in sibling packages (rpiv-pi's `verdictOutcome` factory in `extensions/rpiv-core/built-ins/` composes on top of `verdictCollector` + `jsonBodyParser` from here).

## Dependencies
- **`../output-spec`**: the `ArtifactCollector` / `ArtifactParser` / `Outcome` / `CollectContext` / `ParseContext` / `SnapshotContext` contract + `defineCollector` / `defineParser` identity helpers (`OutputSpec` is a deprecated alias, ships one release)
- **`../handle`**: `Artifact` + handle factories (`fs(path)`, `url(href)`, `opaque(id)`); **`../output`**: `Output` type for the `GitCommitOutput` narrowing alias; **`../internal-utils`**: `throwInvalid` for construction-time throws (`collectors/union.ts`)
- **`../transcript`**: branch-scanning `iterToolUses`, `lastMatchInBranch` — honour `ctx.branchOffset` for continue-policy slicing; **`node:child_process` + `node:util`**: promisified ONCE in `exec.ts` (`execFileAsync` + 5 s `GIT_EXEC_TIMEOUT_MS`) for the git collectors

## Consumers
- Workflow authors via `../index.ts` barrel (`import { gitCommitOutcome, workspaceDiffCollector, ... }`)
- `../runner/run-stage.ts:captureStageSnapshot` calls `def.outcome?.collector.snapshot` BEFORE the stage body; `../sessions/extraction.ts` substitutes `sideEffectOutcome` only for `side-effect` stages that declare no `outcome` (a `produces` stage without one throws — there is no framework default)
- rpiv-pi's `rpivArtifactCollector` composes on top of `transcriptPathCollector` — convention layer outside this folder

## Module Structure
```
index.ts                    — Barrel: collectors + parsers + composite outcomes (no rpiv-pi conventions)
side-effect.ts              — noopCollector + sideEffectOutcome (collector-only Outcome)
git-commit.ts               — Composite outcome template: snapshot fn + collector + parser + Outcome
exec.ts                     — Shared execFileAsync + GIT_EXEC_TIMEOUT_MS (5 s) for the git collectors
collectors/                 — One factory per discovery channel (text-scan, transcript, url, directory, tool-call, workspace-diff, union) + require-opt.ts construction-time guard
parsers/                    — Optional interpreters (jsonBodyParser): read artifacts[0].handle → { kind, data }
```

## Three contracts at a glance
```ts
interface ArtifactCollector<Snap = unknown> { snapshot?(ctx: SnapshotContext): Promise<Snap> | Snap; collect(ctx: CollectContext<Snap>): Promise<CollectResult> | CollectResult; }  // snapshot runs BEFORE stage body — captures baseline
interface ArtifactParser<Snap, K extends string, D> { parse(ctx: ParseContext<Snap>): Promise<ParseResult<K, D>> | ParseResult<K, D>; }  // optional
interface Outcome<Snap, K, D> { name?: string; collector: ArtifactCollector<Snap>; parser?: ArtifactParser<Snap, K, D>; }  // name = default publish slot in state.named
// Tagged results — never throw across the runner boundary. Parser-less stages get Output { kind: "artifacts", data: artifacts } automatically.
type CollectResult = { kind: "ok"; artifacts: readonly Artifact[] } | { kind: "fatal"; message: string };
type ParseResult<K, D> = { kind: "ok"; payload: { kind: K, data: D } } | { kind: "fatal"; message: string };
```

## Dual-Surface Text Scan (text-scan.ts — the shared primitive)
```ts
// Assistant text scanned REVERSE (lastMatchInBranch); on miss, a tool-call-argument FALLBACK walks
// iterToolUses FORWARD taking the last hit. FATAL only when BOTH surfaces miss — the message names
// both ("scanned assistant text and tool-call arguments").
export interface TextScanCollectorOpts { pattern: RegExp; toHandle: (raw: string) => Artifact; noun: string;
  match?: (tc: ToolCall) => boolean; }   // match narrows ONLY the tool-arg fallback; no default —
                                         // host-agnostic. Convention layers pin tool names (rpiv-pi's
                                         // verdict collector pins it to write tools so a prior round's
                                         // read-back collects nothing). Validated inside textScanCollector.
```
`urlCollector` / `transcriptPathCollector` / `directoryPathCollector` are thin molds over it — they validate their own opts eagerly and FORWARD `match` verbatim (no re-validation; delegation).

## Collector molds — fail-soft snapshot diff
```ts
// workspaceDiffCollector / gitCommitCollector mold: snapshot returns Snap | undefined (channel absent from
// the START — not a git repo, etc.); collect tolerates undefined.
export const barCollector: ArtifactCollector<PreSnap | undefined> = defineCollector({
  async snapshot(ctx) { try { return { baseline: await capture(ctx.cwd) }; } catch { return undefined; } },
  async collect(ctx) {
    if (!ctx.snapshot) return { kind: "ok", artifacts: [] };  // documented degrade, not an error
    const post = await capture(ctx.cwd).catch(() => undefined);
    if (!post) return { kind: "fatal", message: `${ctx.skill}: capture worked at snapshot time but failed after the stage` };  // broke mid-stage — fatal, never a fabricated "no changes"
    return { kind: "ok", artifacts: diff(ctx.snapshot.baseline, post).map((p) => ({ handle: fs(p), role: "changed" })) };
  },
});
```

## Composite outcome (the `gitCommitOutcome` template)
```ts
// Co-locate data type + snapshot + collector + parser + wired Outcome in one file. Collector ALWAYS emits one artifact (even on no-op);
// `meta` carries the COMPLETE fact so the parser stays pure — gitCommitOutcome journals EVERY commit in prevSha..sha (`GitCommitData.commits`, optional for back-compat).
export const fooOutcome: Outcome<FooSnap | undefined, "foo", FooData> = { collector: fooCollector, parser: fooParser };  // concrete generics flow end-to-end into Output<"foo", FooData>
```

## `unionCollectors` — positional fanout (fatal only when ALL fail)
`unionCollectors(transcriptPathCollector(/* … */), toolCallCollector({ /* … */ }))` — use when channels are independent and one-success-is-enough; write a custom collector when snapshots need threading, artifacts need de-dup/ordering by source, or channels depend on each other.

## Context Fields Worth Knowing
- **`ctx.branchOffset`** — continue-policy slicing; every transcript scan must honour it
- **`ctx.unitLabel?`** (CollectContext) — present iff the session IS one loop unit (grade panels: the verdict dimension). Collectors may tighten on it; absent ⇒ degrade to loose shape, never fatal

## Architectural Boundaries
- **NO rpiv-pi conventions** — `verdictOutcome`, frontmatter parsers, `.rpiv/` paths live in `rpiv-pi`, not here. **NO typebox / pi-coding-agent imports** — outcomes are schema- and host-agnostic primitives
- **Snapshot is best-effort** — the runner's `captureStageSnapshot` swallows snapshot exceptions; snapshot returning `undefined` MUST be a tolerated branch in `collect`
- **Empty artifact list is OK for side-effect collectors**; for `produces` stages an empty list is fatal — enforced by `sessions/extraction.ts:enforceCompletionContract`, not here
- **Text-scan fatal policy** — fatal on miss of BOTH surfaces (text + filtered tool-args); channel absent at snapshot time → `{ kind: "ok", artifacts: [] }`; channel worked at snapshot then broke mid-stage → fatal

<important if="you are adding a new collector">
1. Create `outcomes/collectors/<name>.ts`. Decide: snapshot needed? If yes, declare `interface <Name>Snapshot` and a fail-soft snapshot fn (catch all, return `undefined`)
2. Pick a discovery channel: dual-surface text+tool-args → wrap `textScanCollector({ pattern, toHandle, noun, match? })` (do NOT hand-roll the scan + fatal-on-miss), tool-use (`iterToolUses(ctx.branch, ctx.branchOffset)`), or external (git/fs via `exec.ts`'s `execFileAsync` + `GIT_EXEC_TIMEOUT_MS`)
3. Export factory `fooCollector(opts): ArtifactCollector<...>` returning `defineCollector({ snapshot?, collect })`; validate opts eagerly via `requireOpt` (construction-time throws use `throwInvalid`), not as collect-time fatals
4. Re-export from `outcomes/collectors/index.ts` + the parent `outcomes/index.ts` barrel; add sibling `<name>.test.ts` mirroring `url.test.ts` / `workspace-diff.test.ts` — cover BOTH surfaces of any text-scan wrapper
</important>

<important if="you are adding a new parser">
1. Create `outcomes/parsers/<name>.ts`. Pick the envelope `kind` literal
2. Narrow `ctx.artifacts[0].handle.kind` first; fatal with skill-prefixed message on shape mismatch
3. Read & interpret (sync `fs` is fine for parsers; collectors use async git); return `{ kind: "ok", payload: { kind: "<lit>", data } }` or `{ kind: "fatal", message }`
4. Export via `defineParser`, barrel through `outcomes/parsers/index.ts`
</important>

<important if="you are composing a new composite outcome (like gitCommitOutcome)">
1. New file `outcomes/<name>.ts`; co-locate `interface <Name>Data`, `interface <Name>Snapshot`, snapshot fn, collector, parser
2. Collector emits ONE artifact (even on no-op) with parser hints in `meta` — keeps parser narrowing trivial
3. Export the wired pair `export const fooOutcome: Outcome<Snap|undefined, "<lit>", Data>` — concrete generics flow through to `Output<"<lit>", Data>`
4. If the data type is broadly useful, add `export type FooOutput = Output<"<lit>", FooData>` IN THE OUTCOME'S OWN FILE (the `GitCommitOutput` precedent) — the core `../output.ts` envelope module must never enumerate a concrete outcome
</important>
