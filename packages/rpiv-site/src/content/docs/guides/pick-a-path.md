---
title: "Pick your path"
description: "Five paths mapped to feature scope. Trivial, small, small+, mid, large."
section: "guides"
order: 0
---

Five recipes. The smallest that still keeps the driver in the loop where it matters is the one to run.

The pipeline is a menu, not a script. Each skill writes a markdown artifact under `.rpiv/artifacts/<stage>/` that the next skill reads, so you can stop, review, and resume between any two steps. Two inputs decide your chain: scope, and what's already in hand.

Path choice isn't a one-way door. Pick too big and you pay extra latency on artifacts you didn't need. Pick too small and you'll usually feel it mid-implement; back up a phase, switch to the next path up, keep going. The penalty is time, not damage.

## Three ways in

The chain proper starts at `/skill:research`. How you get there depends on what you have:

| You have | Get to research via |
|---|---|
| A spec, ticket, or sharp description | `/skill:research <free-text>`. No pre-phase needed. |
| A fuzzy idea | `/skill:discover` first. It interviews you one question at a time and writes a Feature Requirements Document that `/skill:research` then reads. |
| A clear feature, unsure of the technical approach | `/skill:explore` first. Compares valid technical approaches side-by-side. The solutions document feeds `/skill:design` or `/skill:blueprint` directly. For codebase grounding, run `/skill:research` first and hand its output to `/skill:explore`. |

## Hand-drive, or hand it to `/wf`

The recipes below run the same skills in the same order whether you invoke them yourself or hand them to the workflow runner. `rpiv-workflow` ships three bundled pipelines:

