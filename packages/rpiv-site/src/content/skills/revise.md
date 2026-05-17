---
slug: revise
tagline: Surgically updates an existing implementation plan after review feedback, mid-implementation discoveries, or scope changes — preserves structure rather than rewriting.
purpose: |
  Lets a finished plan absorb new information without losing its shape. `revise` reads the existing plan, applies precisely the requested changes (add phase · adjust criteria · trim scope · split a phase), and leaves everything else identical. Use it instead of regenerating a plan from scratch when only part of it is wrong.
when_to_use:
  - Code-review findings recommend specific plan adjustments.
  - Implementation hit a blocker that requires a phasing change.
  - Scope grew or shrank mid-flight.
  - The change is to a **plan only** — for design changes, re-run `design`/`blueprint` to produce a fresh plan instead.
inputs:
  - name: plan path
    required: true
    source: Path to `.rpiv/artifacts/plans/*.md`
    notes: A review-artifact path is rejected with a hint pointing back to the plan.
  - name: feedback
    required: true
    source: Free-text describing the specific changes
outputs:
  - artifact: Same plan file, in-place edit
    path: same `.rpiv/artifacts/plans/*.md`
    format: structure preserved, surgical changes applied
key_steps:
  - title: Validate inputs — plan path vs. review path
    rationale: "Common mistake — passing a review artifact instead of the target plan. `revise` detects this and asks for the plan path explicitly so the wrong file is never edited."
  - title: Read the existing plan completely
    rationale: Surgical edits require full context of phases, ordering constraints, and success criteria. Reading without limit/offset prevents partial-view rewrites.
  - title: Categorize the requested change
    rationale: Each change category — add phase, adjust criteria, trim scope, split phase — maps to a different edit shape. Picking the category first prevents a one-line note from triggering a wholesale rewrite.
  - title: Ground the change against the live codebase
    rationale: Even surgical changes get re-checked against current code state — the codebase may have moved since the plan was written.
  - title: Apply via `Edit`, keep untouched sections intact
    rationale: In-place edits via `Edit` preserve byte-for-byte the rest of the file, so diffs are small and reviewable and the plan's identity stays stable.
related:
  upstream: [plan, blueprint, code-review, implement]
  downstream: [implement, validate]
---
