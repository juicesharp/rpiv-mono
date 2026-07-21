# outcomes/

## Responsibility
Framework-shipped catalogue of `ArtifactCollector` / `ArtifactParser` primitives plus composite `Outcome` bundles (`sideEffectOutcome`, `gitCommitOutcome`). Pure leaf consumer of `../output-spec.ts` types + `../handle.ts` / `../transcript.ts` / `../internal-utils.ts` helpers. **Host-agnostic** — knows nothing about Pi tool names, `.rpiv/` paths, schema validation, or rpiv-pi conventions; convention layers live in sibling packages.

## Dependencies
- **`../output-spec`**: the `ArtifactCollector` / `ArtifactParser` / `Outcome` / `CollectCtx` / `ParseCtx` / `SnapshotCtx` contract + `defineCollector` / `defineParser` identity helpers (`OutputSpec` is a deprecated alias, ships one release)
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
interface ArtifactCollector<Snap = unknown> { snapshot?(ctx: SnapshotCtx): Promise<Snap> | Snap; collect(ctx: CollectCtx<Snap>): Promise<CollectResult> | CollectResult; }  // snapshot runs BEFORE stage body — captures baseline
interface ArtifactParser<Snap, K extends string, D> { parse(ctx: ParseCtx<Snap>): Promise<ParseResult<K, D>> | ParseResult<K, D>; }  // optional
interface Outcome<Snap, K, D> { name?: string; collector: ArtifactCollector<Snap>; parser?: ArtifactParser<Snap, K, D>; }  // name = default publish slot in state.named
// Tagged results — never throw across the runner boundary. Parser-less stages get Output { kind: "artifacts", data: artifacts } automatically.
type CollectResult = { kind: "ok"; artifacts: readonly Artifact[] } | { kind: "fatal"; message: string };
type ParseResult<K, D> = { kind: "ok"; payload: { kind: K; data: D } } | { kind: "fatal"; message: string };
```

## Collector molds — single-shot text-scan; snapshot + collect pre/post diff
```ts
// urlCollector / transcriptPathCollector mold: validate opts eagerly at construction time, then delegate to the
// shared textScanCollector primitive (collectors/text-scan.ts) — reverse lastMatchInBranch scan honouring
// ctx.branchOffset, fatal on miss, one role:"primary" artifact via toHandle.
export function fooCollector(opts: FooOpts): ArtifactCollector {
  requireOpt("fooCollector", "pattern", "is required and must be a RegExp", opts.pattern instanceof RegExp);
  return textScanCollector({ pattern: opts.pattern, toHandle: fs, noun: "path" });
}
// workspaceDiffCollector / gitCommitCollector mold: fail-soft snapshot returns Snap | undefined; collect
// tolerates undefined (channel absent from the START — not a git repo, etc.).
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
export const fooCollector: ArtifactCollector<FooSnap | undefined> = { snapshot: fooSnapshot, collect: (ctx) =>
  ({ kind: "ok", artifacts: [{ handle: opaque(id), role: "commit", meta: { /* ... */ } }] }) };
export const fooParser: ArtifactParser<FooSnap | undefined, "foo", FooData> = { parse: (ctx) =>
  ({ kind: "ok", payload: { kind: "foo", data: interpret(ctx.artifacts[0]?.meta, ctx.snapshot) } }) };
export const fooOutcome: Outcome<FooSnap | undefined, "foo", FooData> = { collector: fooCollector, parser: fooParser };  // concrete generics flow end-to-end into Output<"foo", FooData>
```

## `unionCollectors` — positional fanout (fatal only when ALL fail)
`unionCollectors(transcriptPathCollector(/* … */), toolCallCollector({ /* … */ }))` — use when channels are independent and one-success-is-enough; write a custom collector when snapshots need threading, artifacts need de-dup/ordering by source, or channels depend on each other.

## Architectural Boundaries
- **NO rpiv-pi conventions** — `artifactMdOutcome`, frontmatter parsers, `.rpiv/` paths live in `rpiv-pi`, not here. **NO typebox / pi-coding-agent imports** — outcomes are schema- and host-agnostic primitives
- **Snapshot is best-effort** — the runner's `captureStageSnapshot` swallows snapshot exceptions; snapshot returning `undefined` MUST be a tolerated branch in `collect`
- **Empty artifact list is OK for side-effect collectors**; for `produces` stages an empty list is fatal — enforced by `sessions/extraction.ts:enforceCompletionContract`, not here

<important if="you are adding a new collector">
## Adding a Collector
1. Create `outcomes/collectors/<name>.ts`. Decide: snapshot needed? If yes, declare `interface <Name>Snapshot` and a fail-soft snapshot fn (catch all, return `undefined`)
2. Pick a discovery channel: transcript text → wrap `textScanCollector({ pattern, toHandle, noun })` (do NOT hand-roll `lastMatchInBranch` + fatal-on-miss), tool-use (`iterToolUses(ctx.branch, ctx.branchOffset)`), or external (git/fs via `exec.ts`'s `execFileAsync` + `GIT_EXEC_TIMEOUT_MS`)
3. Export factory `fooCollector(opts): ArtifactCollector<...>` returning `defineCollector({ snapshot?, collect })`; validate opts eagerly via `requireOpt` (construction-time throws use `throwInvalid`), not as collect-time fatals
4. Fatal policy (the "nothing found" convention, `../output-spec.ts:CollectResult`): text-scan → fatal on miss; channel absent at snapshot time → `{ kind: "ok", artifacts: [] }`; channel worked at snapshot time then broke mid-stage → fatal
5. Re-export from `outcomes/collectors/index.ts` + the parent `outcomes/index.ts` barrel; add sibling `<name>.test.ts` mirroring `url.test.ts` / `workspace-diff.test.ts`
</important>

<important if="you are adding a new parser">
## Adding a Parser
1. Create `outcomes/parsers/<name>.ts`. Pick the envelope `kind` literal
2. Narrow `ctx.artifacts[0].handle.kind` first; fatal with skill-prefixed message on shape mismatch
3. Read & interpret (sync `fs` is fine for parsers; collectors use async git); return `{ kind: "ok", payload: { kind: "<lit>", data } }` or `{ kind: "fatal", message }`
4. Export via `defineParser`, barrel through `outcomes/parsers/index.ts`
</important>

<important if="you are composing a new composite outcome (like gitCommitOutcome)">
## Composing a Composite Outcome
1. New file `outcomes/<name>.ts`; co-locate `interface <Name>Data`, `interface <Name>Snapshot`, snapshot fn, collector, parser
2. Collector emits ONE artifact (even on no-op) with parser hints in `meta` — keeps parser narrowing trivial
3. Export the wired pair `export const fooOutcome: Outcome<Snap|undefined, "<lit>", Data>` — concrete generics flow through to `Output<"<lit>", Data>`
4. If the data type is broadly useful, add `export type FooOutput = Output<"<lit>", FooData>` IN THE OUTCOME'S OWN FILE (the `GitCommitOutput` precedent) — the core `../output.ts` envelope module must never enumerate a concrete outcome
</important>
