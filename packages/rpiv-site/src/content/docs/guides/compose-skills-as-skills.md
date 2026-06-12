---
title: "Compose skills as skills"
description: "Author your own workflow as a typed graph. Fresh sessions, verifiable handoffs, the three ways a stage dispatches, and the fanout/iterate split."
section: "guides"
order: 6
---

The idea behind `/wf` is small: compose skills as skills, on top of an existing coding agent, with each step in a **fresh session**, **scoped tools**, and a **verifiable handoff** to the next. The runtime nails two of those outright — a clean session per stage, and a typed contract between stages the runner checks before it lets the chain advance. Scoped tools sit at the skill layer; the sandbox is the host's job. This guide is about authoring the first two yourself.

[Run a workflow](/docs/guides/run-a-workflow) is the consumer's tour — the six bundled chains and when to reach for each. This is the producer's: how to express your own chain as a typed graph, and the two stage capabilities that landed after the runtime's first cut — raw-text `prompt` dispatch and the sequential `iterate` mode.

## The graph is the program

A workflow is a typed graph: a named entry point, a `stages` record, and an `edges` table that maps each stage to another stage name, the `"stop"` sentinel (or its typed twin `STOP`, importable from the package), or a predicate. Plain TypeScript, no build step.

```ts
import {
  defineWorkflow, produces, acts, gate, gt, eq,
} from "@juicesharp/rpiv-workflow";

export default defineWorkflow({
  name: "review-and-ship",
  start: "plan",
  stages: {
    plan: produces({ outcome: myPlanOutcome }),
    implement: acts(),
    "code-review": produces({
      outcome: myReviewOutcome,
      outputSchema: REVIEW_SCHEMA,
    }),
    revise: produces({
      outcome: myPlanOutcome,
      reads: ["plan", "code-review"],
    }),
    commit: acts(),
  },
  edges: {
    plan: "implement",
    implement: "code-review",
    "code-review": gate("blockers_count", {
      revise: gt(0),   // blockers remain — loop back
      commit: eq(0),   // clean — ship it
    }),
    revise: "implement", // backward edge
    commit: "stop",
  },
});
```

