---
slug: architecture-review
tagline: Conducts a top-down, layer-by-layer architecture review of a module and produces a phased polish plan in `.rpiv/artifacts/architecture-reviews/` that starts the polish pipeline.
purpose: |
  Audits a whole module *structurally*: every file read fully, a uniform ten-dimension sweep per layer, every candidate finding triaged with the developer. It consolidates the accepted findings into a phased polish plan sized by agent-relevant signals. Language-agnostic: TypeScript, Java, .NET, Rust, Python, Go, or any other typed module.
when_to_use:
  - Before a 1.0 release, after a major refactor, or when a module has grown enough to warrant a structural audit.
  - You want a durable, phase-by-phase polish plan that `blueprint` can consume one phase at a time.
  - Re-invoke for a fresh artifact when the target has materially changed (new files, restructured layers). Follow-ups only append.
  - Prefer `blueprint` directly when you already know the one change to make. The review earns its cost by surfacing findings across a whole module.
inputs:
  - name: target path
    required: false
    source: Free-text (a file, directory, or module)
    notes: Empty input triggers a developer question to identify the target (module, subdirectory, single file). The target's manifest and README seed the context.
outputs:
  - artifact: Architecture review with consolidated polish plan
    path: .rpiv/artifacts/architecture-reviews/
    format: markdown with machine-readable `phases:` frontmatter (`n`, `title`, `depends_on`, `blast_radius`, `effort`), per-layer findings, tallies, methodology principles, and cross-cutting themes
key_steps:
  - title: Capture the target's real shape first
    rationale: Layers must mirror actual dependency direction. Manifest, import graph, and a full file enumeration reveal it; guessed role buckets would bias the whole walk.
  - title: Propose the layer split and get it approved before anything is written
    rationale: The entire review walks the approved layers top-down (facade at Layer 0, persistence last), so a wrong split poisons every subsequent finding. The developer approves it before the skeleton artifact exists.
  - title: Write the skeleton once, then edit progressively
    rationale: The artifact is the durable record between sessions. Each triaged finding is persisted the instant the developer decides, so an interruption never loses triage work to a deferred batch write.
  - title: Per layer, read fully, sweep ten dimensions, triage every candidate
    rationale: Selective reads bias findings toward what happened to load, and a candidate that cannot cite `file:line` plus a quote is not a finding. The developer, never the skill, judges abstraction value, so a zero-consumer deletion is always offered a keep option too.
  - title: Capture emergent methodology principles and cross-cutting themes
    rationale: Principles surface from triage itself (a reversed finding, a repeated choice), never from a pre-baked list. Naming them before theme synthesis is what lets the themes inherit the developer's actual reasoning.
  - title: Assemble the phased polish plan by agent-relevant signals
    rationale: Phases are sized for `blueprint` (finding counts, files touched, blast-radius mix, coordination need), not human-day estimates. Findings are topo-sorted so a rename lands before the directory split that uses the new name.
  - title: Hand off one phase at a time
    rationale: Per-phase `blueprint` invocations are the supported chaining pattern, and whole-artifact handoffs are explicitly not. The machine-readable `phases:` array is what drives the polish pipeline's per-phase iteration.
related:
  upstream: []
  downstream: [blueprint, plan]
---
