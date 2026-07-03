---
title: "How a workflow works"
description: "The concepts behind the workflow runner, flat and in order: graph, stages, channels, outcomes, contracts, script stages, triggers, listeners, and the two moments of enforcement."
section: "explanation"
order: 0
---

A workflow in `@juicesharp/rpiv-workflow` is a **graph of stages**, not a top-to-bottom script. This page lays out the concepts behind it in the order you meet them when authoring: from the shape of the graph, to the doors that connect it to the outside world, to the two moments where the framework refuses an invalid run. For the task-oriented version (handing a real chain to `/wf`), see [Run a workflow](/docs/guides/run-a-workflow).

## The graph

You define a workflow by calling `defineWorkflow(...)` with four things:

- `name` is what users type to run it (`/wf <name>`).
- `start` is the stage the graph begins at.
- `stages` is a record of named stages.
- `edges` says, for each stage, where to go next.

```ts
defineWorkflow({
  name: "quick",
  start: "blueprint",
  stages: {
    blueprint: produces(),
    implement: acts(),
    validate:  produces(),
  },
  edges: {
    blueprint: "implement",
    implement: "validate",
    validate:  "stop",
  },
})
```

`"stop"` is the terminal sentinel. A stage with no outgoing edge is treated as an implicit terminal, and flagged at load. Declare `"stop"` to be explicit.

## Stages and workers

A stage makes two independent choices: **what runs it** and **its kind**.

**What runs it** is either AI-driven or deterministic:

- A **skill** (the default): a Markdown specialist invoked as `/skill:<name>`. The LLM does the work.
- A **prompt**: author-owned raw text sent straight to the session, no skill. Still LLM-driven (covered below).
- A **script**: your own TypeScript, run directly. No LLM, fully deterministic (covered below).

**Its kind** decides how the result is handled:

- `produces()` emits an artifact and hands it forward (`kind: "produces"`).
- `acts()` performs a side effect, hands no artifact forward (`kind: "side-effect"`).

The axes compose: a stage can be an AI `produces`, a deterministic `acts`, and so on. You don't restate the skill name when it matches the stage key: `blueprint: produces()` dispatches `/skill:blueprint`. Override with `produces({ skill: "..." })` when they differ.

## The handoff: two kinds of channel

**The rolling primary.** When a `produces` stage finishes, its artifact becomes the *primary artifact*, a single rolling slot the next stage inherits automatically. This is the default linear handoff; no wiring needed.

**Named channels.** Some artifacts deserve a named shelf. A stage with a named outcome publishes onto `state.named["<name>"]`, a **bucket**. Any later stage reads it by name with `reads:`.

```ts
blueprint: produces({ outcome: { name: "plans" } }),
implement: acts({ reads: ["plans"] }),
```

A reader does not depend on adjacency. It gets whatever was last published to the channel, across loops and non-adjacent producers. Named channels are **many-to-one**: several stages can publish to `"plans"`, and a reader sees the latest. See [Handoffs](/docs/guides/handoffs) for the artifact mechanics.

## Inside a stage: the outcome

A stage's **outcome** (`OutputSpec`) turns a worker's messy real-world effect into clean structured `data`. It is a small pairing: a `collector` and an optional `parser` (plus an optional `name` for the bucket it publishes to). Across a stage, the outcome runs as a four-step sequence:

1. **snapshot.** The collector's optional pre-stage hook records a baseline (for example git `HEAD`).
2. **collect.** After the stage, the collector gathers what changed (files, a diff, a transcript).
3. **parse.** The optional parser turns the gathered artifacts into `{ kind, data }`.
4. **finalize.** The runner stamps `meta` (stage, number, timestamp, run id) and seals the `Output`.

The built-in `gitCommitOutcome` is the clearest example: its collector snapshots `HEAD`, checks after the stage whether `HEAD` moved, and its parser emits the commit it found (`{ sha, prevSha, subject, filesChanged }`). The framework **measures the effect** rather than trusting a claim. A `produces` stage that delivers zero artifacts fails its completion contract here.

The parsed `data` is what predicates branch on and what schemas validate downstream.

## Contracts