- **`/wf build`**: ships a feature from a brief, sliced and gated. `goal → research → slice → ⛩ → design-slice ×N → design-review → subplan → plan → ⛩ → elaborate ×phases → code-splice → ⛩ → implement → validate → commit` (19 stages). Your brief is captured verbatim, and every quality gate grades against it. Slices are designed in parallel. The run pauses once, at a consolidated design review. Three gates each carry a bounded fix loop. → [Run a workflow](/docs/guides/run-a-workflow) for the full anatomy.
- **`/wf vet`**: `code-review → (blueprint → implement → validate → loop) → commit`. Orthogonal to scope: point it at an existing diff (yours or a teammate's) for a structured review with an optional fix cycle.
- **`/wf polish`**: `architecture-review → blueprint → implement → validate → code-review → (blueprint loop) → commit`. Off the scope ladder: for a large architecture review whose phases are dependency-ordered. `blueprint` *iterates*, one plan per review phase, each building on the last, rather than planning everything in one pass. Reach for it when the review itself surfaced the sequence. → [Compose skills as skills](/docs/guides/compose-skills-as-skills).

(`/skill:pr-triage` runs standalone for read-only triage of an incoming GitHub PR: disposition plus security tier, nothing checked out. It feeds `/wf vet <branch>` when the PR earns a full pass.)

The runner writes artifacts under `.rpiv/artifacts/` exactly as the hand-driven chain does, plus an audited JSONL trail per run under `.rpiv/workflows/runs/<run-id>.jsonl` you can resume from with `/wf @<run-id>`. Routing is typed: `vet` and `polish` route on the `blockers_count` field `code-review`'s contract supplies, and `build`'s three gates fold per-dimension grade verdicts. The runner picks the next stage from the value, no eyeballing required. Fanout stages run their units as simultaneous Pi child sessions with a live lane console. `implement` fans out one unit per `## Phase N:` heading in the inherited plan and runs them serially (a plan is a patch series).

Hand-drive when you want the pause between every artifact: for exploratory work, mid-flow pivots, or your first pass through a codebase. Use `/wf` once the chain's rhythm is muscle memory. → [Run a workflow](/docs/guides/run-a-workflow).

## Five paths by scope

### Trivial: mechanical change

```
discover → fix in chat → commit
```

No research artifact, no plan. The FRD is the brief; execution happens in conversation. Reserve this for changes where the FRD enumerates every line you'd plausibly touch and there are no design choices left to make.

Discover earns its keep even here. The FRD is one document the LLM re-reads instead of you re-stating, and it survives `/reload` if the chat dies mid-change.

Good fits:

- A `--json` or `--dry-run` flag on an existing CLI command
- A content excerpt field added to an existing RSS or JSON feed
- Renaming a config key while keeping a deprecated alias
- Promoting a CSS rule from one page into a shared stylesheet
- Tightening a regex inside one validator

### Small feature or bug fix

```
[discover?] → research → fix in chat → commit
```

No planning step, no `/skill:implement` invocation. Open a fresh session, point the LLM at the research artifact (`.rpiv/artifacts/research/<bug>.md`), and ask it to apply the fix. The research artifact IS the brief. When the diff looks right, hand it to `/skill:commit`.

Three flavors in practice:

- **One-spot bug fix** where research reads adjacent code: off-by-one in a pagination control, wrong HTTP status from one endpoint, a missing null check that crashes one component, a timezone mishandled on a single timestamp field.
- **Profiling-driven perf fix** where research _is_ the profiler pass: scroll lag on a mobile Settings screen, cold-start latency on a serverless function, a slow query behind a heavily-used dashboard.
- **Multi-package mechanical sweep** where research enumerates per-site quirks: replacing direct `process.env` reads with a typed accessor across services, instrumenting every API call site behind a shared telemetry helper, bumping a logging library and migrating call sites to the new API, migrating a deprecated import path across a workspace.

The sweep flavor is the one most people get wrong. It _looks_ mechanical, so the temptation is to skip research and execute, and that's where per-site quirks bite. Research isn't a substitute for a plan. It's the task-scoped codebase snapshot the fix reads from, and on any non-trivial repo it's what keeps relevant code in the model's window and noise out.

For small fixes where research is the actual deliverable (the bug-fix and perf flavors above), stay hand-driven: there's no bundled workflow that starts at `research` and stops short of `implement`.

### Small+ to midsize, approach obvious

```
[discover?] → blueprint → implement → validate → commit
```

The gap between "fix in chat" and a full research-first chain. When the change is bigger than a single diff you'd apply in conversation but the approach is settled (you already know which files, which patterns, which seams), skip `research` entirely and start at `blueprint`. `blueprint` collapses design and planning into one pass; `implement` does the work; `validate` confirms the deliverable; commit.

No `code-review` either. This shape works precisely because there's nothing for review to surface that you wouldn't catch in `validate` or the diff itself.

Good fits:

- A new endpoint following an existing route pattern (controller + service + test mirror sibling routes)
- A second integration following an existing one (you've already shipped Stripe; PayPal is structurally identical)
- A UI screen built on a component library you've used end-to-end (form + list + detail, no novel layout work)
- A scheduled job that mirrors an existing one (different cron + different payload, same plumbing)
- A migration on a model whose shape you understand (add column, backfill, deploy)

**No workflow shortcut here, by design.** This scope is exactly where the pipeline machinery isn't worth its latency: hand-drive `blueprint → implement → validate → commit` with a pause between `blueprint` and `implement` to sanity-check the phases, or make the change in chat and run `/wf vet --staged` afterwards when you want a structured second pass.

### Mid-size feature

```
[discover?] → research → blueprint → implement
                                        ↓
                                     validate
                                        ↓
                                code-review ⇄ commit
```

`blueprint` collapses design and planning into one pass via vertical-slice decomposition. You get an implement-ready plan with developer checkpoints between phases.

**Workflow shortcut:** hand-drive the chain above, then `/wf vet main..HEAD` gives you the review-and-fix loop without further machinery. When the feature is big enough that decomposition itself is work, step up to `/wf build <input>` and let the pipeline run the slicing.

Good fits:

- A polymorphic provider system with a configuration UI (search, payments, storage; pick your domain)
- Pagination on an existing list endpoint end-to-end (UI + API + state)
- A CSV or PDF export pipeline (UI control → backend job → download)
- Adding rate limiting to an existing public API
- A "share via link" feature on existing documents: token generation, revocation, read-only view
- A search bar with autocomplete on an existing list view (frontend + backend endpoint)
- Replacing one linter or formatter with another while preserving configured behavior exactly

Two signals you've outgrown blueprint. **Revision count**: if you find yourself rewriting the plan portion of the blueprint more than once, the design and the plan should have been separate skills in their own context windows. **Token count**: once a single blueprint pushes past ~120K tokens of working context, the model starts degrading in subtle ways well before it hits the hard window limit, and splitting into `design` + `plan` gives each step fresh headroom.
### Large or architecturally load-bearing

```
[discover?] → research → [explore?] → design → plan
                                                 ↓
                                             implement
                                                 ↓
                                             validate
                                                 ↓
                                       code-review ⇄ commit
```

Split design and plan when the architecture is the hard part. `design` locks decisions and slices; `plan` sequences them into atomic phases with success criteria. `revise` (see below) is the feedback loop when implement, validate, or code-review surfaces a real flaw.

**Workflow shortcut:** `/wf build <input>` is built for exactly this scope. It runs the decomposition as parallel vertical slices, pauses once at a consolidated design review (accept or adjust the interfaces and data types before synthesis), and gates the plan and the code before a line is implemented. The hand-driven `design` + `plan` split stays the right call when you want a pause at every artifact rather than one design gate.

Good fits:

- A new optional subsystem end-to-end (for example, adding streaming audio capture, on-device transcription, and a live overlay to an existing desktop app)
- A greenfield product site with a design system, typed content collections, and a build-time pipeline sourcing content from a sibling repository
- A framework swap of a static site preserving every URL and visual pixel
- A strangler-fig parallel state layer applied as you touch files (Redux + sagas → React Query + Zustand)
- Migrating from one feature-flag provider to another, preserving every gate and rollout
- Unifying a contract surface across many files: replacing prose-shaped sections with a typed schema and adding lifecycle gates across consumers
- A refactor of a core package whose plan needs more than one revision pass
- Full implementation of a new widget end-to-end inside an editor: frontend, backend, persistence, runtime behavior

## Notes on the recipe

**`code-review` is positionally flexible.** It's the most token-hungry skill in the pipeline by a wide margin (parallel specialist agents, multi-lens reading of the whole diff); the cost is real and the output earns it. The position shown above is a default, not a constraint. Drop it in anywhere: as a gated step before commit when you want a hard quality bar, or ad-hoc against `staged` / `working` / a hash range / a PR branch whenever you want a second opinion.

**`code-review` ⇄ `commit` order is your call.** Review-then-commit folds findings into the message and lets you group fix-ups with the change. Commit-then-review locks the diff first and addresses findings in a follow-up commit. Pick the rhythm you're already in.

**`revise` is a feedback loop, not a step.** Surgically updates the plan after review feedback or mid-implement discoveries; preserves structure rather than rewriting from scratch. Use it whenever the plan needs to bend, not when it needs to break.

**Plan-review with a stronger model** *(advanced)*. When you're driving the pipeline with a smaller, cheaper model (GLM-5.2, Kimi K2.5, MiMo-V2-Pro), it's often worth handing the plan to a stronger model for a second-opinion review before kicking off implement. `rpiv-advisor` handles this in-flow, or you can drop the plan into a separate chat with the stronger model and ask it to assess completeness, actionability, and correctness. Feed the resulting feedback through `/skill:revise` so the plan absorbs the corrections in place. Not mandatory, overkill for small or mid-size work, but on large features it materially raises the quality of what comes out of implement. The earlier the catch, the cheaper the fix: a plan-level miss costs you a re-plan; the same miss after implement costs you a redo.

To make that split permanent rather than a manual swap, pin the stronger model to the steps that earn it (`design`, `plan`, or the review stage) and let everything else stay cheap. → [Right-size the model](/docs/guides/right-size-the-model).

## The compounding part

The recipe is enough on day one. The rest is what compounds.

**Your work survives the session.** Chat scrollback dies on `/reload` or compaction; an artifact under `.rpiv/artifacts/<stage>/` doesn't. You pick up a fresh session, point it at the artifact, and continue from where you stopped. The same artifact is reviewable by a teammate, hand-editable by you, and consumable by a stronger model for plan-review.

**Each phase gets an unbiased pass.** A chat session that's been thinking about a problem for an hour anchors on its own framings. A skill reading the artifact reasons from scratch, which is the whole point, and it's why the rhythm produces output that fits the codebase rather than the model's training-set average. The same property is what makes automation tractable over time: a stable artifact format is something a downstream skill, a stronger model, or a scheduled job can read without rebuilding context.
**Your expertise stays in the building.** Reviewing AI output to the same bar you'd hold a teammate to needs the same context writing the code would have built. The pipeline pulls the driver back in at every artifact boundary by surfacing the things that need a human call: ambiguities at discover, design questions at design, architectural triage at plan, reviewer findings at code-review, the diff itself before commit. Staying current is a byproduct of resolving those moments, not of re-reading earlier artifacts. Skip that engagement and comprehension erodes cycle by cycle, with nothing in the codebase showing it.
## Next steps

- [Walk the chain](/docs/guides/first-skill-chain): the mid-size path demonstrated on a real example
- [Run a workflow](/docs/guides/run-a-workflow): hand the chain to `/wf` once the rhythm is muscle memory
- [Reset between skills](/docs/guides/reset-between-skills): the fresh-context rule for every transition
- [Onboard a project](/docs/guides/onboard-a-project): annotate a brownfield codebase before the first run
