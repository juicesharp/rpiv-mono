# Embedding the Workflow Runtime

How to drive `@juicesharp/rpiv-workflow` from code instead of `/wf`: the host ports you implement, the registrars siblings call at extension load, the programmatic runner, and the lifecycle stream.

## Table of Contents

- [Entry points](#entry-points)
- [Host boundary](#host-boundary)
- [Contributing built-in workflows](#contributing-built-in-workflows)
- [The execution-host seam](#the-execution-host-seam)
- [Programmatic runner](#programmatic-runner)
- [Resuming a run](#resuming-a-run)
- [Cancellation](#cancellation)
- [Cross-package lifecycle](#cross-package-lifecycle)
- [Trigger metadata](#trigger-metadata)
- [Inspecting past runs](#inspecting-past-runs)

## Entry points

The package publishes five entry points. Per-module deep imports
(`from "@juicesharp/rpiv-workflow/api.js"`) are **not** supported across the
package boundary.

| Entry | Contents | When to import it |
| --- | --- | --- |
| `@juicesharp/rpiv-workflow` | Everything in `/registration` plus the runner (`runWorkflow`, `runWorkflowByName`, `resumeWorkflow`, `resumeWorkflowByRunId`) | Embedders that execute runs |
| `@juicesharp/rpiv-workflow/registration` | The runner-free surface: DSL, loader, outcomes, handles, validators, host port types. The single canonical enumeration of the public API | Authoring, loading, validating — skips the ~530 ms engine graph |
| `@juicesharp/rpiv-workflow/startup` | Only the registrars a sibling wires at extension load (~9 ms) | Extension `default` exports |
| `@juicesharp/rpiv-workflow/runner` | The runner surface on its own, plus `StagePreflightError` and `MAX_BACKWARD_JUMPS` | Callers that already hold the DSL elsewhere |
| `@juicesharp/rpiv-workflow/internal` | Test-only seams (`recordStage`, registry resets) | Tests |

The Pi extension `default` entry is `./extension.ts`, not the barrel — loading
the extension registers `/wf` and the docs-protocol hook without evaluating the
runtime re-exports.

## Host boundary

The package's public type surface names **zero** `@earendil-works/pi-coding-agent`
types, and imports no value from it. Every host capability the runtime needs is a
workflow-owned port declared in `./host.js`:

| Port | What it is | Members the runtime touches |
| --- | --- | --- |
| `WorkflowHost` | Registry-level host — the value a Pi extension's `default` receives | `registerCommand`, `getCommands` |
| `WorkflowHostContext` | The per-run **executor** ctx handed to `runWorkflow` | `cwd`, `hasUI`, `ui.notify`, `sessionManager.{getBranch,getSessionId,getSessionFile}`, `waitForIdle`, `signal?`, `maxConcurrency`, `spawnChild` |
| `WorkflowLauncherContext` | `Omit<WorkflowHostContext, "spawnChild" \| "maxConcurrency">` — the **observer** surface the `/wf` handler receives | everything above minus the two executor members |
| `WorkflowSessionContext` | The child ctx delivered to `spawnChild`'s `withSession` callback; adds a guaranteed sender | `sendUserMessage`, optional `toolTimeout()` |

Pi's `ExtensionAPI` structurally satisfies `WorkflowHost` and its
`ExtensionCommandContext` satisfies the observer surface — embedders pass their
existing Pi handles through unchanged. The full executor port
(`spawnChild` + `maxConcurrency`) is satisfied by `SdkWorkflowHost` in
[`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi). A
compile-time tripwire (`host.test.ts`) fails immediately if Pi's types ever drift
below the observer port; the executor-satisfaction assertion lives in rpiv-pi,
because rpiv-workflow must not import rpiv-pi.

### `spawnChild`

```ts
spawnChild<T>(options: {
  prompt: string;
  model?: ModelSelection;              // { model?: string; thinking?: "off" | … | "xhigh" }
  signal?: AbortSignal;                // abort THIS child mid-flight
  reattach?: { sessionFile: string };  // open the persisted session in place
  fork?: { sessionFile: string };      // fork it into a new child (sessionPolicy: "continue")
  unitIndex?: number;                  // fan-out unit hint for lane-aware hosts
  withSession: (child: WorkflowSessionContext) => Promise<T>;
}): Promise<T>;
```

The parent ctx stays valid — there is no session swap. The runner may have up to
`maxConcurrency` calls in flight at once (`1` ⇒ sequential). `model` is applied by
the host at session creation, not via global mutation; the key is host-opaque and
resolved through the host's own registry. At most one of `reattach` / `fork` is
set, and both suppress the initial `prompt` send.

A non-Pi host implements these ports and drives the runtime with no
pi-coding-agent dependency at all.

## Contributing built-in workflows

Sibling packages contribute workflows into the lowest merge layer at extension
load. User and project overlays still override them by workflow name.

```ts
import { registerBuiltIns } from "@juicesharp/rpiv-workflow/startup";
import type { WorkflowHost } from "@juicesharp/rpiv-workflow/registration";
import { myWorkflows } from "./my-workflows.js";

export default function (host: WorkflowHost): void {
  registerBuiltIns(myWorkflows);
}
```

Building the workflow objects eagerly costs startup time. Prefer the provider
form with a dynamic import, so definitions are built on the first `/wf` rather
than on every session start:

```ts
import { registerBuiltIns, registerBuiltInsProvider } from "@juicesharp/rpiv-workflow/startup";

export default function (): void {
  registerBuiltInsProvider(async () => {
    const { myWorkflows } = await import("./my-workflows.js");
    registerBuiltIns(myWorkflows);
  });
}
```

Providers flush once and are memoised. A provider that throws is reported as a
load **warning** — the loader never throws.

`/startup` also carries the other registrars a sibling wires at load time:
`registerLifecycle`, `registerWorkflowExecutionHost`, `registerBucketKindMapping`,
`getBucketKindMappings`, `registerCompositionComparator`, `registerOutcomeDeriver`,
`registerSkillContracts`, `registerSkillContractsProvider`.

## The execution-host seam

`registerWorkflowExecutionHost(provider)` injects the detached executor. The
provider's `createHost(observer, { runId, childSessionsDir, name?, workflow?, input? })`
returns `{ host, signal?, dispose? }`: the executor ctx that actually spawns child
sessions, an optional run-level abort signal, and a teardown the runner calls in
`finally`. An optional `resolveModel({ stage, skill })` on the provider fills each
child's `ModelSelection`.

The slot is anchored on `Symbol.for("@juicesharp/rpiv-workflow:executionHostProvider")`,
so a duplicated module instance still resolves to the same registration. **When no
provider is registered, the live ctx executes stages directly** — the runtime
degrades gracefully for non-Pi embedders and tests.

## Programmatic runner

```ts
import { runWorkflow } from "@juicesharp/rpiv-workflow";

const result = await runWorkflow(ctx, {   // ctx: WorkflowHostContext
  workflow: myFlow,
  input: "task description",
  host: piHost,                           // any WorkflowHost-shaped value
});
```

`RunWorkflowOptions`:

| Option | Type | Default |
| --- | --- | --- |
| `workflow` | `Workflow` | required |
| `input` | `string` | required — passed to the start stage as its argument |
| `host` | `WorkflowHost` | none; used for the skill-registration preflight snapshot |
| `maxIterations` | `number` | `32` — run-wide cap on loop units of every kind |
| `maxBackwardJumps` | `number` | `2` per destination stage |
| `trigger` | `RunTrigger` | `{ kind: "programmatic" }` |
| `lifecycle` | `LifecycleListeners` | none |
| `signal` | `AbortSignal` | none |
| `resolveModel` | `(id: { stage, skill }) => ModelSelection \| undefined` | none ⇒ host default |
| `name` | `string` | none — human-readable run alias, rejected if already in use |

`RunWorkflowResult` comes back as `{ runId?, stagesCompleted, success, lastArtifact?, error?, termination? }`.
`termination` is the full-fidelity discriminated outcome —
`"running" | "completed" | "failed" | "aborted" | "cancelled"` — behind the
`success` / `error` projections, which cannot tell an abort from a cancellation.
`runId` and `termination` are undefined **only** for pre-flight rejections where no
JSONL file was ever created.

### By name

`runWorkflowByName` folds `loadWorkflows` → `findWorkflow` → `runWorkflow` into
one call:

```ts
import { runWorkflowByName } from "@juicesharp/rpiv-workflow";

const result = await runWorkflowByName(ctx, "research", "add dark mode", { host: piHost });
if (!result.success) ctx.ui.notify(result.error ?? "workflow failed", "error");
```

It never throws — every expected failure returns the same `RunWorkflowResult`
envelope. Error-severity load issues refuse the run, and an unknown name returns a
failure envelope listing the available workflows. The fourth argument is
`RunWorkflowByNameOptions` = `Omit<RunWorkflowOptions, "workflow" | "input">`, so
`host`, `trigger`, `lifecycle`, `name`, and the caps thread through unchanged.

## Resuming a run

`resumeWorkflowByRunId` is the resume-side counterpart, keyed on the run-id — the
`<run-id>` slug `listRuns()` returns on `RunSummary.runId`. The run's JSONL header
already names its workflow, so you supply only the id:

```ts
import { resumeWorkflowByRunId, listRuns, readLastStage } from "@juicesharp/rpiv-workflow";

// listRuns returns filesystem order and carries no outcome — sort by `ts`, then
// ask the trail's last stage row whether the run actually finished.
const [latest] = listRuns(ctx.cwd).sort((a, b) => b.ts.localeCompare(a.ts));
const last = latest && readLastStage(ctx.cwd, latest.runId);
if (latest && last?.status !== "completed") {
  const result = await resumeWorkflowByRunId(ctx, latest.runId, { host: piHost });
  if (!result.success) ctx.ui.notify(result.error ?? "resume failed", "error");
}
```

`RunSummary` is a header projection — `runId`, `workflow`, `input`, `ts`, and the
optional `trigger` / `name`. Whether a run succeeded is a property of its stage
rows, so read it with `readLastStage`, or pass an explicit run-id you already hold.

The suffix is `ByRunId`, not `ByName`, on purpose: you resume one specific past
*run*, and a workflow has many. The third argument is
`ResumeWorkflowByRunIdOptions` = `Omit<ResumeWorkflowOptions, "workflow" | "header" | "ref">`.
The lower-level `resumeWorkflow` takes the resolved `workflow`, `header`, and the
user's `ref` explicitly.

Like `runWorkflowByName`, neither throws: an unresolvable run-id, error-severity
load issues, a workflow that is no longer registered, or an unreconstructable trail
each come back as a failure envelope.

Run trails carry a schema version (`STATE_SCHEMA_VERSION = 2`). Resuming a run
recorded under a different version is **refused** with a version mismatch — there
is no in-place migration.

> **Notify contract.** `resumeWorkflow` and `resumeWorkflowByRunId` are pure — they
> return envelopes and never notify, matching `runWorkflow` / `runWorkflowByName`.
> A no-JSONL refusal (bad run-id, load error, workflow gone) carries **no `runId`**;
> an in-run failure carries one and was already surfaced by the stage machinery's
> JSONL failure row. `/wf` uses exactly that `!result.runId` discriminator to notify
> the former once without double-notifying the latter.

## Cancellation

Pass an `AbortSignal` to cancel a long run:

```ts
const controller = new AbortController();
const p = runWorkflow(ctx, { workflow, input, host: piHost, signal: controller.signal });
// …later, from a timeout / webhook / user action:
controller.abort();
```

The signal is checked at the between-stage seam — before the start stage and
before every routed next stage — and is **also threaded into every `spawnChild`
call**, so an aborted run interrupts in-flight children rather than waiting for the
next stage boundary. The runner records an `"aborted"` terminal row for the stage
about to run and resolves with `{ success: false }`. It threads through
`runWorkflowByName` / `resumeWorkflowByRunId` unchanged.

When an execution-host provider supplies its own `signal`, the runner prefers the
caller's `options.signal` and falls back to the provider's.

## Cross-package lifecycle

When another extension needs to observe every workflow run in the process — an
overlay widget, a metrics emitter, a side-effect bridge — register a listener
bundle at extension load:

```ts
import { registerLifecycle } from "@juicesharp/rpiv-workflow/startup";
import type { WorkflowHost } from "@juicesharp/rpiv-workflow/registration";

export default function (host: WorkflowHost): void {
  const dispose = registerLifecycle({
    onWorkflowStart: (ctx)             => widget.open(ctx.runId, ctx.workflow, ctx.totalStages),
    onStageStart:    (stage, ctx)      => widget.markActive(ctx.runId, stage.name),
    onStageEnd:      (stage, _o, ctx)  => widget.markDone(ctx.runId, stage.name),
    onStageError:    (stage, err, ctx) => widget.markFailed(ctx.runId, stage.name, err),
    onWorkflowEnd:   (result, ctx)     => widget.close(ctx.runId, result.success),
  });
  // dispose() removes the bundle if the extension ever unloads.
}
```

The same bundle shape is accepted per-call as `RunWorkflowOptions.lifecycle`.

### Events

| Event | Fires |
| --- | --- |
| `onWorkflowStart(ctx)` | After the JSONL header lands, before the start stage's preflight |
| `onStageStart(stage, ctx)` | After preflight + skill check, before the session opens (or `run()` is called for script stages) |
| `onStageEnd(stage, output, ctx)` | After the stage's success row lands; `output` is the validated envelope |
| `onStageRetry(stage, attempt, ctx)` | After an `outputSchema` rejection, before the re-prompt; `attempt` is 1-based |
| `onStageError(stage, error, ctx)` | After a `"failed"` / `"aborted"` row lands. Terminal for the run |
| `onRoute(from, to, ctx, bypassed?)` | After an `EdgeFn` picks and its routing row lands. `to` may be the `"stop"` sentinel; `bypassed` lists not-taken recovery arms |
| `onLoopStart(stage, info, ctx)` | After `onStageStart`, before unit 1 (after the unit list is computed for fan-out) |
| `onUnitStart(stage, unit, ctx)` | Per unit, before the unit's session opens — produce **and** judge units |
| `onUnitEnd(stage, unit, output, ctx)` | Per unit, after the unit's row lands. Loop units never fire `onStageEnd` |
| `onUnitHalt(stage, unit, reason, ctx)` | Per unit, after a collect-all fan-out unit's non-terminal failed row lands — the unit halted, the run survives |
| `onLoopCap(stage, info, ctx)` | After an `onCap: "advance"` trip |
| `onWorkflowEnd(result, ctx)` | Last call; `result` is the same envelope `runWorkflow` returns |

Every callback receives a `LifecycleContext` with `cwd`, `runId`, `workflow`,
`totalStages`, the `trigger` metadata, a deep-readonly `RunView` snapshot, and — on
run-level events — `visited`, the distinct stage names already executed
(reconstructed from the trail on a resume, so a progress bridge can seed its
counter instead of restarting from zero).

Events fire **after** their JSONL row lands on disk, so a listener that calls
`readLastStage(cwd, ctx.runId)` is guaranteed to see the just-recorded row.
Callbacks may be async — the runner awaits them before advancing, which gives
back-pressure for free. Throws are caught and surfaced via
`ctx.ui.notify(..., "warning")`; they never halt the run.

Every fired event walks the global registry in registration order, then the
per-call bundle. Multiple bundles coexist and one throwing does not affect
siblings. The registry is anchored on
`Symbol.for("@juicesharp/rpiv-workflow:lifecycle")`, mirroring the built-in
registry, so cross-package module resolution shares one slot. Snapshot semantics:
each event observes the registry as it stands at that instant — a registration made
mid-event applies to subsequent events, not the in-flight one.

## Trigger metadata

`trigger` defaults to `{ kind: "programmatic" }`. Set it explicitly when spawning a
run from a cron job, webhook handler, or sibling extension — the value lands in the
JSONL header (`WorkflowHeader.trigger`), surfaces on `RunSummary.trigger` for
past-run readers, and is threaded into every `LifecycleContext`:

```ts
type RunTrigger =
  | { kind: "command";      name: string;    meta?: Record<string, unknown> }
  | { kind: "programmatic"; source?: string; meta?: Record<string, unknown> }
  | { kind: "external";     source: string; ref?: string; meta?: Record<string, unknown> };
```

`/wf` sets `{ kind: "command", name: "wf" }` itself — embedders set this field only
for non-`/wf` entry points. Pi is single-active-session: external trigger sources
must gate their own spawning if a run is already in flight; the runtime does not
enforce a process-wide mutex.

## Inspecting past runs

Row **writes** are runner-owned. Readers are public:

| Helper | Returns |
| --- | --- |
| `listRuns(cwd)` | `RunSummary[]` for every recorded run — `runId`, `workflow`, `input`, `ts`, `trigger?`, `name?`. Headers only: run outcome lives on stage rows, so there is no `success` field here |
| `resolveRun(cwd, ref)` | The `WorkflowHeader` for a run-id, run name, or `.jsonl` path |
| `readHeader(cwd, runId)` | The run's header row |
| `readLastStage(cwd, runId)` | The most recent stage row |
| `listArtifacts(cwd, runId)` | Every artifact the run recorded |
| `runFileFor(cwd, run)` | The absolute path of the run's JSONL file. `run` is anything carrying `runId` — a `RunSummary` or `WorkflowHeader` |
