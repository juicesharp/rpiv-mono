---
slug: design-review
tagline: Runs the pipeline's one human design gate, presenting every per-slice design as a single consolidated summary the developer accepts or adjusts before synthesis.
purpose: |
  The fan-in point where the developer signs off on the proposed shape (data types, key interfaces, file map, scope) across *all* slices at once. Adjustments are applied surgically in place, and a changed contract is cascaded to its transitive dependents. `synthesize` then merges designs that already agree with the developer's call.
when_to_use:
  - Dispatched once by the pipeline between the design fanout and `synthesize`. Not standalone.
  - The interface surface across slices needs human sign-off before it hardens into a plan.
  - Prefer the re-slice path when an adjustment demands a fundamentally different approach. The skill's own escape hatch stops rather than fake a reconcile, because structural authority lives upstream in `slice`.
inputs:
  - name: --designs
    required: true
    source: Per-slice design docs under `.rpiv/artifacts/designs/` (repeatable)
    notes: Frontmatter `slice_n`, `slice_title`, `depends_on` build the dependency graph.
  - name: --slices
    required: true
    source: The slice map under `.rpiv/artifacts/slices/` the designs were cut from
    notes: Authoritative for `deps`, Scope, and Out-of-scope fences.
outputs:
  - artifact: The accepted design docs, re-emitted in place (edited ones with `last_updated` bumped)
    path: .rpiv/artifacts/designs/
    format: markdown, same files, same paths; no new artifact is created
key_steps:
  - title: Read every design and build the dependency graph
    rationale: Cascading a contract change requires knowing each slice's transitive dependents up-front. The graph comes from the designs' `depends_on`, cross-checked against the slice map.
  - title: Present one consolidated, dependency-ordered summary
    rationale: The developer reviews the whole proposed shape once, led by data types and interfaces (the contract being signed). Per-slice approval is exactly what the design fanout forbids, so it is never reintroduced here.
  - title: Ask accept-or-adjust, and loop until accepted
    rationale: This is the single human design gate in the build pipeline. Everything after it (synthesis, grading, elaboration) runs on machine gates, so ambiguity must not survive past this point.
  - title: Classify each adjustment as contract-local or contract-changing
    rationale: An internal approach tweak touches one doc; a change to published `## Key Interfaces` leaves every dependent stale. Without the cascade, the developer's choice silently loses the merge in `synthesize`.
  - title: Apply surgically, cascade, re-present
    rationale: Only what the developer cited is touched (the `amend` discipline). Dependents get their references patched plus a one-line note in `## Notes / Deferred`, and the updated summary comes back for re-approval. The loop is internal to the skill.
  - title: Stop honestly when a patch cannot reconcile
    rationale: A dependent that needs a different approach, not a renamed contract, means the cut itself is wrong. That is re-slice territory, and faking the reconcile would corrupt the plan downstream.
related:
  upstream: [design-slice]
  downstream: [synthesize]
---