The graph is validated at load time. `validateWorkflow()` rejects a dangling edge, a `produces` stage with no outcome (neither wired inline nor derivable from the skill's contract), or a `reads:` name no stage publishes — and warns when a `gate` routes on a stage whose data has no schema to validate against, inline or contract-sourced — all before a single session opens. A broken workflow fails to load, not halfway through a run. `/wf <name>` previews the graph so you can read every stage, its dispatch, and where the branches land before you spend a token.

## Two guarantees you get for free

**Fresh session per stage.** Every stage boots a clean Pi conversation (`sessionPolicy: "fresh"`). `research`'s sprawling reading list doesn't follow `plan` into its session; `plan`'s scratch work doesn't follow `implement` into its session. Each stage starts from the artifact on disk, not from whatever the last stage was holding in its head. This is the same [reset-between-skills](/docs/guides/reset-between-skills) discipline you'd enforce by hand — the runner just makes it the default instead of a thing you remember to do.

**Verifiable handoff.** Each `produces` stage declares an `outcome` — a collector that enumerates what the skill wrote, and an optional parser that interprets it into typed `output.data`. Layer a [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, or TypeBox via the bundled `typeboxSchema`) on `outputSchema` and the runner validates the shape at the seam. On drift it retries (`onInvalid: "retry"`, the default) or halts (`"halt"`). That validated `output.data` is what `gate` routes on — the typed handoff is what makes the branch real:

```ts
import { typeboxSchema } from "@juicesharp/rpiv-workflow";
import { Type } from "@sinclair/typebox";

const REVIEW_SCHEMA = typeboxSchema(
  Type.Object(
    { blockers_count: Type.Integer({ minimum: 0 }) },
    { additionalProperties: true },
  ),
);
```

`code-review` emits `blockers_count`, the runner counts it, and the next stage is `revise` or `commit` accordingly. No human eyeballs the review to decide. Backward edges are first-class — `revise → implement` is just another edge target — and the runner counts backward jumps, halting at `maxBackwardJumps` (default 2, so at most 3 review iterations) so a stuck loop can't burn tokens forever.

## Before you wire: four questions per skill

The runner only sees what collectors enumerate. Everything else — transcript reasoning, session memory — is lost across a fresh-session boundary, silently. So answer four questions for each skill *before* writing any DSL:

1. **Input contract** — what does this skill need to start? Free text, a specific path, or a typed upstream artifact?
2. **Output locus** — where does the knowledge live when it finishes? Files at a known path, files announced in the transcript, the whole git diff, a new commit, narrative text only?
3. **Downstream need** — what does the *next* stage actually consume? Paths, structured fields for routing, rationale, or the full conversation?
4. **Session requirement** — can the next stage start fresh, or does it genuinely need the prior conversation?

Q2 picks your collector; Q3 decides whether you need a parser and `outputSchema`; Q4 sets `sessionPolicy`. The [authoring reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-workflow/docs/workflow-authoring.md) has the full translation table from output-locus to collector, plus the bundled collector catalog. The discipline is the point: every stage forces you to name what it reads, what it produces, and whether the next step can start clean.

## Three ways a stage dispatches

A stage's **dispatch** is orthogonal to its kind (`produces` / `acts`) and to its session policy. There are three:

| Dispatch | What runs | Set via |
|----------|-----------|---------|
| **skill** (default) | `/skill:<name> <args>` — the full skill body | nothing |
| **script** | a pure TypeScript function, no model call | `run:` |
| **prompt** | raw text sent straight to the model — a chat turn | `prompt:` |

**Script** stages are for work that needs no LLM — merge two artifacts, bump a version, fire a notification. Same lifecycle, same JSONL audit, same place in the graph; [Run a workflow](/docs/guides/run-a-workflow) covers them.

**Prompt** stages are the newer surface. A `prompt` stage sends author-owned text as the user message — no `/skill:` prefix, no implicit upstream-artifact arg appended. Use it for a focused, one-off instruction that doesn't warrant a whole skill. Prefer the typed builders `produces.prompt({ … })` / `acts.prompt({ … })` — they structurally omit `skill`/`run`/`fanout`/`iterate`/`reads`, so an invalid combo fails to compile rather than only failing load validation:

```ts
// a side-effect chat turn — no artifact collected
acts.prompt({
  prompt: "Implement the design spec discussed above.",
  sessionPolicy: "continue",
})

// a produces chat turn — its reply runs the outcome
// collector like any produces stage
produces.prompt({
  prompt: "Write a one-paragraph summary to .rpiv/artifacts/summary/s.md",
  outcome: myOutcome,
})

// dynamic — weave in the upstream Output via a PromptFn
// (the same context script stages get)
produces.prompt({
  prompt: ({ input }) =>
    `Refine ${handleToString(input!.artifacts[0]!.handle)} for clarity.`,
  outcome: myOutcome,
})
```

**The killer use is the `continue` follow-up.** With `sessionPolicy: "continue"`, a prompt stage sends a follow-up into a session a prior stage already populated, *without re-invoking a skill*. It's the only honest way to build on a stage whose output is conversation-only — a `frontend-design` pass that emits no artifact, say — where the downstream step leans on the shared context:

```ts
stages: {
  // fresh — writes a spec
  discover: produces({ outcome: rpivBucketOutcome("research") }),
  // same session, emits no artifact
  design: acts({ skill: "frontend-design", sessionPolicy: "continue" }),
  // leans on the shared context
  implement: acts.prompt({
    prompt: "Implement the design spec.",
    sessionPolicy: "continue",
  }),
}
```

> **When not to.** Prompt text in a workflow definition isn't versioned, localized, or independently testable the way a `SKILL.md` is. Keep prompt stages short and glue-like; anything reusable belongs in a skill.

## Two ways to decompose: fanout vs iterate

Some stages do one thing per unit of work. There are two ways to split a stage into units, and they are duals, not substitutes.

**`fanout`** is *push*: it computes every unit up front and runs them blind to one another. It's how the bundled `implement` stage spawns one Pi session per `## Phase N:` heading in the inherited plan — the phases are independent, so each session runs without seeing the others.

**`iterate`** is *pull*: the runner calls your `IterateFn` one unit at a time, feeding each call the validated outputs of every prior unit in the same stage. Return the next unit, or `null` to terminate. Each unit runs the stage's `outcome` collector exactly like a one-shot `produces` pass — it validates, appends its `Output` to `state.named[outcome.name]`, and rolls the primary forward. Reach for it when each unit must build on the last.

```ts
import type { IterateFn } from "@juicesharp/rpiv-workflow";

// one blueprint pass per review phase,
// each building on the plans already produced
const perPhase: IterateFn = ({ artifact, accumulated, index, cwd }) => {
  if (artifact?.handle.kind !== "fs") return null;
  const phases = readPhases(artifact.handle.path, cwd);
  if (index >= phases.length) return null; // terminator
  const prior = accumulated.flatMap((o) => o.artifacts).map(pathOf);
  return {
    prompt:
      `${artifact.handle.path} Phase ${phases[index].n}` +
      (prior.length ? `\nPrior plans: ${prior.join(", ")}` : ""),
    label: `phase ${index + 1}/${phases.length}`,
    id: `phase-${phases[index].n}`, // stable audit key
  };
};

produces({ outcome: rpivBucketOutcome("plans"), iterate: perPhase })
```

| | `fanout` | `iterate` |
|---|---|---|
| Generation | push — once, all units | pull — per unit, sees prior |
| Stage kind | any (often `acts`) | requires `produces` + a named `outcome` |
| Collector per unit | no (bare audit row) | yes (full produces path) |
| Count known up front | yes | no — generator-terminated |
| Use when | units are independent | each unit builds on the last |

`iterate` requires `kind: "produces"` and an `outcome` carrying a `name` — every unit publishes to the same named slot, so a name keeps the accumulation from splitting. It's mutually exclusive with `fanout` and with script `run`, and incompatible with `sessionPolicy: "continue"` (each unit needs its own isolated session). A first-call `null` is a zero-unit no-op (warns, advances); a run-wide `maxIterations` cap (default 32) backstops a generator that never terminates. One more contract, and resume enforces it: your `IterateFn` must be **deterministic with respect to its entry artifact** — on resume the runner recomputes the unit at the resume point and refuses with a terminal failure if it differs from what the run recorded, rather than risk running the wrong unit. (The same determinism rule has always applied to `FanoutFn`.)

## Reading `polish`: iterate and prompt together

The bundled `polish` workflow is where both new capabilities earn their keep. It exists for a large architecture review that can't be planned in one pass — its phases are dependency-ordered, so each phase's plan has to build on the ones before it.

```ts
const polishWorkflow = defineWorkflow({
  name: "polish",
  start: "architecture-review",
  stages: {
    "architecture-review": produces(),
    blueprint: produces({ iterate: REVIEW_PHASE_ITERATE }),
    implement: acts({ fanout: PLANS_PHASE_FANOUT, reads: ["plans"] }),
    validate: produces({ prompt: VALIDATE_PLANS_PROMPT }),
    "code-review": produces(),
    commit: acts({ outcome: gitCommitOutcome }),
  },
  edges: {
    "architecture-review": "blueprint",
    blueprint: "implement",
    implement: "validate",
    validate: "code-review",
    "code-review": gate("blockers_count", {
      commit: eq(0),
      blueprint: gt(0),
    }),
    commit: "stop",
  },
});
```

Notice how little wiring the stages carry. Each `produces` stage's outcome — the bucket it publishes to (`plans`, `reviews`, `validation`) and the schema its data is validated against — is **derived from the dispatched skill's contract**, not restated on the stage. So `blueprint` lands in the `plans` channel and `code-review`'s `{ blockers_count }` routing schema both come from their `SKILL.md` contracts; the workflow only names what the contract can't infer (the `iterate`/`fanout` decomposition, the `prompt` override, the `reads`, and `commit`'s `gitCommitOutcome`). Three moves make it work:

- **`blueprint` iterates over the review's phases.** `REVIEW_PHASE_ITERATE` reads the `### Phase N — name` headings from the architecture review and pulls one per call, handing each pass the paths of the plans the earlier passes already wrote (`Prior phase plans … build on them, don't duplicate`). Where `fanout` would plan every phase blind, `iterate` lets phase 3's plan see phases 1 and 2. On a corrective loop it folds the latest code review's blockers into each pass.
- **`implement` fans out over every plan.** `PLANS_PHASE_FANOUT` walks the `## Phase N:` headings of *all* the plans the blueprint pass accumulated — push decomposition, because implementing one phase doesn't depend on implementing another.
- **`validate` is a `prompt` stage, and it has to be.** This is the subtle one. The default rolling primary — and a plain `reads: ["plans"]`, which only reads `.at(-1)` — would hand `validate` the *last* plan alone, leaving every earlier phase unvalidated. `VALIDATE_PLANS_PROMPT` is a `PromptFn` that reaches into `state.named` for *every* plan in the latest blueprint pass and builds the whole `/skill:validate <p1> <p2> …` message itself. A prompt stage owns its entire message, so it can address the full accumulation a single positional arg can't.

The review loop routes on the same `{ blockers_count }` schema as `build`, but the backward edge returns to `blueprint` — a corrective pass re-plans every review phase, blockers folded in, under the same `maxBackwardJumps` bound. That's the shape: `iterate` to accumulate, `prompt` to address the accumulation, a `gate` to close the loop.

## Ship it

A workflow lives in one of two file roles per layer:

- **Config files** (`.rpiv/workflows/config.ts` in a project, `~/.config/rpiv-workflow/config.ts` for a user default) are the one TypeScript file you hand-edit, and the **only** place that can set `default` — the workflow `/wf <input>` runs with no name.
- **Pack files** (`packs/*.ts`) are installable bundles: drop them in, get new workflows, no risk of overwriting anyone's default. That split is what makes shared workflow packs safe.

The runner is skill-agnostic — it doesn't know `research` or `commit` ship from `rpiv-pi`. Chain your own skills the same way, and run `validateWorkflow()` before you ship; `/wf` blocks execution on any error-severity issue, so catching it at authoring time is free.

## Reuse a bundled skill everywhere: `skillAliases`

You often want the bundled chains — `ship`, `build`, `arch`, `vet`, `polish` — exactly as shipped, but with one skill swapped for your own. The canonical case: a team that wants **model attribution on commits** authors an `attributed-commit` skill and needs every chain to use it instead of the bundled `commit`. Forking five workflow definitions to change one stage is the wrong move — they'd drift on the next upgrade.

`skillAliases` is the seam for this. A single declarative entry in your `config.ts` remaps a skill name across **every** loaded workflow — built-in, user, and project — at load time:

```ts
// .rpiv/workflows/config.ts
export default { skillAliases: { commit: "attributed-commit" } };
```

Now every stage that would dispatch `/skill:commit` — in `ship`, `build`, `arch`, `vet`, and any workflow you authored — dispatches `/skill:attributed-commit`. The bundled definitions stay byte-for-byte untouched and upgrade-safe.

A few properties worth knowing:

- **The key is the skill name**, not the stage id — `stage.skill ?? <stage key>`. An implicit-skill `commit:` stage and an explicit `release: acts({ skill: "commit" })` stage are both caught by `{ commit: … }`.
- **One hop only.** `{ a: "b", b: "c" }` maps a `→ b`, never `a → c`. No transitive chains, no cycles.
- **`run`/`prompt` stages are skipped** — they don't dispatch a `/skill:`.
- **Project overrides user** per key; the merged map applies to the whole set.
- **It's config-only** — packs reject the envelope, keeping `default` and aliases one-source-of-truth-per-layer. An alias-only `config.ts` (no `workflows`) is valid.

It's visible, not magic: `/wf` previews a `Skill aliases in effect: commit → attributed-commit` banner, and an alias key that matches no dispatched skill anywhere surfaces a load-time warning. A bad target (a skill that doesn't exist) trips the same runtime "skill not found" preflight a mistyped `skill:` would.

## What's next

The piece worth circling back to is the agent authoring the graph itself. Writing the typed graph by hand means answering, per stage, exactly the questions in the [four-questions](#before-you-wire-four-questions-per-skill) section — what does this skill read, what does it produce, can the next step start fresh. That's structured reasoning the agent is already good at, and the runtime ships two of the three pieces a generator would lean on: a `validateWorkflow` check that rejects dangling edges and missing contracts before a run starts, and an authoring protocol that walks each skill's input, output, and session needs one question at a time. The spec exists, the checker exists. The missing piece is the thing in the middle that reads your skills and emits the graph.

## Next steps

- [Run a workflow](/docs/guides/run-a-workflow): the six bundled chains and the runtime surface, from the consumer's side
- [Pick your path](/docs/guides/pick-a-path): the scope map the bundled workflows mirror
- [Reset between skills](/docs/guides/reset-between-skills): the fresh-context rule the runner enforces for you
- [Authoring reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-workflow/docs/workflow-authoring.md): every stage factory, the collector and parser catalogs, the full validation rules
