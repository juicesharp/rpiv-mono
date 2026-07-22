# Workflow Authoring Reference

Complete reference for the `@juicesharp/rpiv-workflow` authoring DSL. A workflow is a typed graph: named entry point, a `stages` record, and an `edges` table that maps each stage to another stage name, `"stop"`, or a predicate function.

## Table of Contents

- [defineWorkflow](#defineworkflow)
- [Stage factories](#stage-factories)
  - [produces](#produces)
  - [Loops (fanout / iterate / assess)](#loops-fanout--iterate--assess)
  - [Per-stage verification (verify)](#per-stage-verification-verify)
  - [Adversarial verification (panel)](#adversarial-verification-panel)
  - [acts](#acts)
  - [terminal](#terminal)
  - [Script stages](#script-stages)
  - [Prompt stages (raw-text dispatch)](#prompt-stages-raw-text-dispatch)
- [Edge targets](#edge-targets)
- [Conditional routing](#conditional-routing)
  - [gate](#gate)
  - [match](#match)
  - [defineRoute](#defineroute)
  - [Predicate helpers](#predicate-helpers)
- [Outcomes](#outcomes)
  - [Collector catalog](#collector-catalog)
  - [Parser catalog](#parser-catalog)
  - [Custom outcomes](#custom-outcomes)
- [Analyzing skills before wiring](#analyzing-skills-before-wiring)
- [Multi-input stages](#multi-input-stages)
- [Carrying knowledge across stages](#carrying-knowledge-across-stages)
- [Validators](#validators)
- [Complete example](#complete-example)
- [Validation rules](#validation-rules)

## defineWorkflow

Identity passthrough for type inference. Same idiom as `defineConfig` in Vite/Astro — zero runtime cost.

```typescript
import { defineWorkflow } from "@juicesharp/rpiv-workflow";

export default defineWorkflow({
  name: "my-workflow",       // What users type: /wf my-workflow
  description: "...",        // Optional: shown in /wf preview
  start: "research",         // Entry stage name
  stages: { /* ... */ },     // Stage record (key = stage name)
  edges: { /* ... */ },      // Edge table (key = stage name)
});
```

### Typing model

Inter-stage data typing is **runtime-contract-based**. `outputSchema` / `inputSchema` (Standard Schema v1) validate `output.data` when stages run, and skill contracts adjudicate composition at load time.

The `StageDef<TIn, TOut>` type parameters are local inference helpers for a single factory call — they are erased at the `Workflow.stages` boundary (every stage collapses to `StageDef`), so they do **not** propagate types across edges. Don't lean on them for cross-stage safety; lean on schemas and contracts.

## Stage factories

Three factories for two stage kinds. Each factory returns a `StageDef` — pass overrides as needed.

### produces

`kind: "produces"`. The skill writes a file the next stage reads. Halts the chain if the path doesn't appear in the transcript. **Requires an `outcome`** — load-time validation rejects a `produces` stage without one.

```typescript
import { produces, typeboxSchema } from "@juicesharp/rpiv-workflow";
import { Type } from "typebox";

// Basic — just declare the outcome
produces({ outcome: myOutcome })

// With output schema (enables gate routing on output.data)
produces({
  outcome: myOutcome,
  outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Integer() })),
})

// With a loop (one Pi session per unit — see Loops below).
// `fanout()` / `iterate()` / `assess()` all build a `loop:` value.
produces({
  outcome: myOutcome,  // outcome MUST carry a `name` for a collecting loop
  loop: fanout({ units: myUnitsFn }),
})

// With validation retry
produces({
  outcome: myOutcome,
  outputSchema: typeboxSchema(Type.Object({ planPath: Type.String() })),
  onInvalid: "retry",    // default; "halt" to fail fast
  maxRetries: 3,
})
```

**Stage options:**

| Option | Default | Description |
|--------|---------|-------------|
| `skill` | record key | Pi skill to invoke. Override when stage id ≠ skill name. |
| `outcome` | (required) | `OutputSpec` — how the runtime collects + parses the artifact. |
| `outputSchema` | none | Standard Schema v1 validator for `output.data`. Enables gate routing. |
| `inputSchema` | none | Standard Schema v1 validator for inherited upstream `output.data`. Rejection halts immediately. |
| `reads` | none | `ReadonlyArray<StageRead>` (`string` \| `fanin(name)`) — names this stage consumes from `state.named`. Switches the prompt to the labelled-flag form. See [Multi-input stages](#multi-input-stages). |
| `onInvalid` | `"retry"` | `"retry"` (re-invoke up to `maxRetries`) or `"halt"` (fail fast). |
| `maxRetries` | — | Max retries on schema rejection. |
| `validateTimeoutMs` | — | Timeout for async schemas. |
| `loop` | none | `LoopDef` — opt-in unit loop authored via `fanout()` / `iterate()` / `assess()`. Expands the stage into one Pi session per unit through one driver. Mutually exclusive with `run`/`prompt` and `sessionPolicy: "continue"`. See [Loops](#loops-fanout--iterate--assess). |
| `sessionPolicy` | `"fresh"` | `"fresh"` (new session) or `"continue"` (reuse prior session). |

### Loops (fanout / iterate / assess)

A **loop** expands one stage into one Pi session per unit, all running the identical stage path with a distinct unit identity. You don't set the loop kind directly — you author a `loop:` value with one of three constructors. Each validates at construction (invalid shapes throw before the workflow ever loads) and fills the kind-specific defaults:

| Constructor | Generation | Stage kind | Use when |
|---|---|---|---|
| `fanout({ units })` | **push** — all units computed up front, blind to one another | any (`acts` for side-effects, `produces` to collect) | independent units (e.g. `implement` one pass per plan phase) |
| `iterate({ next })` | **pull** — one unit per call, fed the accumulated prefix | requires `produces` + named `outcome` | each unit must build on the last (e.g. `blueprint` per review phase) |
| `assess({ judge, done, feedForward })` | **producer → judge rounds** until the model says done | requires `produces` + named `outcome` | refine a single artifact until a model-judge approves it |

All three share the introspectable facet (`source`, `unit`) and the policy knobs (`max`, `onCap`, `result`) described under [the knobs](#the-loop-knobs) below.

#### fanout (push — all units up front)

`fanout()` computes the full unit list once, then runs each unit as its own session. On an **`acts`** stage the units are pure side-effects (one bare audit row each). On a **`produces`** stage each unit is *collecting* — it runs the full collect → validate → publish path and appends its `Output` to `state.named[outcome.name]`, so a collecting fanout **requires `outcome.name`**. An empty `units()` return falls through to the single-stage path (no loop).

```typescript
import { acts, fanout, type Unit } from "@juicesharp/rpiv-workflow";

// rpiv-pi's FRONTMATTER_PHASE_FANOUT — one implement session per plan phase.
const FRONTMATTER_PHASE_FANOUT = fanout({
  source: "plans",                                    // the named channel units split FROM
  unit: { by: "frontmatter-array", pattern: "phases" }, // opaque introspection hint
  max: MAX_PHASES,
  units: ({ state, cwd }) => {
    const plan = latestFsArtifact(state, "plans");
    if (plan?.handle.kind !== "fs") return [];        // empty ⇒ single-stage fall-through
    const promptPath = handleToString(plan.handle);
    return planPhaseRecords(readArtifactFile(plan.handle.path, cwd)).map((r) => ({
      prompt: `${promptPath} Phase ${r.n}: ${r.title}`.trimEnd(),
      label: `phase ${r.index + 1}/${r.total}`,       // human display tag
    }));
  },
});

// acts stage + fanout loop — side-effect units (no per-unit collector)
acts({ loop: FRONTMATTER_PHASE_FANOUT, reads: ["plans"] })
```

A **`Unit`** is `{ prompt, label, id?, deps? }`: `prompt` is the body sent to the skill, `label` is the human display tag woven into the status line / per-unit toast / decorated audit row, and `id` is the stable audit identity (falls back to `label`). Set `id` when `label` may be reworded — the resume drift guard and post-hoc tooling join on `id ?? label`.

**`deps` (fanout only)** lists the `id ?? label` identities this unit depends on. The wave scheduler assigns Kahn levels over those directed edges and dispatches level by level: a unit starts only once every unit it names has completed. Absent or empty ⇒ a root (wave 0). A dep matching no unit's `id ?? label`, or any cycle, halts the stage at the live entry. The sequential kinds ignore `deps` — `iterate`/`assess` consume the prior unit, so ordering is already implicit.

**`FanoutContext` (what `units()` receives):** `{ cwd, artifact, state }` — `artifact` is the primary inherited from upstream (undefined when the loop stage is the entry point); `state` is the read-only `RunState`. A thrown error halts the stage attributed to it.

#### iterate (pull — accumulating)

`iterate()` pulls one unit at a time: the runner calls your `IterateFn` per unit, feeding it the validated `Output`s of every prior unit in this generation. Return the next unit, or `null`/`undefined` to terminate. Every unit runs the stage's `outcome` collector exactly like a one-shot `produces` pass — so it **requires `kind: "produces"` + an `outcome` with a `name`**, and a downstream stage can read every accumulated output straight from `state.named[outcome.name]`.

```typescript
import { iterate, produces } from "@juicesharp/rpiv-workflow";

// rpiv-pi's REVIEW_PHASE_ITERATE — one blueprint pass per review phase,
// each building on the plans the phases it depends on already produced.
const REVIEW_PHASE_ITERATE = iterate({
  source: "architecture-reviews",
  unit: { by: "frontmatter-array", pattern: "phases" },
  max: MAX_PHASES,
  next: ({ artifact, state, accumulated, cwd }) => {
    const review = latestFsArtifact(state, "architecture-reviews") ?? artifact;
    if (review?.handle.kind !== "fs") return null;
    const phases = readPhases(review.handle.path, cwd);
    const i = accumulated.length;                     // 0-based cursor (== index)
    if (i >= phases.length) return null;              // every phase planned ⇒ terminate
    const prior = accumulated.flatMap((o) => o.artifacts).map((a) => handleToString(a.handle));
    return {
      prompt: `${handleToString(review.handle)} Implement Phase ${phases[i].n}: ${phases[i].title}` +
              (prior.length ? `\nPrior phase plans (build on them): ${prior.join(", ")}` : ""),
      label: `phase ${i + 1}/${phases.length}`,
      id: `phase-${phases[i].n}`,                      // stable audit key
    };
  },
});

produces({ loop: REVIEW_PHASE_ITERATE })
```

**`IterateContext` (what each `next()` call receives):**

| Field | Meaning |
|-------|---------|
| `cwd` | Run working directory. |
| `artifact` | Stage-entry primary, **FROZEN** across every unit (does NOT roll to the prior unit's output). Undefined when iterate is the entry stage. On a corrective back-edge re-entry the rolling primary may be a downstream doc — source your true input from `state.named` in that case. |
| `state` | Read-only `RunState`. `state.named[outcome.name]` is the global accumulation channel. |
| `accumulated` | This generation's already-completed units' validated `Output`s, in order. |
| `index` | 0-based index of the unit about to run (`== accumulated.length`). |

A first-call `null` is a zero-unit no-op: nothing published, primary unchanged, chain advances (with a warning).

#### assess (producer → judge rounds, until done)

`assess()` runs the stage as a **model-judged until-done loop**: each round runs a producer session (this stage's skill + outcome) then a judge session (`opts.judge`). A sync `done(verdict)` predicate decides termination; `feedForward` carries the just-judged round into the next producer prompt. The producer is a collecting unit every round, so assess also **requires `kind: "produces"` + an `outcome` with a `name`**. Unlike fanout/iterate, the cap **soft-stops by default** (`onCap: "advance"`).

```typescript
import { assess, judge, produces } from "@juicesharp/rpiv-workflow";

const BREAKDOWN_ASSESS = assess({
  judge: judge({ skill: "grade-breakdown", outcome: verdictOutcome }),
  done: (v) => (v.data as { done?: boolean }).done === true,
  feedForward: ({ output, verdict }) =>
    `Revise ${handleToString(output.artifacts[0]!.handle)} per the grader's feedback: ` +
    `${(verdict.data as { feedback?: string }).feedback ?? ""}`,
  max: 5,                                             // round cap; defaults to 8 if omitted
});

produces({ loop: BREAKDOWN_ASSESS, outcome: rpivArtifactMdOutcome })
```

**`FeedForwardContext` (what `feedForward()` receives):** `{ cwd, output, verdict, round, state }` — `output` is the producer output just judged, `verdict` is the judge's validated `Output` (carrying its feedback), `round` is the 0-based round index just judged.

##### judge() — the model-judge concept

A `Judge` names a dispatchable grading session. Author it with `judge({ ... })`, which validates the shape at construction:

- **Dispatch is `skill` XOR `prompt`** (exactly one): `skill` dispatches `/skill:<skill> <producerHandle>` with the latest producer artifact auto-injected as the input handle; `prompt` sends raw text (the author embeds the handle/output themselves). Setting both is ambiguous; setting neither has nothing to dispatch — both throw.
- **`outcome` is required** — it validates the verdict and names its own dedicated `state.named` channel. That channel's `.name` MUST differ from the producer outcome's name (a workflow-level check, since it needs the producer's identity).
- **≥1-artifact constraint**: the judge's collector MUST materialize at least one artifact (e.g. a JSON verdict file whose parser yields `{ done, feedback }`). A judge session that collects zero artifacts is a **fatal halt** — no retry, no soft-stop.
- **Skill label for per-unit consumers**: a `skill` judge's units carry that skill name in `onUnitStart`/`onUnitEnd` and the JSONL rows; a `prompt` judge dispatches under a synthetic label — **`<stageName>-judge`** on an `assess` site, **`<stageName>-verify`** on a `verify` site. Per-unit listeners that key on the dispatched skill (e.g. rpiv-pi's `models.json` `skills.<name>` model-override rung) can target a prompt-judge by adding an entry under that synthetic name; with no entry, judge units run on the baseline model.

Keeping the termination predicate OFF `Judge` is what makes it reusable: both `assess()` and the per-stage `verify` field add their own `done(verdict)` predicate over the same opaque verdict `Output` (they share the `JudgedRepetition` vocabulary — `done` + `max`); [`panel()`](#adversarial-verification-panel) composes N judges into one verdict the same `done` reads. A panel therefore slots into any of them with zero per-site code.

#### The loop knobs

Every constructor accepts the shared introspectable facet and policy knobs:

| Knob | Default | Meaning |
|---|---|---|
| `source` | none | The named channel the units are split FROM (a `consumes` hint for lints and agents — the `checkFanoutSource` lint warns if no `produces` stage publishes it). |
| `unit` | none | `{ by, pattern? }` — how units are detected. Opaque convention; the framework never interprets it. |
| `max` | none (assess: 8) | Cardinality ceiling. Must be an integer **≥ 1** (throws at construction). Always clamped by the run-wide `maxIterations` (default 32, via `RunWorkflowOptions.maxIterations`). |
| `onCap` | fanout/iterate `"halt"` · assess `"advance"` | What happens at the effective cap (`min(max, run.maxIterations)`). `"halt"` — terminal failure (mirrors the backward-jump guard). `"advance"` — soft-stop: warn, land a `{type:"loop-cap"}` telemetry row, fire `onLoopCap`, keep the projected result, advance downstream. |
| `result` | fanout `"entry"` · iterate/assess `"last"` | What the loop leaves in `{state.output, state.primaryArtifact}` (the pair is governed as one). `"entry"` restores the pair captured at loop entry (reproduces routing-sees-upstream); `"last"` uses the last completed produce unit's pair (zero produce units degrades to entry). |

`fanout()` adds three knobs the sequential kinds have no use for:

| Knob (fanout only) | Default | Meaning |
|---|---|---|
| `concurrency` | host cap | Per-fanout in-flight ceiling, applied as `min(concurrency, host maxConcurrency)`. `1` **serializes** the loop — the safe model for units mutating shared state (e.g. applying a plan to one working tree). Integer ≥ 1, validated at construction and load. |
| `failFast` | absent (collect-all) | Opt out of collect-all: the first failing unit halts the run terminally and cancels in-flight siblings. Cancelled siblings leave unfilled slots, so a later resume re-dispatches them. |
| `depArtifactFlag` | none | Injects each completed dependency's artifact path into the dependent unit's prompt as `<flag> <path>`, one per direct `deps` entry whose slot holds a non-failed output. Pairs with `Unit.deps` — `deps` orders the waves, this hands the dependent something to read. Failed dep slots are skipped. |

#### The resume contract (all loop kinds)

A unit source must be **deterministic w.r.t. the fold-replayed `RunState` at the unit boundary plus this generation's accumulated outputs**. On resume, the fold re-calls your `units()` / `next()` at every folded boundary and compares each recomputed unit against what the run recorded. If they diverge — a non-deterministic generator recomputed a different unit — resume **refuses** with a terminal failure rather than re-run the wrong units. Set a stable `id` on each unit so the join survives a reworded `label`. The same contract covers the model-judged predicates: `assess`'s and `verify`'s `done` / `feedForward` are recomputed on resume (never persisted), so each must be deterministic w.r.t. the verdict `Output`. Runs recorded before this redesign carry no `parent` field on their unit rows and cannot be resumed (`stage-gone` refusal — no migration).

#### Loop lifecycle hooks

Loops are observed through unit-generic lifecycle hooks (register via `registerLifecycle`). `onStageStart` still fires exactly once per loop stage; the loop hooks add per-loop and per-unit granularity:

| Hook | Payload | When |
|---|---|---|
| `onLoopStart(stage, info)` | `{ kind, units? }` — `units` only for fanout (push precomputes them) | after `onStageStart`, before unit 1's session |
| `onUnitStart(stage, unit)` | `UnitEvent` `{ role, index, unitId?, label, skill }` | before each unit's session opens — fired for **produce AND judge** units; the seam a model-override listener resolves the model on. `iterate`/`assess`/`verify` units run strictly sequentially; **fanout units run in bounded parallel**, so a fanout listener must resolve per-unit from the `UnitEvent` payload rather than flipping global state |
| `onUnitEnd(stage, unit, output)` | `UnitEvent` + the unit's validated `Output` | after the unit's JSONL row lands (loop units never fire `onStageEnd`) |
| `onLoopCap(stage, info)` | `LoopCapInfo` `{ kind, count, max, policy }` | after an `onCap: "advance"` trip (after the `{type:"loop-cap"}` row append attempt) |

`UnitEvent.skill` is the unit's *dispatched* skill body — the parent stage's skill for produce units, the judge's own skill for judge units — so a model-override listener can resolve a per-unit model through the existing `models.json` cascade (`skills.<name>`) with no new configuration axes.

### Per-stage verification (verify)

**verify** attaches a post-condition judge to a `produces` stage: after each attempt completes (collected, validated, persisted), the judge session grades the attempt's primary artifact and `done(verdict)` gates advancement — true → the chain advances with the attempt's producer pair; false → a fresh retry attempt (prompt arg built by `feedForward`) up to `max` attempts (default 1 = gate-only), then the workflow halts with "verification failed". A pass on the final attempt is a normal completion. Requires `kind: "produces"` + an `outcome` with a `name`; composes with `reads` and with `prompt` dispatch (attempt 0 sends the stage's resolved `prompt` raw; retries send `feedForward`'s output raw — for prompt dispatch it is the complete retry message, not a skill arg); mutually exclusive with `loop`, `run`, and `sessionPolicy: "continue"`. `verify` shares the `JudgedRepetition` field vocabulary with `assess` — `done` (the pass predicate), `max` (the attempt budget), and `feedForward` — one set of names for both judged-repetition shapes.

```ts
import { judge, produces, verify } from "@juicesharp/rpiv-workflow";

// Gate-only: one attempt; a failing verdict halts the workflow.
const GATED = produces({
  outcome: implOutcome, // publishes "impl"
  verify: verify({
    judge: judge({ skill: "review-gate", outcome: verdictOutcome }), // publishes "impl-verdict"
    done: (v) => (v.data as { ok?: boolean }).ok === true,
  }),
});

// Retry-with-feedback: up to 3 fresh attempts, each retried prompt carrying the verdict's feedback.
const RETRIED = produces({
  outcome: implOutcome,
  reads: ["design", "plan"], // composes — attempt prompts use the labelled-flag projection
  verify: verify({
    judge: judge({ skill: "review-gate", outcome: verdictOutcome }),
    done: (v) => (v.data as { ok?: boolean }).ok === true,
    feedForward: ({ verdict }) => `address: ${(verdict.data as { feedback?: string }).feedback}`,
    max: 3, // requires feedForward when > 1
  }),
});
```

**Two budgets, two cost scales:** `verify.max` is the FULL-attempt budget — each attempt is a fresh session running the whole produce→validate→persist cycle. `stage.maxRetries` stays the orthogonal in-session schema-fix budget and remains live inside every attempt.

**Lifecycle (loop semantics):** a verified stage runs through the loop driver, so `onLoopStart` fires with `kind: "verify"`, each attempt/verdict fires `onUnitStart`/`onUnitEnd` (roles `"produce"`/`"verify"`), and the stage does NOT fire `onStageEnd` — observe units, not stage-end. A model-override listener resolves the judge's own skill through `onUnitStart`, exactly as for assess judges.

**Fallback routing instead of halting:** the verdict publishes durably to `state.named[judge.outcome.name]`, so a route can read it — no built-in fail→route policy exists (or is needed):

```ts
edges: {
  implement: defineRoute(
    ["ship", "fallback"],
    ({ state }) => ((state.named["impl-verdict"]?.at(-1)?.data as { ok?: boolean })?.ok ? "ship" : "fallback"),
    { readsData: false },
  ),
}
```

**Resume:** crash after an attempt but before its verdict → resume re-runs just the verify; a recovered failing verdict re-computes `done` and continues the retry (or halts a gate-only verify); a recovered passing verdict fast-advances. `done` is recomputed, never persisted — it joins the loop determinism contract (deterministic w.r.t. the verdict `Output`).

### Adversarial verification (panel)

A single judge agreeing with itself is not a check — that is self-preference bias. **`panel()`** turns one judge into N independent skeptics and reduces their verdicts to one decision with a **fold**. It is a `Judge`-shaped *value*, not a new site: it slots into any slot a `judge` does — `assess({ judge })` or `verify({ judge })` — with **zero per-site code**, because every judge site dispatches through one expander (`panelMembers`) and reads the fold opaquely via its existing `done` predicate. A plain `judge` is simply a panel of one.

```ts
import { judge, majority, panel, produces, verify } from "@juicesharp/rpiv-workflow";
import type { PanelVerdict } from "@juicesharp/rpiv-workflow";

// Three independent skeptics — distinct lenses beat N copies (correctness, security, repro).
const REVIEW_PANEL = panel({
  members: [
    judge({ skill: "review-correctness", outcome: { name: "v-correctness", collector } }),
    judge({ skill: "review-security",    outcome: { name: "v-security",    collector } }),
    judge({ skill: "review-repro",       outcome: { name: "v-repro",       collector } }),
  ],
  // The per-member `pred` interprets each member's OWN verdict schema.
  fold: majority((v) => (v.data as { ok?: boolean }).ok === true),
});

// Slots into a verify site. The site's `done` reads the FOLDED canonical verdict.
const VERIFIED = produces({
  outcome: implOutcome,                               // publishes "impl"
  verify: verify({
    judge: REVIEW_PANEL,                              // fold publishes to "impl-panel"
    done: (v) => (v.data as PanelVerdict).pass,       // the strict-majority result
  }),
});
```

**Two predicates, not one redundancy.** The per-member `pred` (passed to `majority`/`all`/`any`) interprets *one member's* own verdict; the site's `done` (`assess`'s and `verify`'s termination predicate) interprets *the fold*. Members never need a shared verdict schema — only the `pred` knows each member's shape.

**`panel({ members, fold, outcome? })`:**

- `members` — a **non-empty** array of single `judge(...)` values. Each carries its own `outcome` whose `name` must be **mutually distinct** and **distinct from the producer's** (a load-time check). Members do **not** nest — `panel` of `panel` is rejected at construction (§ "Explicitly not building").
- `fold` — a function reducing the member verdicts to the panel's decision data. Either a **sugar** fold (`majority`/`all`/`any`, branded) or a **raw** `FoldFn`.
- `outcome` — present **only** on the custom (raw-fold) path; it names + validates the fold's channel.

#### Canonical ⊕ custom — a hard XOR

The fold output is a validated, publishable `Output` so a downstream route can branch on it. Two disjoint ways to obtain the `(schema, channel, fold)` triple:

| Path | `fold` | `outcome` | Schema / channel | Use |
|---|---|---|---|---|
| **Canonical** | sugar (`majority`/`all`/`any`) | **omitted** | built-in `PANEL_VERDICT`; channel `<stage>-panel` | zero-config disagreement routing |
| **Custom** | raw `FoldFn` | **required** | author's schema + name | mean / weighted / synthesize |

The XOR is enforced at construction (and re-checked at load for hand-rolled literals), so exactly one source names the verdict — never both, never neither:

```
sugar fold  +  outcome present  → construction error  (sugar ⊕ outcome)
raw fold     +  outcome absent   → construction error  (raw ⊕ outcome)
```

#### The canonical verdict — `PANEL_VERDICT`

Sugar folds emit this shape; disagreement is first-class because production routing keys on it:

```ts
PANEL_VERDICT = {
  pass: boolean,                          // the fold's decision (per the sugar rule below)
  votes: { pass: number, fail: number },  // the split
  agreement: number,                      // |majority| / N — the disagreement signal
  tie: boolean,                           // an even split
}
```

| Sugar fold | `pass` is true when | Meaning |
|---|---|---|
| `majority(pred)` | strict majority of members pass `pred` | even split is a tie ⇒ fail (see `tie`/`agreement`) |
| `all(pred)` | every member passes `pred` | unanimous — one fail vetoes |
| `any(pred)` | at least one member passes `pred` | veto / rescue — one pass carries it |

#### Where the fold publishes

The fold publishes **decision data**, not a file artifact. It lands on its own named channel — `<stage>-panel` (canonical) or your `outcome.name` (custom) — with `artifacts: []`, so it never claims the rolling primary. Each member *also* publishes its own verdict to its own `outcome.name` channel, so the full per-member trail is preserved. A downstream stage that wants to **read survivors** reads the producer/member artifacts; a route that wants the **decision** reads the fold channel (see [`match`](#match)'s `from`).

#### The four flows

- **Generate-and-filter** — `fanout` to generate candidates → a stage whose `verify` judge is a `panel(...)` → `match` on the published verdict to keep survivors.
- **Classify-and-route** — panel verdict → `match("decision", …)`.
- **Escalate-on-disagreement** (highest value) — route on `tie`/`agreement` to a human/escalation stage; falls out for free once the channel + disagreement signal exist.
- **Tournament** — unchanged; a future `iterate` over a bracket.

#### Caveats & resume

- **Sequential cost.** Pi is single-active-session, so members run one after another — a panel costs **N judge sessions per check**. Panels are slower, never incorrect. Parallelism is a roadmap item, not a property of the fold.
- **Resume parity.** Each member is its own durable audit row (member-index-bearing tag); the **folded verdict is never persisted** — it is recomputed from the member rows and republished at the same transition on resume, byte-identical to live. The fold must therefore be deterministic w.r.t. the member verdicts (it joins the loop determinism contract). A crash mid-panel re-runs only the pending member, then recomputes the fold.

### acts

`kind: "side-effect"`. The skill's side effect IS the work (commit, implement). The next stage inherits the prior artifact list forward.

```typescript
import { acts } from "@juicesharp/rpiv-workflow";

// Basic side-effect
acts()

// With a different skill name
acts({ skill: "implement" })

// With a loop (one side-effect session per unit — see Loops)
acts({ loop: fanout({ units: phaseUnits }) })

// With outcome (e.g., git commit detection)
acts({ outcome: gitCommitOutcome })
```

**Stage options:** Same as `produces` except `outcome` is optional and `kind` is `"side-effect"`.

### terminal

`kind: "side-effect"` with `inheritsArtifacts: false`. A side-effect stage that does NOT inherit the upstream artifact. Its prompt receives `originalInput` (the run's brief) instead of an upstream artifact handle. The rolling primary slot is cleared on success so anything downstream also starts without an inherited handle.

```typescript
import { terminal } from "@juicesharp/rpiv-workflow";

// Final notification stage
terminal()
```

The right answer for a final cleanup / summary / post-run notification stage that shouldn't be coupled to the upstream chain.

### Script stages

Some stages don't need an LLM. The `.script` accessor on each factory runs a pure TS function in place of a Pi skill body. No `/skill:<name>` dispatch, no session.

**`produces.script`** — returns the `Output` envelope's value-channel fields directly:

```typescript
import { produces, fs, type ScriptContext } from "@juicesharp/rpiv-workflow";

const merge = produces.script({
  outputSchema: typeboxSchema(Type.Object({ planPath: Type.String() })),
  run: async (ctx: ScriptContext) => {
    const upstream = ctx.input?.artifacts ?? [];
    const bodies = await Promise.all(
      upstream
        .filter((a) => a.handle.kind === "fs")
        .map((a) => readFile(join(ctx.cwd, (a.handle as { path: string }).path), "utf-8")),
    );
    const planPath = `plans/${Date.now()}.md`;
    await writeFile(join(ctx.cwd, planPath), bodies.join("\n\n---\n\n"));
    return {
      kind: "plan",
      artifacts: [{ handle: fs(planPath), role: "primary" }],
      data: { planPath },
    };
  },
});
```

**`acts.script`** — returns `void`:

```typescript
import { acts, type ScriptContext } from "@juicesharp/rpiv-workflow";

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

**`terminal.script`** — like `acts.script` but clears the rolling primary slot:

```typescript
import { terminal, type ScriptContext } from "@juicesharp/rpiv-workflow";

const notifySlack = terminal.script({
  run: async (ctx: ScriptContext) => {
    await fetch(process.env.SLACK_WEBHOOK!, {
      method: "POST",
      body: JSON.stringify({ text: `Run ${ctx.state.originalInput} complete.` }),
    });
  },
});
```

**Constraints on script stages:**
- Cannot declare `skill`, `outcome`, `loop`, `prompt`, or `sessionPolicy: "continue"` — load-time validation rejects the combination. Script stages cannot loop — write a loop inside `run()` instead.
- `produces.script` may declare `outputSchema`, `maxRetries`, `onInvalid`.
- `acts.script` / `terminal.script` may declare `inputSchema`.

**Lifecycle parity.** Script stages fire the same lifecycle events as skill stages — `onStageStart` → (`onStageRetry`?) → `onStageEnd` | `onStageError` — with a `StageRef` discriminator of `kind: "script"` (vs `kind: "skill"`). The JSONL audit row carries the stage's record key in `stage` and omits the `skill` field entirely, so post-hoc readers distinguish the two paths by `row.skill === undefined`. A thrown `run()` body records a terminal failure attributed to the stage (`FAIL_SCRIPT_THREW`); the run halts and `onStageError` fires.

The runner stamps `meta` (`stage`, `stageNumber`, `ts`, `runId`) on a `produces.script` envelope — authors fill only `kind` + `artifacts` + `data`. For `acts.script` it synthesises `{ kind: "side-effect", artifacts: [], data: {} }` for the audit row and preserves the rolling primary artifact, so a downstream stage still inherits whatever the upstream `produces` stage set.

### Prompt stages (raw-text dispatch)

A stage has three **dispatch** options — orthogonal to its `kind`:

| Dispatch | What runs | Set via |
|----------|-----------|---------|
| **skill** (default) | `/skill:<name> <args>` — the full skill body | nothing (or `skill:`) |
| **script** | a pure TS function, no model call | `run:` |
| **prompt** | raw text sent straight to the model — a "chat turn" | `prompt:` |

A `prompt` stage sends author-owned text as the user message — no `/skill:`
prefix, no implicit upstream-artifact arg appended. Use it for a focused,
one-off instruction that doesn't warrant a whole skill.

**Prefer the typed builders** `produces.prompt({ … })` / `acts.prompt({ … })`
(mirroring `.script`). Their options structurally omit `skill`/`run`/`loop`/
`reads`, so an invalid combo fails to compile instead of only failing
load validation:

```typescript
// side-effect chat turn (no artifact collected)
acts.prompt({ prompt: "Implement the design spec discussed above.", sessionPolicy: "continue" })

// produces chat turn — its reply runs the outcome collector like any produces stage
produces.prompt({ prompt: "Write a one-paragraph summary to .rpiv/artifacts/summary/s.md", outcome: myOutcome })

// dynamic — weave in the upstream Output (same ScriptContext script stages get)
produces.prompt({
  prompt: ({ input }) => `Refine ${handleToString(input!.artifacts[0]!.handle)} for clarity.`,
  outcome: myOutcome,
})

// acts.prompt({ prompt, skill: "x" }) — does NOT compile; the builder omits `skill`.
```

The bare-field form (`acts({ prompt })` / `produces({ prompt })`) still works —
it's what the runner reads and what programmatic embedders construct — but the
builders are the recommended authoring surface.

**The killer use — the continue follow-up turn.** With `sessionPolicy: "continue"`,
a prompt stage sends a follow-up into a session a prior stage already populated,
*without re-invoking a skill*. This is the only way to build on a stage whose
output is conversation-only (e.g. a `frontend-design` pass that emits no
artifact): the downstream `implement` step leans on the shared context.

```typescript
stages: {
  discover:  produces({ outcome: rpivBucketOutcome("research") }),          // fresh, writes a spec
  design:    acts({ skill: "frontend-design", sessionPolicy: "continue" }), // same session, no artifact
  implement: acts.prompt({ prompt: "Implement the design spec.", sessionPolicy: "continue" }),
}
```

**Constraints (load + preflight):**
- Mutually exclusive with an explicit `skill`, with `run`, with `reads`, and
  with `fanout`/`iterate` loops (units own their prompts — every unit's message
  comes from `units()`/`next()`, so a stage-level `prompt` would have no role).
  Read `state.named` from the `PromptFn` itself instead of `reads`.
- Composes with `assess` loops and with `verify`: the stage's `prompt` is
  round/attempt 0's message, and `feedForward` builds each retry's COMPLETE
  message (sent raw — there is no skill to prefix an arg onto).
- `produces` + `prompt` still requires an `outcome`. `side-effect` + `prompt` is
  a pure chat turn.
- A prompt stage skips the skill-registry check (no skill to register) and the
  upstream-artifact check (it owns its whole message).
- A `continue` prompt stage as the workflow **start** warns — there is no prior
  session to continue.

> **When NOT to use it.** Prompt text in a workflow definition isn't versioned,
> localized, or independently testable the way a `SKILL.md` is. Keep prompt
> stages short and glue-like; anything reusable belongs in a skill.

## Edge targets

Each edge maps a stage name to one of:

```typescript
// 1. Another stage name
edges: { research: "implement" }

// 2. The terminal sentinel
edges: { commit: "stop" }

// 3. A predicate function (via gate or defineRoute)
edges: { "code-review": gate("blockers_count", { revise: gt(0), commit: eq(0) }, "commit") }
```

**`STOP`** (or `"stop"`) is the terminal edge sentinel. Every workflow path should eventually reach `"stop"`.

## Conditional routing

A conditional edge is an **`EdgeFn`**: a `(ctx) => string` predicate carrying a `.targets` array of every stage it can return. `.targets` is required — the validator and reachability BFS enumerate it — so you wrap a TS predicate rather than dropping a bare arrow into `edges`. Two wrappers:

- **`defineRoute(targets, fn)`** — general. Arbitrary TS body, explicit `targets`. Use for strings, enums, multiple fields, ranges — anything.
- **`gate(field, branches, otherwise)`** — terse convenience for one **numeric** field with threshold predicates; derives `.targets` from the branch keys plus `otherwise`. Not more powerful than `defineRoute`, just shorter for the numeric case.
- **`match(field, branches, opts?)`** — the string/boolean companion to `gate`: classify on a discrete (enum) field by strict `===`. Derives `.targets` from the branch keys; shorter than `defineRoute` for the enum case.

### gate (numeric field)

Branches evaluated against `Number(output.data[field])` in declaration order; first match wins. The third argument, `otherwise`, is **required** — the no-match fallback must be deliberate, and omitting it throws at construction. Helpers (`gt`/`gte`/`lt`/`lte`/`eq`) take a `number` — non-numeric fields route with `defineRoute` instead.

```typescript
import { gate, gt, eq } from "@juicesharp/rpiv-workflow";

edges: {
  "code-review": gate("blockers_count", {
    revise: gt(0),   // > 0 → "revise"
    commit: eq(0),   // = 0 → "commit"
  }, "commit")       // missing/NaN/< 0 → "commit", with a routing-audit note
}
```

**No-match is explicit, never silent.** A value no branch matches routes to `otherwise` and lands a `note` on the routing-audit row naming the field, the value, and the fallback taken. Branch keys must not be integer-like (`"2"`) — JS object literals hoist array-index keys ahead of declaration order, which would silently reorder match priority, so those are rejected at construction.

### match (enum field)

`match(field, branches, opts?)` maps each target stage to the **discrete value** that routes to it. The field is compared by strict `===` in declaration order; first match wins. Where `gate` keys on a `Number(...)` threshold, `match` keys on a string/number/boolean equal — the enum classifier `gate` can't express.

```typescript
import { match } from "@juicesharp/rpiv-workflow";

edges: {
  triage: match("severity", { escalate: "p0", fix: "p1", backlog: "p2" }),
}
```

**No-match is explicit, never silent.** With `opts.fallback` the unmatched value routes there; without one it terminates (`STOP`). Either way the no-match lands a routing-audit `note`.

**Routing on a panel's verdict** — `opts.from` reads the field from a named channel's latest output (`state.named[from].at(-1).data[field]`) instead of the stage's projected `output.data`. This is how `match` branches on a [panel](#adversarial-verification-panel)'s published fold (the fold lands on a channel, never on the stage's projected output):

```typescript
// Escalate when the panel split, otherwise keep survivors.
edges: {
  review: match("tie", { escalate: true }, { fallback: "keep", from: "review-panel" }),
}
```

A channel-sourced route validates the *channel's* data, not the source stage's output, so it does **not** mark the source stage `READS_DATA`.

**Construction rules:** each enum value must map to exactly one stage (a duplicate value throws — ambiguous), and branch keys must not be integer-like (`"2"`) — JS hoists array-index keys ahead of declaration order, silently reordering priority. Built on `defineRoute`, so `.targets` (incl. the fallback) feeds the reachability BFS and `READS_DATA` auto-applies unless `from` sources a channel.

### defineRoute (strings, enums, multi-field)

The body is plain TS, so there is no separate string/enum helper — compare the field directly. Every value the body can return must appear in `targets`, or the validator flags the edge. Auto-marks the route as reading `output.data` (the source stage needs an `outputSchema`); pass `{ readsData: false }` for a state-only route.

```typescript
import { defineRoute } from "@juicesharp/rpiv-workflow";

edges: {
  review: defineRoute(["commit", "revise", "escalate"], ({ output }) => {
    const verdict = (output?.data as { verdict?: string })?.verdict;
    if (verdict === "approve") return "commit";
    if (verdict === "reject") return "escalate";
    return "revise";
  }),
}
```

### Predicate helpers (numeric — for `gate`)

| Helper | Returns true when | | Helper | Returns true when |
|--------|---|---|--------|---|
| `gt(n)` | value > n | | `lte(n)` | value <= n |
| `gte(n)` | value >= n | | `eq(n)` | value === n |
| `lt(n)` | value < n | | | |

## Outcomes

Each `produces` stage wires an `OutputSpec` with an optional `name` (the publish key in `state.named` — see [Multi-input stages](#multi-input-stages)), a collector (enumerate what the stage produced) and optional parser (interpret into typed data):

```typescript
interface OutputSpec<Snapshot, Kind, Data> {
  name?:     string;                                // CATEGORISE — publish slot in state.named
  collector: ArtifactCollector<Snapshot>;          // ENUMERATE
  parser?:   ArtifactParser<Snapshot, Kind, Data>; // INTERPRET (optional)
}
```

There is no framework default — load-time validation rejects a `produces` stage without an outcome.

### Collector catalog

Grouped by discovery model:

**Scan the agent's text:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `transcriptPathCollector` | `({ pattern: RegExp })` | Scans assistant text for the last regex match; emits one `fs` artifact. |
| `directoryPathCollector` | `({ dir, ext? })` | Wrapper over `transcriptPathCollector` for `<dir>/<file>.<ext>`. |
| `urlCollector` | `({ pattern? })` | Scans for `https?://…`; emits a `url` handle. |

**Observe tool use:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `toolCallCollector` | `({ match, toArtifact })` | Walks every `tool_use` part; emits N artifacts via author's mappers. |

**Diff the filesystem:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `workspaceDiffCollector` | `({ filter? })` | `git status --porcelain` pre-stage, diffs post-stage. One `fs` artifact per touched file. |

**Git:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `gitCommitCollector` | — | Detects new HEAD commit vs. pre-stage snapshot; emits `opaque(sha)`. |

**Composition + empty:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `unionCollectors(...cs)` | — | Run N collectors, concatenate artifacts. Fatal only when every sub-collector fataled. |
| `noopCollector` | — | Always returns `{ kind: "ok", artifacts: [] }`. |

### Parser catalog

| Parser | Output `kind` | Output `data` |
|--------|---------------|---------------|
| `jsonBodyParser` | `"json"` | `JSON.parse` of the primary `fs` artifact's body. |
| `gitCommitParser` | `"git-commit"` | `GitCommitData` (sha, prevSha, subject, filesChanged). |

### Custom outcomes

Use `defineCollector` and `defineParser` to build your own:

```typescript
import { defineCollector, opaque } from "@juicesharp/rpiv-workflow";

export const myCollector = defineCollector((ctx) => {
  // ctx.branch, ctx.cwd, etc.
  const id = parseIdFromBranch(ctx.branch);
  if (!id) return { kind: "fatal", message: "stage did not emit an id" };
  return { kind: "ok", artifacts: [{ handle: opaque(id), role: "primary" }] };
});
```

Handle constructors: `fs(path)`, `url(href)`, `opaque(id)`, `inline(bytes, mime?)`.

Composite outcomes: `sideEffectOutcome` (built from `noopCollector`), `gitCommitOutcome` (built from `gitCommitCollector` + `gitCommitParser`).

## Analyzing skills before wiring

Before writing any workflow DSL, analyze each skill you plan to chain. The runner only sees what collectors enumerate — everything else (transcript reasoning, session state) is lost across `fresh` session boundaries. Bad collector/parser/session choices are silent: the workflow runs but downstream stages receive nothing useful.

### The four questions per skill

Answer these before writing DSL for any stage:

**Q1 — Input contract.** What does this skill require to start?
- Free-text prompt only (the run's original input or a composed prompt)?
- A specific file path it reads explicitly?
- A typed upstream artifact (structured data the prior stage produced)?

This determines what the stage's prompt should provide and whether to wire `inputSchema` on the downstream stage to validate the handoff.

**Q2 — Output locus.** Where does the knowledge live when the skill finishes?
- Files on disk at a predictable path
- Files on disk at an unpredictable path announced in the transcript
- Every file the skill touched (diffable via git)
- Files written via specific tool calls
- Narrative text only in the transcript (rationale, decisions, analysis)
- A URL emitted in the transcript
- A new git commit
- Multiple of the above simultaneously
- Session memory only (nothing observable after the stage ends)
- Nothing (pure side effect, nothing to extract)

This determines which collector to wire (or whether to author a custom one).

**Q3 — Downstream need.** What does the next stage actually consume from this one?
- File paths only (the downstream reads the files itself)
- Structured fields for routing (numeric counts, categories, pass/fail)
- Narrative rationale (why decisions were made)
- The full conversation (questions asked, context built)
- Nothing (the downstream is independent)

This determines session policy and whether you need a parser + `outputSchema`.

**Q4 — Session requirement.** Can downstream start fresh, or does it need the prior conversation?
- Fresh is fine when all knowledge is captured in files or transcript markers.
- Continue is needed when reasoning isn't recoverable from disk + transcript alone.

This determines `sessionPolicy`.

### Translation table: output locus → collector

| Knowledge lives in… | Stage kind | Collector | When downstream routes, add parser… |
|---|---|---|---|
| Files at a predictable path (directory + extension) | `produces` | `directoryPathCollector` | `jsonBodyParser` if body is JSON; custom otherwise |
| Files at a path announced in transcript | `produces` | `transcriptPathCollector` with a path-matching regex | Custom, keyed to the extracted path |
| Every file the stage touched (deliverable IS files) | `produces` or `acts` with outcome | `workspaceDiffCollector` | Custom, over the diff artifact list |
| Files written via specific tool calls | `produces` or `acts` with outcome | `toolCallCollector` | Custom, over the tool-call artifact list |
| Narrative section in transcript | `produces` | `transcriptPathCollector` with a section-scoped regex | Custom, parsing the materialized text |
| A URL in transcript | `produces` | `urlCollector` | — |
| A new git commit | `acts` with outcome | `gitCommitCollector` (or composite `gitCommitOutcome`) | `gitCommitParser` (included in `gitCommitOutcome`) |
| Multiple of the above | `produces` or `acts` | `unionCollectors(collA, collB, ...)` | Per sub-outcome, composed |
| None of the built-ins fit efficiently | `produces` or `acts` | Custom `defineCollector` | Custom `defineParser` as needed |
| Pure side effect, nothing to extract | `acts()` without outcome | — (no outcome needed) | — |
| Nothing, and downstream must not inherit | `terminal()` | — | — |
| Session memory only | Upstream `acts`, downstream `sessionPolicy: "continue"` | — (no outcome on upstream) | — |

**When to author a custom collector.** The built-in collectors cover transcript scanning, tool-call observation, filesystem diffing, and git state. If the skill's output pattern doesn't map cleanly to any of these — for example, it writes a structured artifact with frontmatter you want to parse, or it produces an identifier embedded in a branch name — author a custom collector via `defineCollector` and an optional `defineParser`. Custom collectors are first-class; they receive the same `CollectCtx` and emit the same artifact shapes as built-ins.

### Validation decision rules

When to add schemas:

- **Add `outputSchema`** whenever a downstream edge uses `gate` or a `defineRoute` that reads `output.data`. The load-time validator enforces this — but fix it at authoring time, not after.
- **Add `outputSchema`** when you want the runner to retry the stage on shape drift (`onInvalid: "retry"`, the default). This is useful when the skill's output is non-deterministic and might need a second attempt.
- **Add `inputSchema`** when the downstream stage genuinely cannot proceed without specific upstream fields. A rejection on `inputSchema` halts immediately (no retry) — use it as a hard contract, not a soft warning.
- **Default to sync** schemas for pure shape contracts. **Reach for async** only when correctness needs I/O (file existence checks, endpoint validation).

### Session-policy decision rules

- **Default to `"fresh"`.** It is compatible with loops, script stages, and keeps context bounded.
- **Use `"continue"` only when Q3 demands reasoning that isn't capturable on disk or via a transcript marker.** `"continue"` is incompatible with loops and script stages — a stage cannot combine a loop with `sessionPolicy: "continue"` (each unit requires an isolated session), and load-time validation rejects the combination.
- Every `"continue"` stage grows context monotonically. Long chains of continued sessions become expensive and fragile.

### Authoring protocol

Follow this sequence when composing a new workflow:

**1. List skills in execution order.** Write down each skill name and a one-line description. Don't write DSL yet.

**2. Answer Q1–Q4 for every skill.** Record in a table:

| Skill | Input (Q1) | Output locus (Q2) | Downstream need (Q3) | Fresh? (Q4) |
|-------|-----------|-------------------|---------------------|------------|
| ... | ... | ... | ... | ... |

**3. Assign stage kind per skill.** Based on Q2: `produces` when the skill's primary output is a file the next stage reads; `acts` when the side effect IS the work; `terminal` when nothing should carry forward.

**4. Pick collector + optional parser.** Use the translation table above. If no built-in fits cleanly, reach for `defineCollector`.

**5. Add `outputSchema` where needed.** Required for `gate`/`defineRoute` routing; recommended when the collector/parser pair produces structured data you want to validate.

**6. Set `sessionPolicy`.** Default `"fresh"`. Document the justification for any `"continue"`.

**7. Draw edges.** Linear chains → string targets. Branching logic → `gate` (numeric field) or `defineRoute` (arbitrary). Every path must eventually reach `"stop"`.

**8. Validate.** Run `validateWorkflow()` before shipping — it catches missing outcomes, dangling edges, and schema/routing mismatches.

### Common pitfalls

| Smell | Fix |
|-------|-----|
| `acts()` with no outcome, but the skill clearly writes files | The side effect IS the artifact. Add `outcome: workspaceDiffCollector(...)` or switch to `produces`. |
| `produces` with `noopCollector` | `produces` exists to extract something. If there's nothing to extract, use `acts`. |
| `sessionPolicy: "continue"` on every stage | Revisit Q3 for each stage. Context grows monotonically with continued sessions; default to fresh. |
| `transcriptPathCollector` regex never tested against real output | Test the regex against a sample transcript before wiring it. A non-matching regex produces a fatal collector result silently. |
| `gate` without `outputSchema` on the source stage | Caught by the validator, but cheaper to fix at authoring time. |
| `terminal()` chosen because "it's the last stage" | `terminal` clears the rolling primary slot. If post-run inspection needs the artifact, use `acts` instead. |
| Custom collector that doesn't handle the "nothing found" case | Return `{ kind: "fatal", message: "..." }` — the runner halts and surfaces the message. Don't silently return an empty artifact list from a `produces` stage. |
| `reads:` references a name no `produces` stage publishes | Load-time validator catches the typo. Confirm the upstream stage's `outcome.name ?? <record-key>` matches the name you're reading. |
| Two stages publishing under different names when you wanted them to converge | Give both stages the same `OutputSpec.name` (typically via a shared outcome). The named-publish registry collapses convergent producers into one slot — there is no per-stage `publishes:` override knob. |

## Multi-input stages

The default prompt to a stage is `/skill:<name> <handle>` — exactly one positional arg, the upstream rolling primary artifact. When a stage needs more than one upstream artifact (the canonical case: a "revise plan based on review" step that needs both the plan and the review), declare `reads:` against names in the named-publish registry:

```typescript
revise: produces({
  outcome: planOutcome,
  reads: ["plans", "reviews"],
})
```

When `reads:` is set the runner replaces the default prompt with a labelled-flag form:

```
/skill:revise --plans .rpiv/artifacts/plans/p.md --reviews .rpiv/artifacts/reviews/r.md
```

Multi-artifact stages get flag repetition: an upstream with two `fs` artifacts expands to `--plans <a> --plans <b>` so skill arg-parsers collect repeated flags into arrays the same way `argparse`/`clap`/shell utilities do.

### Fan-in: reading every entry (`fanin` — fanout-and-synthesize)

A bare-string read resolves to the channel's **latest** entry (`array.at(-1)`). That is the wrong default for the fan-in half of *fanout-and-synthesize*: a `fanout` produces N per-unit `Output`s on one channel, and the synthesize stage's whole job is to **merge all N into one**. Latest-wins would hand it only the last unit.

Wrap a name in `fanin(name)` to read **every accumulated entry** of the channel, in run order:

```typescript
import { acts, fanin, fanout, produces } from "@juicesharp/rpiv-workflow";

// fan-out: one collecting unit per plan phase → each appends to state.named["drafts"]
draft: produces({
  outcome: draftOutcome,                  // outcome.name === "drafts"
  loop: fanout({ source: "plans", unit: { by: "frontmatter-array", pattern: "phases" } }),
}),

// fan-in (the barrier): read ALL drafts, synthesize one result
synthesize: produces({
  outcome: summaryOutcome,
  reads: [fanin("drafts")],               // every unit's artifacts, not just the last
}),
```

The synthesize prompt flag-repeats across the whole channel (× each entry's artifacts):

```
/skill:synthesize --drafts <unit1> --drafts <unit2> --drafts <unit3> …
```

`fanin()` is the consumer-side mirror of `fanout()` — fan-out on the producer, fan-in on the consumer. It composes with non-fanout channels too (e.g. reading every `iterate` accumulation), and one `reads:` list may mix forms: `reads: [fanin("drafts"), "spec"]` reads all drafts but only the latest spec. The `reads:` element type is `string | { name; all? }`; `fanin(name)` builds `{ name, all: true }`.

A lint backs the idiom: a **bare-string** read of a channel that a `fanout` fills emits the `reads-latest-from-fanout` warning ("wrap it in `fanin(...)`"). It only warns — latest-only is legal — and `fanin()` reads are already opted in, so they're never flagged. `/wf` preview marks a fan-in consumer with `⇉ <names>`, mirroring the `panel(N, fold)` fan-in surfacing.

### The named-publish registry — `state.named`

Every `produces` stage APPENDS its full `Output` envelope onto `state.named[key]` after each successful run. The key is computed once at write time:

```
key = stage.outcome?.name ?? stage.<record-key>
```

Two layers, no override knob:

- **Outcome carries a name.** Multiple stages wiring the same outcome converge — both stages append onto the same slot, latest-wins on read. This is how a workflow expresses "two stages both produce the canonical plan" without restating the name on each stage.
- **Outcome has no name.** Stages publish under their record key. Downstream `reads: ["blueprint", "code-review"]` references stage record keys directly.

Slots are **arrays** — iteration history is preserved across backward-jump loops; the default read resolves to `array.at(-1)` (latest-wins), while a `fanin(name)` read consumes the whole slot (see [Fan-in](#fan-in-reading-every-entry-fanin--fanout-and-synthesize)). Side-effect stages don't write to the registry. The slot is never cleared by `terminal()` either: it's an additive channel orthogonal to the rolling primary.

### Validation + preflight

- **Load-time** (`validateWorkflow`) — every `reads:` reference must match some `produces` stage's publish key. Catches typos and rename drift before the workflow runs.
- **Runtime** (`ensureNamedReads` preflight) — halts the chain when a `reads:` name's slot is empty (the producer hasn't fired yet on this path). Distinct from the typo case: the workflow is well-formed but the stage was placed before its producer in the edge graph.

### Interaction with the rolling primary

A stage with `reads:` opts out of the rolling-primary contract entirely — `ensureUpstreamArtifact` is skipped, the labelled-flag prompt replaces the single-handle prompt, and `state.primaryArtifact` is ignored for prompt construction. The stage's own produces output (if any) still updates `state.primaryArtifact` for downstream stages that DO use the rolling chain.

## Carrying knowledge across stages

A fresh-session stage starts a clean Pi conversation. It only sees (1) the rolling primary artifact, (2) the inherited artifact list, (3) `output.data` when an `outputSchema` is declared, and (4) any named slots wired via `reads:`. Anything the upstream stage only *spoke* in its transcript is lost. Author the handoff deliberately — five paths:

| # | Mechanism | What downstream sees | Trade-off |
|---|-----------|----------------------|-----------|
| 1 | `sessionPolicy: "continue"` on the downstream stage | Full prior Pi conversation (messages + tool calls) | Incompatible with loops and script stages. Context grows monotonically. |
| 2 | `workspaceDiffCollector` outcome on the upstream stage | Every file the stage touched, as `fs` artifacts | Free when the work IS files on disk. Captures *what*, not *why*. |
| 3 | `transcriptPathCollector` outcome on the upstream stage | The last regex-matched chunk of assistant text, written to disk | Captures narrative knowledge. Needs the skill to emit a recognizable marker. |
| 4 | Custom collector / parser (+ optional `outputSchema`) | Author-defined typed shape | Most precise; most authoring effort. Enables gate routing. |
| 5 | `reads:` on the downstream stage referencing named-publish slots | Latest `Output` per declared name (or **all** entries via `fanin(name)`), woven into a labelled-flag prompt | Reaches further back than the rolling primary; survives intermediate produces stages overwriting the chain. `fanin()` is the fanout-and-synthesize barrier. See [Multi-input stages](#multi-input-stages). |

**Picking between them — where does the knowledge live after the stage finishes?**

- **On disk (the stage's deliverable IS files)** → path 2. Frame the stage as `produces({ outcome: workspaceDiffCollector(...) })` or `acts({ outcome: workspaceDiffCollector(...) })`. "Side-effect with no outcome" is a smell here — the side effect IS the artifact.
- **Only in the assistant's words (rationale, decisions)** → path 3 to materialize it, or path 1 to keep the conversation alive.
- **Both, and the downstream stage needs the full conversation, not just files** → path 1 is the only honest answer. Fresh + a diff collector gives the next stage filenames but no reasoning.

**Combining mechanisms.** `unionCollectors` lets path 2 and path 3 coexist:

```typescript
import {
  acts, unionCollectors,
  workspaceDiffCollector, transcriptPathCollector,
} from "@juicesharp/rpiv-workflow";

acts({
  skill: "frontend-design",
  outcome: unionCollectors(
    workspaceDiffCollector({ filter: (p) => /\.(tsx?|css|md)$/.test(p) }),
    transcriptPathCollector({ pattern: /## Design Notes\n([\s\S]+?)(?=\n##|$)/ }),
  ),
})
```

The fresh downstream session now receives the touched files *and* a notes file capturing the rationale.

**What `acts` without an outcome actually does.** The rolling primary slot from the last upstream `produces` is passed through unchanged — downstream still receives that prior artifact, it just learns nothing about what this stage did. If no `produces` stage has run yet upstream, `ensureUpstreamArtifact` halts the next non-terminal stage with `FAIL_MISSING_ARTIFACT`. Use `terminal()` for stages that should explicitly carry nothing forward.

## Validators

`inputSchema` and `outputSchema` are Standard Schema v1 values (Zod, Valibot, ArkType, TypeBox via `typeboxSchema`). The runner awaits `~standard.validate` at both seams.

**Default to sync** for pure shape contracts. **Reach for async** when correctness needs I/O (file existence checks, endpoint validation).

```typescript
import { typeboxSchema } from "@juicesharp/rpiv-workflow";
import { Type } from "typebox";

outputSchema: typeboxSchema(Type.Object({
  blockers_count: Type.Integer({ minimum: 0 }),
}))
```

A schema rejection on `outputSchema` honours `onInvalid` (`"retry"` by default, `"halt"` to fail fast). A rejection on `inputSchema` halts immediately (no retry — the upstream stage is already frozen).

## Complete example

A full workflow with custom outcomes and conditional routing. This example uses only `@juicesharp/rpiv-workflow` primitives — no external convention packages:

```typescript
import {
  defineWorkflow, produces, acts, gate, gt, eq,
  typeboxSchema, gitCommitOutcome,
  directoryPathCollector, jsonBodyParser, transcriptPathCollector,
  toolCallCollector, fs,
} from "@juicesharp/rpiv-workflow";
import { Type } from "typebox";

// Custom outcome: detect a markdown file the agent writes to a plans directory
const planOutcome = {
  collector: directoryPathCollector({ dir: "plans", ext: "md" }),
  parser: jsonBodyParser,
};

// Custom outcome: detect files the agent writes or edits via tool calls
const writeFileOutcome = {
  collector: toolCallCollector({
    match: (tc) => tc.name === "write" || tc.name === "edit",
    toArtifact: (tc) => ({ handle: fs(String(tc.input.path ?? tc.input.target_file ?? "")) }),
  }),
};

const REVIEW_SCHEMA = typeboxSchema(
  Type.Object({ blockers_count: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
);

export default defineWorkflow({
  name: "mid",
  start: "research",
  stages: {
    research:      produces({ outcome: planOutcome }),
    blueprint:     produces({ outcome: planOutcome }),
    implement:     acts(),
    validate:      produces({ outcome: writeFileOutcome }),
    "code-review": produces({
      outcome: writeFileOutcome,
      outputSchema: REVIEW_SCHEMA,
    }),
    revise:        produces({ outcome: writeFileOutcome }),
    "implement-after-revise": acts({ skill: "implement" }),
    commit:        acts({ outcome: gitCommitOutcome }),
  },
  edges: {
    research: "blueprint",
    blueprint: "implement",
    implement: "validate",
    validate: "code-review",
    "code-review": gate("blockers_count", {
      revise: gt(0),
      commit: eq(0),
    }, "commit"),
    revise: "implement-after-revise",
    "implement-after-revise": "commit",
    commit: "stop",
  },
});
```

## Validation rules

Generated workflows must pass `validateWorkflow()` before writing. The validator checks:

- `start` references a declared stage
- Every edge key exists in `stages`
- Every edge target exists in `stages` or is `"stop"`
- Stage kinds are valid (`"produces"` or `"side-effect"`)
- `produces` stages have an `outcome`
- `gate` / data-reading `defineRoute` source stages have `outputSchema`
- Every `reads:` name is published by some `produces` stage in the workflow (publish key = `outcome.name ?? stage.<record-key>`)
- A stage **cannot combine a loop with sessionPolicy "continue"** — each unit requires an isolated session
- **A collecting loop requires an `outcome` with a `name`** so units publish to a stable named slot (iterate and assess always; a `fanout` when its stage `kind` is `produces`)
- `iterate` / `assess` require `kind: "produces"` — each unit runs an outcome collector
- `loop.max` must be an integer `>= 1` (the run-wide `maxIterations` caps the upper bound)
- a judge's `outcome.name` must differ from the producer's publish name (`assess` and `verify`); `assess` composes with `reads` (the v1 restriction is lifted — round-0 producer args are derived by one authority and frozen by the resume fold at loop-generation open)
- **prompt and fanout/iterate loops are mutually exclusive** — units own their prompts (`assess` loops and `verify` compose with prompt dispatch); prompt stages also cannot set `skill`, `run`, or `reads`; a `produces` prompt stage still needs an `outcome`; an empty prompt string is rejected
- **Script stages cannot loop — write a loop inside run() instead**; they also cannot declare `skill`, `outcome`, `prompt`, or `sessionPolicy: "continue"`

> **Important:** The `/wf` command blocks execution on any `severity: "error"` issue. Always validate before writing.
