# Workflows and recipes

The four `/wf` pipelines `@juicesharp/rpiv-pi` contributes, and the hand-driven
skill chains to reach for when you don't want a whole pipeline.

`/wf` itself ships with [`@juicesharp/rpiv-workflow`](https://www.npmjs.com/package/@juicesharp/rpiv-workflow),
which `/rpiv-setup` installs. rpiv-pi registers its built-ins into that runner at
session start; if the runner is not installed, the built-ins simply do not appear.

## Using `/wf`

| Form | Effect |
| --- | --- |
| `/wf` | Preview every registered workflow |
| `/wf <name>` | Show one workflow's stage graph |
| `/wf <name> "<task>"` | Run it — every stage executes in a detached child session |
| `/wf @<run-id>` | Resume a run |

A run appears as a lane in the dock under your editor. You keep typing in the main
session while it works — see [lanes.md](./lanes.md).

## The four built-in workflows

### `vet`

`code-review → (blueprint → implement → validate → loop) | commit`

Examine changes that already exist — yours or a teammate's — and loop a fix cycle if
the review does not approve them.

### `polish`

`architecture-review → blueprint (per review phase, accumulating) → implement → validate → code-review → (blueprint loop | commit)`

Architecture-review-driven. Best when a large review can't be planned in one pass and
each phase's plan must build on the ones before it.

### `build`

`goal → research → slice → slice gate (+ fix loop) → design-slice (parallel fanout) → design-review → synthesize → plan gate → elaborate (parallel fanout) → re-grade → implement → validate → commit`

Your brief, sliced. It captures your brief verbatim as a goal artifact — the north star the
quality gates and `validate` anchor against — then decomposes the work into vertical
slices, designs each in parallel, takes one consolidated developer checkpoint on the
proposed interfaces, synthesizes hierarchically, and grades the plan before and after
code is elaborated into it. Three automated gates plus one human checkpoint.

### `ship`

`goal → research → plan → plan-cite-check → grade → implement → implement-scope-check → reconcile → validate → commit`

Ship a small, well-understood task in one lightweight forward pass. The verbatim brief is the goal artifact; a trimmed research stage (at most two `codebase-analyzer` dispatches — not a full `/skill:research` pass) grounds a single unsliced plan from `quick-plan`, which receives the verbatim goal alongside the research doc and must explicitly defer any goal ask it narrows out; a deterministic citation floor and one tier-independent three-dimension grade (correctness, completeness, architecture-fit — architecture-fit cannot be dropped from a light roster) gate the plan before `implement`. The citation floor stops the run only on a phase body edit missing from its `files:` declaration (an undeclared write corrupts implement's dependency derivation); every citation-resolution finding — unresolved path, ambiguity, line drift — is advisory (recorded on the verdict, severity `low`) and rides to the grade panel, whose correctness unit receives the floor's verdict as `--cite-check` and adjudicates each finding by symbol instead of the run dying over a resolver limitation. Every gate is stop-on-fail — no fix loops, confirm panels, snapshots, or code-elaboration lane — and a red gate surfaces as `stopped at <gate>: <reason>` in the end-of-run toast and lane recap (never a ✓); a goal-anchored `validate` judges the landing before `commit`. Best for tasks small enough to plan in one pass; prefer `build` for anything needing decomposition.

## Review loops

`vet` and `polish` gate on the numeric `blockers_count` a `code-review`
artifact reports: greater than zero routes back into a fix stage, zero routes to
`commit`. The runner's default backward-jump budget is 3, so a review loop runs at
most four times before the workflow stops looping.

## Hand-driven recipes

Skills compose without a workflow. Pick the entry point that matches your intent.

- **Capture intent before research** — `/skill:discover "<feature>"`. A
  one-question-at-a-time interview that settles goals, non-goals, requirements,
  acceptance criteria, and a decisions log into a Feature Requirements Document. Its
  decisions are inherited by `design` through `research`.
- **Form context before a task** — `/skill:research "<topic>"`, or
  `/skill:research .rpiv/artifacts/discover/<latest>.md` if you ran discover first.
  Produces a high-signal subspace of the codebase, ready to feed the next prompt.
- **Compare approaches before designing** — `/skill:explore "<problem>"` →
  `/skill:design <solutions artifact>`. Use when several implementations are valid;
  the solutions artifact is a first-class input to `design`.
- **One-shot plan from research** — `/skill:research` → `/skill:blueprint` →
  `/skill:implement`. Fuses design and plan into a single pass with the same
  slice-by-slice rigor and a lighter subagent fan-out. Pick `design` → `plan` instead
  when the design is itself a deliverable someone else reviews.
- **Full feature build** — `/skill:discover` → `research` → `design` → `plan` →
  `implement` → `validate` → `code-review` ↔ `commit`. Jump in at any stage if you
  already have the input artifact.
- **Investigate a bug** — `/skill:discover "why does X fail"` →
  `/skill:research .rpiv/artifacts/discover/<latest>.md`. Fix straight from the
  research output when the change is too small to warrant a plan.
- **Adjust mid-implementation** — `/skill:revise <plan artifact>` → resume
  `/skill:implement`. Use when new constraints land after the plan is drafted.
- **Review before shipping** — `/skill:code-review` ↔ `/skill:commit`. Order is your
  call: review `staged` or `working` before committing to catch issues at the
  smallest blast radius, or commit first and review the branch (empty scope defaults
  to feature-branch vs default-branch, first-parent).
- **Audit a specific scope** — `/skill:code-review <commit|staged|working|hash|A..B|branch>`.
- **Review-driven plan revision** — `/skill:code-review` → `/skill:revise <plan>` →
  resume `/skill:implement`. For findings the existing plan can't absorb as spot fixes.
- **Audit a whole module** — `/skill:architecture-review <path>` →
  `/skill:blueprint <architecture-review artifact>`, one phase at a time. Or run
  `/wf polish` and let the workflow drive the same loop.
- **Hand off across sessions** — `/skill:create-handoff` → in a new session,
  `/skill:resume-handoff <doc>`.
- **Onboard a fresh repo** — `/skill:annotate-guidance` once, then use the pipeline
  normally. Use `annotate-inline` if the project follows the `CLAUDE.md` convention,
  or `migrate-to-guidance` to move from one to the other.