A skill can sign a **contract** in its `SKILL.md` frontmatter, declaring two channels:

```yaml
contract:
  produces:
    data:
      type: object
      required: [phases, phase_count]
    meta:
      artifactKind: plan
  consumes:
    data:
      status: { const: ready }
    reads:
      plans:
        meta: { artifactKind: plan }
```

- `produces.data` and `consumes.data` are the **only** schema the framework itself adjudicates (JSON Schema).
- `meta` is an **opaque** bag for domain tags (`artifactKind`, and so on). The framework stores and carries it but never interprets what is inside.

Contracts are harvested into a **registry** at load. From it the framework answers `legalNextSkills` and `canCompose`, so an author (or an agent) can assemble a valid chain without reading prose.

## Composition comparators

Because the framework refuses to interpret `meta`, you supply the one piece that can: a **composition comparator** for a channel.

```ts
registerCompositionComparator(
  "plans",
  artifactKindComparator,
)
```

The comparator is the only code that compares two `meta` envelopes for the `"plans"` channel. It returns `{ ok: true }` or `{ ok: false, reason }`. This keeps the engine ontology-blind while letting your domain be checked.

## Branching and loops

An edge can be a string, `"stop"`, or a **predicate edge** that routes on the stage's data:

```ts
"code-review": gate("blockers_count", {
  revise: gt(0),
  commit: eq(0),
}),
```

`gate(field, routes)` reads a field from the stage's output `data`; `gt`, `eq`, and friends are **predicates**. Point an edge backward (`revise` to `implement`) to make a **loop**, bounded by the runner's `maxBackwardJumps` guard so it can never spin forever. Hand-rolled routing goes through `defineRoute(targets, fn)` so the targets stay enumerable for validation.

## Fanout and iterate: splitting a stage

Mark a stage `fanout` and the runner splits it into one unit per slice (for example, one unit per `## Phase N:` heading the inherited plan declares), each in its own isolated session, blind to the others. `iterate` is the accumulating counterpart: units are pulled one at a time, each able to see the prior result. You author one stage; the runner handles the spread and the join.

`fanout` units run **simultaneously** — one Pi child session per unit, in-process, waves respecting each unit's declared dependencies — with a live lane console over the run: step into any lane, watch its output, answer its question without halting the others. `iterate` stays **sequential by contract**: each pass must see what the earlier passes wrote, so ordering is the point, not a limitation. A fanout can still opt down to `concurrency: 1` when its units mutate shared state — the bundled `implement` does exactly that, because applying one plan to one working tree is a patch series, not a race.

## Sessions: fresh or continue

By default every stage runs in a **fresh** session, isolated from the others (`sessionPolicy: "fresh"`). Set `sessionPolicy: "continue"` to keep the previous stage's session thread, so the stage sees the prior conversation as context instead of starting clean:

```ts
revise: acts({
  prompt: "Apply the review feedback above.",
  sessionPolicy: "continue",
}),
```

`continue` needs a host session from a prior stage, and cannot combine with `fanout` (which requires per-unit isolation) or with script stages.

## Prompt stages: raw text instead of a skill

Still AI-driven, but without a named skill. A stage can send **author-owned raw text** straight to the session via a `prompt`:

```ts
summarize: acts({
  prompt: "Summarize the design decided above.",
}),
```

The `prompt` is a string, or a `PromptFn` that receives the `ScriptContext` and returns one (so it can weave in upstream output). Useful for a one-off instruction that doesn't warrant its own `SKILL.md`.

## Script stages: deterministic code instead of a skill

The deterministic form. A stage can carry a **`run`** function instead of dispatching a skill, authored with `produces.script` or `acts.script`. It skips the LLM entirely and executes your TypeScript, receiving a `ScriptContext`:

```ts
fetchTickets: produces.script({
  run: async (ctx) => {
    // ctx.cwd, ctx.input, ctx.state
    const open = await db.openTickets()
    return {
      kind: "tickets",
      artifacts: [],
      data: { count: open.length },
    }
  },
}),
```

A `produces` script returns the value half of an envelope (`{ kind, artifacts, data }`; the runner stamps `meta`). An `acts` script returns nothing. Crucially, a script stage is a **first-class citizen of the same graph**: its `data` flows through the same channels, predicates branch on it, and input validation still applies.

