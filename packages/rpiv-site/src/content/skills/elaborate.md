---
slug: elaborate
tagline: Writes implement-ready code into one phase of a synthesized plan, emitting a per-phase elaboration to `.rpiv/artifacts/elaborations/` that a deterministic splice folds back into the plan.
purpose: |
  Turns one phase's contract-level "what to change" into the *actual code to apply* — paste-ready blocks grounded in the current tree — without redesigning the phase or touching any sibling's files. Dispatched once per phase in parallel after `synthesize`; the `stitch-elaborations` program (0 LLM calls) splices the results back, and the code gate grades the spliced plan.
when_to_use:
  - Dispatched once per phase by the build pipeline's elaborate fanout, after the plan clears its gate.
  - A phase's Changes name files and symbols but not yet the code `implement` should apply.
  - Not standalone — the per-phase docs only matter once the splice folds them back into the plan.
  - Prefer `implement` directly when the plan's phases already embed elaborated code — re-elaborating a code-bearing plan adds nothing.
inputs:
  - name: plan + phase name
    required: true
    source: "`<plan-path> Phase N: <title>` — a plan under `.rpiv/artifacts/plans/` plus the single phase to elaborate"
    notes: A missing path or unparseable `Phase N` is a dispatch error, not a failing phase. All other phases belong to sibling lanes.
outputs:
  - artifact: Per-phase elaboration doc
    path: .rpiv/artifacts/elaborations/
    format: "markdown — `<plan-basename>__phase-<N>.md`, body exactly one verbatim `## Phase N: <title>` section with per-file code blocks and carried Success Criteria"
key_steps:
  - title: Read the whole plan, own one phase
    rationale: The `## Synthesis Notes` carry the reconciled cross-phase seams, and sibling phases' interfaces must be referenced by the shape `synthesize` already fixed — skimming them is required precisely so their code is never rewritten here.
  - title: Ground every change in the current tree
    rationale: The plan may have been written against a slightly older state — the emitted code anchors to the signatures, imports, and style that are actually there now, so `implement` can apply it without guessing.
  - title: Emit concrete, paste-ready code blocks per file
    rationale: Prose hand-waving ("handle appropriately", "etc.") is exactly what the code gate's actionability dimension fails — each block is the full function or the exact edit.
  - title: Carry the phase's Success Criteria intact
    rationale: The criteria are the contract `validate` runs later — a check may be tightened where the code makes it more concrete, but dropping or weakening one breaks downstream verification.
  - title: Preserve the verbatim phase heading
    rationale: The heading is the splice anchor — the `stitch-elaborations` program swaps the plan's section by exact phase number and title, so a renamed heading breaks the deterministic fold.
  - title: Resolve ambiguity yourself, on the record
    rationale: N lanes run concurrently, so the skill is non-interactive — a genuine blocker gets the most defensible call, recorded under `## Notes / Deferred`, and the grade panel catches a bad one.
related:
  upstream: [synthesize, plan]
  downstream: [implement]
---
