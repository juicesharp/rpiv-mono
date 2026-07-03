---
slug: slice
tagline: Decomposes a research-grounded feature into independent vertical slices and writes a machine-readable slice map to `.rpiv/artifacts/slices/` that a per-slice design fanout consumes.
purpose: |
  Cuts a feature into the smallest set of *independently designable* vertical slices (scope boundaries only, no architecture decisions) so that `design-slice` can fill each one in parallel. Also runs in re-slice mode with full structural authority (split an epic, break a cycle, redistribute coverage) when the design-readiness gate fails the map. It takes over there because a surgical reviser cannot split a slice.
when_to_use:
  - A `research` artifact exists and the feature needs decomposition before a per-slice design fanout.
  - Dispatched by the build pipeline between `research` and `design-slice`.
  - Re-slice mode (`--slices … --slice-verdicts …`) when the design-readiness gate failed the map and the fix is structural, not surgical.
  - Prefer `design` when decomposition and design can fold into one interactive pass. `slice` deliberately stops at scope boundaries.
inputs:
  - name: research artifact
    required: true
    source: Path to `.rpiv/artifacts/research/*.md`
    notes: Read FULLY, plus the key source files it cites. Every slice's `Draws on:` must cite a real `file:line` from it. A missing or non-research argument is a dispatch error, not a prompt to improvise.
  - name: --slices
    required: false
    source: Existing slice map under `.rpiv/artifacts/slices/`
    notes: Selects re-slice mode (non-interactive, no confirmation).
  - name: --slice-verdicts
    required: false
    source: Verdict JSONs under `.rpiv/artifacts/verdicts/` (repeatable)
    notes: Failing findings are joint constraints. A re-cut for one must not regress a dimension that was passing.
outputs:
  - artifact: Slice map
    path: .rpiv/artifacts/slices/
    format: markdown with machine-readable `slices:`, `coverage:`, and `slice_count` frontmatter
key_steps:
  - title: Read the research and its cited sources fully
    rationale: The research is the cut's grounding, and `design-slice` does NO discovery downstream. An under-cited `Draws on:` doesn't make a slice smaller, it starves the design pass.
  - title: Enumerate coverage units before cutting
    rationale: Freezing the brief's observable outcomes as ID'd units (`c1`, `c2`, …) up-front lets a program verify coverage conservation with 0 LLM calls. A later re-cut may redistribute units across slices but can never quietly drop one to shrink a slice.
  - title: Cut vertical, independent, right-sized slices
    rationale: Horizontal layers ("all the types") are valuable only once combined. Each slice must therefore be a user- or system-meaningful capability resolving to one coherent architecture decision, the exact bar the design-readiness gate later judges.
  - title: Resolve genuine decomposition forks with the developer
    rationale: A fork like "combine auth + session, or split them?" changes every downstream design, so it is asked one at a time with concrete options rather than guessed.
  - title: Confirm the decomposition once, then write
    rationale: A single approve/adjust question before writing is far cheaper than moving a slice boundary after N parallel designs have built on it.
  - title: In re-slice mode, re-cut structurally from the verdicts
    rationale: Splitting an epic, inverting a dependency edge, or renumbering exceeds what `amend` may touch. So the pipeline re-dispatches `slice` itself, with the verdict `feedback` as the instruction and the `coverage:` array carried forward verbatim.
related:
  upstream: [research]
  downstream: [grade, design-slice]
---
