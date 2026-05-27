# @juicesharp/rpiv-workflow

Pi extension. Chain Pi skills into typed multi-stage workflows with audited JSONL state, predicate routing, and per-stage output validation.

**Skill-agnostic.** The runner sends `/skill:<name>` via Pi's native dispatch — it doesn't know or care who shipped the skill. Install on its own and write workflows over your own `~/.pi/agent/skills/`, or pair with [`@juicesharp/rpiv-pi`](../rpiv-pi) to use rpiv-pi's bundled `mid`, `large`, `small` workflows over rpiv-pi's bundled skills.

## Pick your lane

This package serves four overlapping audiences. Find yours, then jump to the matching section:

- **I want to run workflows over my own Pi skills.** → [Install](#install) → [Use](#use) → [Configure](#configure).
- **I'm shipping a workflow pack others install.** → [Configure](#configure) (the "config vs pack" split is what makes packs safe) → [Authoring DSL](#authoring-dsl).
- **I'm bundling workflows inside my own Pi extension.** → [Programmatic registration](#programmatic-registration).
- **I'm embedding the runtime in a non-Pi host.** → [Host boundary](#host-boundary) + [`runWorkflow`](#programmatic-runner).

## Install

```sh
pi install @juicesharp/rpiv-workflow
```

## Use

```
/wf                        # preview every loaded workflow
/wf <name>                 # preview one workflow's stage graph
/wf <name> <input>         # run a workflow with <input> piped to the start stage
```

## Configure

The loader merges workflows from three layers (each later layer overrides earlier by workflow name):

```
built-in (programmatic — registered by sibling packages like rpiv-pi)
  ← user packs        (~/.config/rpiv-workflow/workflows/*.ts, alpha-sorted)
  ← user config       (~/.config/rpiv-workflow/workflows.config.ts)
  ← project packs     (<cwd>/.rpiv-workflow/workflows/*.ts, alpha-sorted)
  ← project config    (<cwd>/.rpiv-workflow/workflows.config.ts)
```

Two file roles per layer:

- **Config file** — the one TypeScript file you hand-edit. Accepts three default-export shapes:

  ```ts
  // 1. A single Workflow
  import { defineWorkflow, produces, acts } from "@juicesharp/rpiv-workflow";
  export default defineWorkflow({
    name: "ship",
    start: "implement",
    stages: { implement: acts(), commit: acts() },
    edges: { implement: "commit", commit: "stop" },
  });

  // 2. A Workflow[] with a single entry
  export default [ /* one workflow */ ];

  // 3. The envelope form — required when shipping multiple workflows
  export default {
    workflows: [ /* many */ ],
    default: "ship",   // which one `/wf <input>` runs without a name
  };
  ```

- **Pack files** (`workflows/*.ts`) — installable bundles others can drop in. Accept only `Workflow | Workflow[]`. Packs **cannot** set `default` — that lives in the config file. This is what makes installable workflow packs safe: a pack contributes new workflows without overriding the user's default.

## Authoring DSL

A workflow is a typed graph: named entry point, a `stages` record, and an `edges` table that maps each stage to another stage name, the sentinel `"stop"`, or a predicate function that chooses at runtime.

Three factories for the two stage kinds:

- `produces(overrides?)` — `kind: "produces"`. The skill writes a file the next stage reads. Halts the chain if the path doesn't appear in the transcript. Without a Pi session, use [`produces.script`](#script-stages-no-pi-session).
- `acts(overrides?)` — `kind: "side-effect"`. The skill's side effect IS the work (commit, implement). The next stage inherits the prior artifact list forward — the stage's prompt receives the upstream primary artifact's handle. Without a Pi session, use [`acts.script`](#script-stages-no-pi-session).
- `terminal(overrides?)` — `kind: "side-effect"` with `inheritsArtifacts: false`. A side-effect stage that does NOT inherit the upstream artifact: its prompt receives `originalInput` (the run's brief), the upstream-artifact preflight is bypassed, and the rolling primary slot is cleared on success so anything downstream also starts without an inherited handle. The right answer for a final cleanup / summary / post-run notification stage that shouldn't be coupled to the upstream chain. Without a Pi session, use [`terminal.script`](#script-stages-no-pi-session).

### Multi-input stages — `reads:` and the named-publish registry

A stage that needs more than one upstream artifact (the canonical example: a "revise plan based on review" step that consumes both the plan and the review) declares `reads:` against names it expects in the registry:

```ts
revise: produces({ outcome: planOutcome, reads: ["plans", "reviews"] })
```

When set, the runner builds a labelled-flag prompt — `/skill:revise --plans <plan-path> --reviews <review-path>` — replacing the default single-artifact form. Multi-artifact stages get flag repetition (`--plans <a> --plans <b>`).

Names address `state.named`, an accumulating registry every `produces` stage appends onto on each successful run. The slot key is `outcome.name ?? stage.<record-key>`:

- **Outcome carries a name.** Multiple stages wiring the same outcome converge — both stages append onto the same `state.named[name]` slot, latest-wins on read. This is how to express "two stages both produce the canonical plan" without restating the name on each stage.
- **Outcome carries no name.** Stages publish under their record key. Downstream `reads: ["blueprint", "code-review"]` references stage names directly.

Slots are arrays — iteration history is preserved across backward-jump loops; the default read resolves to `array.at(-1)`. Load-time validation rejects `reads:` references whose name no produces stage publishes; the `ensureNamedReads` preflight halts at runtime when a name's slot is empty (the producer hasn't fired yet on this path).

Conditional routing uses `gate(field, branches)` with the bundled predicate helpers (`gt` / `gte` / `lt` / `lte` / `eq`):

```ts
import { gate, gt, eq } from "@juicesharp/rpiv-workflow";
edges: { "code-review": gate("blockers_count", { revise: gt(0), commit: eq(0) }) }
```

Branches are evaluated against `Number(output.data[field])` in declaration order; the first matching predicate wins, and the last declared branch is the fallback when no predicate matches (so missing or non-numeric fields route to the last branch).

Hand-rolled routes use `defineRoute(targets, fn, opts?)` — by default `opts.readsData` is `true` (reads `output.data`, requires the source stage to declare an `outputSchema`); pass `{ readsData: false }` for a route that consults only `state` / `output.meta`.

## Script stages (no Pi session)

Some stages don't need an LLM — they merge two upstream artifacts, bump a version field, or fire a post-run notification. The `.script` accessor on each factory runs a pure TS function in place of a Pi skill body. No `/skill:<name>` dispatch, no session, no transcript scan: the function gets a `ScriptContext` (`cwd`, `input` — upstream `Output` envelope, `state` — `Readonly<RunState>`) and either returns the new envelope (`produces.script`) or returns `void` (`acts.script` / `terminal.script`).

Stages with `.run` set CANNOT also declare `skill`, `outcome`, `fanout`, or `sessionPolicy: "continue"` — load-time validation rejects the combination. `produces.script` may declare `outputSchema` + `maxRetries` + `onInvalid` (same retry semantics as skill stages); `acts.script` / `terminal.script` may declare `inputSchema` for the upstream-data contract.

### `produces.script` — merge two upstream artifacts into a new Output

```ts
import { produces, fs, type ScriptContext } from "@juicesharp/rpiv-workflow";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const merge = produces.script({
  outputSchema: typeboxSchema(Type.Object({ planPath: Type.String() })),
  run: async (ctx: ScriptContext) => {
    const upstream = ctx.input?.artifacts ?? [];
    const bodies = await Promise.all(
      upstream
        .filter((a) => a.handle.kind === "fs")
        .map((a) => readFile(join(ctx.cwd, (a.handle as { path: string }).path), "utf-8")),
    );
    const planPath = `.rpiv/artifacts/plans/${Date.now()}.md`;
    await writeFile(join(ctx.cwd, planPath), bodies.join("\n\n---\n\n"));
    return {
      kind: "plan",
      artifacts: [{ handle: fs(planPath), role: "primary" }],
      data: { planPath },
    };
  },
});
```

The runner stamps `meta` (`stage`, `stageNumber`, `ts`, `runId`) on the returned envelope — authors only fill `kind` + `artifacts` + `data`. The first artifact (if any) becomes the rolling primary so downstream stages inherit it via `ctx.input.artifacts[0]` and `ctx.state.primaryArtifact`.

### `acts.script` — bump a file's version field

```ts
import { acts, type ScriptContext } from "@juicesharp/rpiv-workflow";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const bumpVersion = acts.script({
  run: async (ctx: ScriptContext) => {
    const path = join(ctx.cwd, "package.json");
    const pkg = JSON.parse(await readFile(path, "utf-8")) as { version: string };
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    pkg.version = `${major}.${minor}.${(patch ?? 0) + 1}`;
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  },
});
```

The runner synthesises a `{ kind: "side-effect", artifacts: [], data: {} }` envelope for the audit row. The rolling primary artifact slot is preserved — a downstream stage still inherits whatever the upstream `produces` stage set, same posture as a skill-based `acts(...)`.

### `terminal.script` — post-run cleanup that doesn't see the artifact

```ts
import { terminal, type ScriptContext } from "@juicesharp/rpiv-workflow";

const notifySlack = terminal.script({
  run: async (ctx: ScriptContext) => {
    // ctx.input is the upstream row's envelope — `ctx.state.primaryArtifact`
    // is NOT consulted (terminal.* opts out of inheritance). Any stage that
    // runs after also starts without an inherited handle.
    await fetch(process.env.SLACK_WEBHOOK!, {
      method: "POST",
      body: JSON.stringify({ text: `Run ${ctx.state.originalInput} complete.` }),
    });
  },
});
```

Like `terminal()`, the script variant desugars to `acts.script({ ...opts, inheritsArtifacts: false })`: the rolling primary slot is cleared on success so downstream stages start from a clean inheritance state. The right answer for a final cleanup / summary / post-run notification stage that shouldn't be coupled to the upstream chain.

### Lifecycle parity

Script stages fire the same lifecycle events as skill stages — `onStageStart` → (`onStageRetry`?) → `onStageEnd` | `onStageError` — with a `StageRef` discriminator of `kind: "script"` (vs `kind: "skill"`). The JSONL audit row carries the stage's record key in `stage` and omits the `skill` field entirely, so post-hoc readers distinguish the two paths by `row.skill === undefined`.

A thrown `run()` body records a terminal failure attributed to the stage via `MSG_SCRIPT_THREW`; the run halts and `onStageError` fires.

## Programmatic registration

Sibling packages contribute workflows at extension load:

```ts
import { registerBuiltIns, type WorkflowHost } from "@juicesharp/rpiv-workflow";
import { myWorkflows } from "./my-workflows.js";

export default function (host: WorkflowHost): void {
  registerBuiltIns(myWorkflows);
}
```

You can keep using `ExtensionAPI` from `@earendil-works/pi-coding-agent` in the
signature instead — it structurally satisfies `WorkflowHost`. Either choice
works; the published types name only the workflow-owned port.

These workflows are merged into the lowest layer (`built-in`); user/project overlays still override by name.

### Cross-package lifecycle (`registerLifecycle`)

When another extension needs to observe every workflow run in the process — typically an overlay widget that visualises in-flight stages, a metrics emitter, or a side-effect bridge — register a listener bundle at extension load:

```ts
import { registerLifecycle, type WorkflowHost } from "@juicesharp/rpiv-workflow";

export default function (host: WorkflowHost): void {
  const dispose = registerLifecycle({
    onWorkflowStart: (ctx)            => widget.open(ctx.runId, ctx.workflow, ctx.totalStages),
    onStageStart:    (stage, ctx)     => widget.markActive(ctx.runId, stage.name),
    onStageEnd:      (stage, _o, ctx) => widget.markDone(ctx.runId, stage.name),
    onStageError:    (stage, err, ctx)=> widget.markFailed(ctx.runId, stage.name, err),
    onWorkflowEnd:   (result, ctx)    => widget.close(ctx.runId, result.success),
  });
  // dispose() removes the bundle if the extension ever unloads.
}
```

Every fired event walks the registry in registration order, then the per-call bundle (if any) the embedder passed to `runWorkflow({ lifecycle })`. Multiple bundles coexist; one bundle throwing does not affect siblings or halt the run (throws are caught and logged via `ctx.ui.notify(..., "warning")`).

The registry is anchored on `Symbol.for("@juicesharp/rpiv-workflow:lifecycle")`, mirroring the `registerBuiltIns` pattern, so cross-package module resolution still shares one slot. Snapshot semantics: each event observes the registry as it stands at that instant — a registration made mid-event applies to subsequent events, not the in-flight one.

`@juicesharp/rpiv-pi` is the reference consumer (overlay widget that visualises in-flight runs).

## Host boundary

`rpiv-workflow`'s public type surface names **zero** `@earendil-works/pi-coding-agent`
types. The runtime declares two workflow-owned port interfaces in
`./host.js`:

- `WorkflowHost` — registry-level host (default export, continue-policy
  sends, skill-registration preflight).
- `WorkflowContext` — per-command ctx passed to `runWorkflow`; also the
  replacement ctx delivered to `newSession`'s `withSession` callback.
  `sendUserMessage` is optional at the type level (the outer command ctx
  Pi delivers to `/wf` doesn't carry one) — the runtime guarantees it is
  present inside `withSession`.

Pi's `ExtensionAPI` / `ExtensionCommandContext` / `ReplacedSessionContext`
structurally satisfy these ports, so existing embedders pass their Pi
handles through unchanged. A
compile-time tripwire (`host.test.ts`) fails immediately if Pi's API ever
drifts below the port shape. A future non-Pi host implements the three
port interfaces and drives the runtime without any pi-coding-agent
dependency.

## Programmatic runner

Embedders drive workflows from outside `/wf`:

```ts
import { runWorkflow } from "@juicesharp/rpiv-workflow";

const result = await runWorkflow({
  workflow: myFlow,
  input: "task description",
  host: piHost,  // any WorkflowHost-shaped value
});
```

Returns `{ runId, stagesCompleted, success }`. Past-run inspection uses `listRuns(cwd)` / `readHeader` / `readLastStage` / `listArtifacts`.

### Lifecycle

Pass `lifecycle` to observe stage progress in-process without re-reading the JSONL:

```ts
import { runWorkflow } from "@juicesharp/rpiv-workflow";

const result = await runWorkflow({
  workflow: myFlow,
  input: "task description",
  host: piHost,
  trigger: { kind: "external", source: "webhook", ref: "evt_42" },
  lifecycle: {
    onStageStart:  (stage, ctx)         => console.log("→", stage.name, ctx.runId),
    onStageEnd:    (stage, output)      => console.log("✓", stage.name, output.kind),
    onWorkflowEnd: (result)             => console.log("done:", result.success),
  },
});
```

Every callback receives a `LifecycleContext` with `runId`, `workflow`, `totalStages`, the `trigger` metadata, and a `Readonly<RunState>` snapshot. Events fire AFTER their JSONL row lands on disk, so a listener that calls `readLastStage(cwd, ctx.runId)` is guaranteed to see the just-recorded row. Callbacks may be async — the runner awaits them before advancing, giving back-pressure for free. Throws are caught + surfaced through `ctx.ui.notify(..., "warning")`; they never halt the run.

Available callbacks: `onWorkflowStart`, `onStageStart`, `onStageEnd`, `onStageRetry`, `onStageError`, `onRoute`, `onFanoutStart`, `onFanoutUnitStart`, `onFanoutUnitEnd`, `onWorkflowEnd`. See the `LifecycleListeners` JSDoc for the per-event payload.

### Trigger

`trigger` defaults to `{ kind: "programmatic" }`. Set it explicitly when spawning a run from a cron job, webhook handler, or sibling extension — the value lands in the JSONL header (`WorkflowHeader.trigger`), surfaces on `RunSummary.trigger` for past-run readers, and is threaded into every `LifecycleContext`:

```ts
type RunTrigger =
  | { kind: "command";      name: string;      meta?: Record<string, unknown> }
  | { kind: "programmatic"; source?: string;   meta?: Record<string, unknown> }
  | { kind: "external";     source: string; ref?: string; meta?: Record<string, unknown> };
```

`/wf` sets `{ kind: "command", name: "wf" }` itself — embedders only set this field for non-`/wf` entry points. Pi is single-active-session: external trigger sources MUST gate their own spawning if a run is already in flight; the runtime does not enforce a process-wide mutex.

## Outcomes — collectors and parsers

Each `produces` stage wires an `OutputSpec` that tells the runtime three things:

```ts
interface OutputSpec<Snapshot, Kind, Data> {
  name?:     string;                                // CATEGORISE — the publish slot in state.named (optional)
  collector: ArtifactCollector<Snapshot>;          // ENUMERATE — what did the stage produce?
  parser?:   ArtifactParser<Snapshot, Kind, Data>; // INTERPRET — what's the typed data channel?
}
```

`collector.collect(ctx)` returns the artifacts the stage emitted. `parser.parse(ctx)` (optional) turns them into the typed `output.data` downstream stages narrow on. With no parser, `output.data` is the artifact list itself (`kind = "artifacts"`). When `name` is set, every stage wired with this outcome publishes onto `state.named[name]` — the convergence mechanism behind [`reads:`](#multi-input-stages--reads-and-the-named-publish-registry); when omitted, stages publish under their record key.

There is no framework default for `produces` — load-time validation rejects a stage without an outcome. The `.rpiv/artifacts/<bucket>/<file>.md` layout is an rpiv convention, not a framework truth; pair with [`@juicesharp/rpiv-pi`](../rpiv-pi) for `rpivArtifactMdOutcome`, or wire your own.

### Authoring a collector

The collector is the user-supplyable primitive — one method, one return type:

```ts
import { defineCollector, opaque, type Artifact } from "@juicesharp/rpiv-workflow";

export const linearTicketCollector = defineCollector((ctx) => {
  const id = parseLinearIdFromBranch(ctx.branch);
  if (!id) return { kind: "fatal", message: "stage did not emit a Linear ticket id" };
  return { kind: "ok", artifacts: [{ handle: opaque(id), role: "ticket" }] };
});
```

Collectors that need a pre-stage snapshot declare a `snapshot` hook — its return value lands on `ctx.snapshot` for the matching `collect` call. Compose the bundled `gitHeadSnapshot` into any snapshot:

```ts
import { defineCollector, fs, gitHeadSnapshot, type GitHeadSnapshot } from "@juicesharp/rpiv-workflow";

const codegenCollector = defineCollector<GitHeadSnapshot | undefined>({
  snapshot: gitHeadSnapshot,
  collect: async (ctx) => {
    if (!ctx.snapshot) return { kind: "ok", artifacts: [] };
    const files = await diffWorkspace(ctx.cwd, ctx.snapshot.baselineSha);
    return { kind: "ok", artifacts: files.map((p) => ({ handle: fs(p), role: "generated" })) };
  },
});
```

### Bundled collector catalog

The framework ships only host-agnostic primitives — no Pi tool-name defaults, no `.rpiv/artifacts/` defaults, no domain helpers. Wrap them or compose with `unionCollectors` to build your own conventions. Grouped by discovery model:

**Scan the agent's text**

| Collector | Signature | What it does |
| --- | --- | --- |
| `transcriptPathCollector` | `({ pattern: RegExp })` | Scans assistant text for the last regex match; emits one `fs` artifact. Pattern is required — no framework default. |
| `directoryPathCollector` | `({ dir, ext? })` | Ergonomic wrapper over `transcriptPathCollector` for the `<dir>/<file>.<ext>` shape. |
| `urlCollector` | `({ pattern? })` | Scans for `https?://…`; emits a `url` handle. Default pattern is RFC-3986-flavoured; override for narrower hosts. |

**Observe tool use**

| Collector | Signature | What it does |
| --- | --- | --- |
| `toolCallCollector` | `({ match, toArtifact })` | Walks every `tool_use` part; emits N artifacts via the author's mappers. Universal across any Pi tool name. |

**Diff the filesystem**

| Collector | Signature | What it does |
| --- | --- | --- |
| `workspaceDiffCollector` | `({ filter? })` | Captures `git status --porcelain` pre-stage, diffs post-stage. One `fs` artifact per file the stage touched. Fail-soft when not a git repo. |

**Git**

| Collector | Signature | What it does |
| --- | --- | --- |
| `gitCommitCollector` | — | Detects a new HEAD commit vs. the pre-stage snapshot; emits an `opaque(sha)` artifact tagged `role: "commit"`. |

**Composition + empty**

| Collector | Signature | What it does |
| --- | --- | --- |
| `unionCollectors(...cs)` | — | Run N collectors, concatenate artifacts. Fatal only when every sub-collector fataled. |
| `noopCollector` | — | Always returns `{ kind: "ok", artifacts: [] }`. The primitive `sideEffectOutcome` is built directly from it: `sideEffectOutcome = { collector: noopCollector }`. |

Handle constructors: `fs(path)`, `url(href)`, `opaque(id)`, `inline(bytes, mime?)` — replace the verbose `{ kind: …, … }` literal at call sites. Serialise any handle to its canonical string with `handleToString`.

### Bundled parser catalog

| Parser | Output `kind` | Output `data` |
| --- | --- | --- |
| `jsonBodyParser` | `"json"` | `JSON.parse` of the primary `fs` artifact's body (`unknown` — narrow via `outputSchema`). |
| `gitCommitParser` | `"git-commit"` | `GitCommitData` (sha, prevSha, subject, filesChanged) parsed from `git`. |

Format-specific parsers (markdown frontmatter, YAML, TOML, …) live in the convention layer that owns them — rpiv-pi ships its own `frontmatterParser`.

### Wiring an outcome onto a stage

```ts
import {
  produces, defineWorkflow,
  toolCallCollector, jsonBodyParser, fs,
} from "@juicesharp/rpiv-workflow";

const writeFileCollector = toolCallCollector({
  match: (tc) => tc.name === "write_file" || tc.name === "edit",
  toArtifact: (tc) => ({ handle: fs(String(tc.input.path ?? tc.input.target_file)) }),
});

export default defineWorkflow({
  name: "scaffold",
  start: "generate",
  stages: {
    generate: produces({
      outcome: { collector: writeFileCollector, parser: jsonBodyParser },
    }),
  },
  edges: { generate: "stop" },
});
```

## Validators: sync vs async

`inputSchema` and `outputSchema` are [Standard Schema v1](https://standardschema.dev) values — Zod, Valibot, ArkType, TypeBox (via `typeboxSchema`), or hand-rolled `{ "~standard": { validate } }` objects. The runner awaits the schema's `~standard.validate` at both seams, so it works with sync and async schemas alike.

**Default to sync.** Pure shape contracts (`Type.Object({ … })`, `z.object({ … })`) resolve in one microtask, give the agent precise retry diagnostics, and have no failure mode beyond "this isn't the shape you said." For 95% of stages this is the right answer.

**Reach for async when correctness needs I/O.** Examples that don't fit the sync model:
- "the path in the output must actually exist on disk" — `fs.access` is async.
- "the spec the agent emitted must validate against a live endpoint" — `fetch` is async.
- you're already on an async-by-default schema lib (ArkType's deeply-async paths).

The contract is identical — author an async `~standard.validate` and the runner awaits it. A schema whose Promise never settles is bounded by the stage's `validateTimeoutMs` (default 5 min); a rejected Promise surfaces as a clean stage halt, attributed to the stage, with the same error class as a shape-failure halt. No opt-in flag, no parallel code path.

> Keep validation separate from the collector + parser. The collector's job is "what did the agent produce?" (enumerate); the parser's job is "parse it into typed data" (shape). The validator's job is "is the result correct?" (check + verify). With async validators available you don't have to push I/O verification into a custom collector/parser — keep them pure and put correctness checks on `outputSchema`.

## Architecture

See [`.rpiv/guidance/packages/rpiv-workflow/architecture.md`](../../.rpiv/guidance/packages/rpiv-workflow/architecture.md).