### Reaching external systems

Because a script stage is plain code, it can call an HTTP API, query a database, write to a queue or object store, reading data in or writing data out. Whatever it pulls in **re-enters through the typed front door**: the returned `data` is validated against the stage's schema before it flows onward. The outside world stays messy; your graph stays checked.

## Triggers: what started the run

Every run records its origin as a `RunTrigger`:

- `{ kind: "command", name }`, a person ran `/wf`.
- `{ kind: "programmatic", source? }`, code called `runWorkflow(...)`.
- `{ kind: "external", source, ref?, meta? }`, a webhook, cron tick, or sibling-extension spawn.

The trigger is threaded into the JSONL run header, every lifecycle event, and run summaries, so post-hoc readers can filter and route by origin.

The framework provides the **vocabulary and plumbing**, not a webhook server or cron daemon. The listener lives outside: it hears an external event and calls `runWorkflow` with the appropriate `trigger`. Note the runtime is single-active-session; an external trigger must gate its own spawning if a run is already in flight.

## Listeners: watching a run unfold

The inverse of a trigger. A run fires **lifecycle events** any embedder can subscribe to via `LifecycleListeners`:

`onWorkflowStart` and `onWorkflowEnd`, `onStageStart` and `onStageEnd`, `onStageRetry` and `onStageError`, `onRoute`, `onFanoutStart` and `onFanoutUnitEnd`.

Each carries a `LifecycleContext` (run id, workflow, the trigger). Use them to drive a progress UI, update a ticket, or alert on failure, without the workflow knowing who is watching.

## The two moments of enforcement

The framework refuses invalid runs at two distinct moments. Knowing which catches what is the key mental model.

| | When | Catches | Where |
|---|---|---|---|
| **Load-time** | before any stage runs | bad **wiring**: unknown targets, unreachable stages, a `reads:` channel no one publishes, or a publisher whose contract is incompatible with the reader | `validateWorkflow` |
| **Run-time** | as data flows | bad **data**: an actual artifact that fails its `consumes.data` schema (for example, `status` is not `ready`) | `ensureContractInputValid` |

Named-channel (`reads`) validity is a **complete load-time guarantee**. `checkReadsChannelCompat` enumerates *every* publisher of a channel, not just the edge predecessor, but loop-back and non-adjacent producers, and runs the channel comparator on each. A clean mismatch between two signed contracts is an **error**: the workflow is rejected at authoring time, uniformly across all stage kinds (fanout included). When either side is unsigned, or no comparator is registered, it degrades silently. Unsigned never errors.

The principle: catch a bad wiring while you are still drawing the map; catch bad data only when the data actually shows up.

## Single source of truth

Two small helpers keep load-time and run-time from ever disagreeing on a name:

- `resolvePublishName(def, stageName)`, the bucket a stage publishes onto (`outcome.name ?? stageName`).
- `resolveSkill(def, stageName)`, the contract-registry key for a stage (`skill ?? stageName`).

Both the runner and the load-time checks route through these, so a stage is keyed identically everywhere. The same instinct drives **outcome derivation**: a skill's `artifactKind` maps through one table (`BUCKET_BY_KIND`) to its bucket, so every producer of a given kind lands in the same channel. No per-workflow restatement, no drift.

## Putting it together

A workflow is a graph of named stages, run by **skills** or **prompts** (AI-driven) or **scripts** (deterministic), handing artifacts forward along a rolling primary slot and **named channels**. Each stage's **outcome** observes its effect and parses it into typed `data`. **Contracts** declare what each skill takes and gives; **comparators** adjudicate the opaque parts you define. **Gates** and bounded loops shape the path; **fanout** and **iterate** spread the work. **Triggers** wake the run from the outside; **listeners** follow it. And two enforcement moments, load-time wiring validation and run-time data validation, ensure the only journeys that run are the ones that can actually work.

Next: [Run a workflow](/docs/guides/run-a-workflow) walks the three bundled pipelines and the `/wf` commands. For the narrative version of this same arc, read [The workflow author's tale](/blog/the-workflow-authors-tale).
