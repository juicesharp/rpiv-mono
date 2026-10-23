# meta — a graph of self-correcting units

`meta` is an authoring layer over the rpiv-workflow engine. You write a workflow as an ordered list of **units**. Each unit is one loop:

```
produce ─► checks (code, first) ─► graders (LLM lenses, parallel) ─► gate
   ▲                                                                  │
   └──── fix (return record: unit·verdict·reason·evidence·scope) ◄────┘  while rounds < max
                                                   exhausted ─► halt | advance | escalate upstream
accepted run ─► learn ─► .rpiv/lessons/meta-lessons.json (standing constraints for the next run's producers)
```

The loop lives inside a unit, and the graph lives between units. `defineUnitGraph` compiles each unit into engine stages and routes: `<u>`, `<u>-fix`, `<u>-check`, `<u>-grade`, `<u>-gate`.

## Unit spec

```ts
defineUnitGraph({
  name: "my-flow",
  units: [
    ["research", { skill: "research", output: "research", checks: [minCitations(5)] }], // mandatory, first
    ["plan", {
      skill: "quick-plan",                  // skill XOR prompt (string or (ctx) => string)
      reads: ["research", "goal"],          // the only real edges
      output: "plans",                      // omit ⇒ side-effect unit (the working tree)
      checks: [planCitations],              // deterministic graders, run first
      graders: [{ lens: "correctness", rubric: "FAIL if …", context: ["research"] }],
      fix: { prompt: "Revise the plan in place …" },   // default: re-run producer + return record
      maxRounds: 3,                         // ≤ 4
      onExhausted: "halt",                  // | "advance" | { escalateTo: "<earlier unit>" }
    }],
  ],
  commit: true,
});
```

- `research` is the only mandatory unit, and it must come first.
- Every other unit is optional.
- Built-in: `/wf meta "<brief>"` runs research → acceptance → plan → implement → commit. Research is the mandatory first unit; every later unit is optional when you author your own graph.
- A project pack can import `defineUnitGraph` and `checks.ts` by absolute path.

## How it differs from `build`

| | `build` | `meta` |
|---|---|---|
| Unit of correction | Whole artifact. `amend` rewrites the plan (170–785 KB) and the whole 5–6 lens panel re-grades. | The failing items only. The return record lists them, with SCOPE = "touch only what the evidence cites". |
| Check order | Cite floor, then the LLM panel. Floors were mostly demoted to advisory. | Code checks first and short-circuiting. A red check never pays for a grader. |
| Graders | 5–6 dimensions tiered by size, plus a confirm pass, demote, and priors snapshots. | 1–2 lenses per unit. No confirm, no demote. |
| Stop condition | Jump budget 3 per destination, lap ceiling 8, a noisy `progress` label. | Per-unit `maxRounds`, plus an identical failure signature twice = stop early. |
| Exhausted | Halt. A human resumes. | halt, advance, or escalate to an upstream unit. |
| Decomposition | slice → design ×N → human design-review → subplans → plan → elaborate → splice. | None. One plan; implement fans out by phase. |
| Human | design-review checkpoint mid-graph. | Only at the end (commit). |
| Cross-run learning | None. Death scenes and priors are write-only or in-run. | `learn` records corrected failures, and producers read the top ones. |
| Size | ~35 stages, hand-wired routes. | 4 units → 17 stages, generated. |

### What the corpus says (52 real build runs in opendots)

- Every fix round was whole-batch: 90 amend rounds and 193 panel runs.
- Confirm upheld 40 of 40 failures (~6 min each).
- Demote demoted 0 of 193.
- 7 of ~45 multi-round loops regressed mid-loop.
- Every terminal halt was a corrector that could not reach the cause ("remediation left the working tree unchanged").

`meta` is built to test these points:
- scoped returns
- no confirm or demote
- stuck detection by signature
- upward escalation
- lessons that cross runs

## What `meta` gives up (and what an A/B will tell you)

- **No slicing or parallel design.** Large briefs may produce a weaker single plan. `build`'s decomposition is its strongest feature on big work.
- **Fewer lenses.** Actionability, pattern-following, architecture-fit and risk rulings are gone. The corpus shows they rarely failed (3–8%), but "rarely" is not "never".
- **No mid-graph human checkpoint.**
- **Lessons are raw failure reasons**, not distilled rules. Noisy until counts accumulate.

## A/B

```bash
node ab.mjs setup   ~/opendots air5-x "<brief>"            # two worktrees at HEAD, prints launch commands
# run each arm in its own terminal (pi, then the printed /wf line); they run in parallel
node ab.mjs compare ~/opendots air5-x --eval "cd packages/arclet-ui && swift test"
```

`compare` reports, per arm: outcome, wall clock, active time, sessions, tokens, stage visits and re-entries, rounds per unit, and the diff.

It also runs a **shared scorecard**: your `--eval` commands plus every arm's frozen acceptance commands, executed on every arm's tree. No arm is graded only by its own standard.

Write the `--eval` checks before looking at either result.
