---
slug: grade
tagline: Judges one artifact along one named quality dimension and writes a verdict JSON to `.rpiv/artifacts/verdicts/` as a single member of a gate's grading panel.
purpose: |
  Keeps each quality judgment *narrow and honest*: one panel member, one dimension, no fixes. The pipeline dispatches it once per dimension at each gate and folds the verdicts into an advance/loop decision, so a grader that drifted outside its dimension — or softened a real blocker — would corrupt the gate itself.
when_to_use:
  - Dispatched per dimension by the pipeline's three gates — slice-grade (`design-readiness`), plan-grade and code-grade (five artifact dimensions each).
  - You need a machine-readable pass/fail verdict on a research, slices, design, or plan artifact.
  - Not standalone — the pipeline, not the grader, folds per-dimension verdicts into a decision.
  - Prefer the slice-check program for structural invariants (dependency cycles, coverage conservation) — those are verified with 0 LLM calls, not graded.
inputs:
  - name: --dimension
    required: true
    source: Gate wiring
    notes: "`completeness`, `correctness`, `actionability`, `architecture-fit`, `pattern-following`, or `design-readiness` (slice maps only)."
  - name: --artifact
    required: true
    source: The artifact channel under review
  - name: --context
    required: false
    source: A supporting artifact, e.g. the research doc
    notes: Required for `architecture-fit`.
  - name: --goal
    required: false
    source: The user's verbatim brief, captured at run start
    notes: Read only for `completeness` and `correctness`; every other dimension ignores it. Goal-based findings must quote the goal's actual wording.
outputs:
  - artifact: Verdict
    path: .rpiv/artifacts/verdicts/
    format: "JSON — { dimension, pass, score, severity, findings[], feedback }"
key_steps:
  - title: Validate the flags, bail on a dispatch error
    rationale: A missing or unrecognized flag is a wiring problem, not a failing grade — emitting a verdict for a misdispatch would poison the gate's fold.
  - title: Read fully, then select the single rubric row
    rationale: Every other dimension is another panel member's job; staying inside the assigned row is what stops findings from double-counting across the panel.
  - title: Spot-check the live codebase where the rubric demands it
    rationale: "`correctness`, `architecture-fit`, `pattern-following`, and `design-readiness` claims can only be falsified against real code — grading the artifact's prose alone would judge fluency, not truth."
  - title: Rate severity honestly
    rationale: Severity is gate-load-bearing — only a `medium`+ finding blocks, even on `pass:false` — so soft-rating a real blocker ships a defect and inflating a cosmetic nit stalls the loop.
  - title: Write feedback as a surgical instruction set on fail
    rationale: The `feedback` field is the only thing `amend` reads — it must name exactly what to change (and for `design-readiness`, the exact re-cut seam) or the fix loop spins.
  - title: Emit machine-valid JSON, even on pass, and re-read it
    rationale: The gate parses verdicts with a strict JSON parser and collects the file to score the gate — a malformed or missing verdict bounces the flow into needless re-work even when the judgment was PASS.
related:
  upstream: [slice, synthesize, elaborate]
  downstream: [amend, slice]
---
