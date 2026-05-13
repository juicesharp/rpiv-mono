---
title: "Pick your path"
description: "Three workflows mapped to feature scope. Small, mid, large."
section: "guides"
order: 0
---

The pipeline is a menu, not a script. Each skill writes a markdown artifact under `thoughts/shared/<stage>/` that the next skill reads, so you can stop, review, and resume between any two steps. The shape of your chain depends on **the scope of what you're shipping** and **what you already have in hand**.

Three entry points. Three paths.

## Three ways in

The chain proper starts at `/skill:research`. How you get there depends on what you have:

| You have | Get to research via |
|---|---|
| A spec, ticket, or sharp description | `/skill:research <free-text>`. No pre-phase needed. |
| A fuzzy idea | `/skill:discover` first. It interviews you one question at a time and writes a Feature Requirements Document that `/skill:research` then reads. |
| An idea, unsure of approach | `/skill:explore` first. Compares valid approaches side-by-side. The solutions document feeds `/skill:design` or `/skill:blueprint` directly, or routes through `/skill:research` first for codebase grounding. |

Both `discover` and `explore` are **optional pre-phases**. Skip them when the work is already sharp enough to describe in free-text.

## Three paths by scope

### Small feature or bug fix

```
[discover?] → research → fix in chat → commit
```

No planning step, no `/skill:implement` invocation. Open a fresh session, point the LLM at the research artifact (`thoughts/shared/research/<bug>.md`), and ask it to apply the fix. The research artifact IS the brief. When the diff looks right, hand it to `/skill:commit`.

### Mid-size feature

```
[discover?] → research → blueprint → implement
                                        ↓
                                     validate
                                        ↓
                                code-review ⇄ commit
```

`blueprint` collapses design and planning into one pass via vertical-slice decomposition. Implement-ready plan with developer micro-checkpoints between phases. This is the path [Walk the chain](/docs/guides/first-skill-chain) demonstrates end-to-end.

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

`design` and `plan` split into separate steps when architecture itself is the hard part. `design` locks the architectural decisions and vertical slices with developer micro-checkpoints; `plan` then sequences those into parallelized atomic phases with success criteria. `revise` (see below) is the feedback loop when any of `implement`, `validate`, or `code-review` surfaces a real flaw.

## Notes on the recipe

**`code-review` is positionally flexible.** It's the most token-hungry skill in the pipeline by a wide margin (parallel specialist agents, multi-lens reading of the whole diff), and it does A+ work for the cost. The position shown above is a default, not a constraint. Drop it in anywhere: as a gated step before commit when you want a hard quality bar, or ad-hoc against `staged` / `working` / a hash range / a PR branch whenever you want a second opinion.

**`code-review` ⇄ `commit` order is your call.** Review-then-commit folds findings into the message and lets you group fix-ups with the change. Commit-then-review locks the diff first and addresses findings in a follow-up commit. Pick the rhythm you're already in.

**`revise` is a feedback loop, not a step.** Surgically updates the plan after review feedback or mid-implement discoveries; preserves structure rather than rewriting from scratch. Use it whenever the plan needs to bend, not when it needs to break.

**Plan-review with a stronger model** *(advanced)*. When you're driving the pipeline with a smaller, cheaper model (GLM, Kimi, MiMo), it's often worth handing the plan to a stronger model for a second-opinion review before kicking off implement. Not mandatory, overkill for small or mid-size work, but on large features it materially raises the quality of what comes out of implement. The earlier the catch, the cheaper the fix: a plan-level miss costs you a re-plan; the same miss after implement costs you a redo.

## Next steps

- [Walk the chain](/docs/guides/first-skill-chain): the mid-size path demonstrated on a real example
- [Reset between skills](/docs/guides/reset-between-skills): the fresh-context rule for every transition
- [Onboard a project](/docs/guides/onboard-a-project): annotate a brownfield codebase before the first run
