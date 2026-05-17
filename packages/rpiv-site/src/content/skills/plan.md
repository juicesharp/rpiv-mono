---
slug: plan
tagline: Sequences a design artifact into parallelized atomic phases with explicit success criteria, written to `.rpiv/artifacts/plans/`.
purpose: |
  Turns a finished design into phases sized for one verification loop each, with the success criteria that prove a phase is done. The plan is the contract `implement` executes against — no rediscovery, no re-deciding architecture mid-build.
when_to_use:
  - You have a `design` artifact and want it broken into runnable phases.
  - Phases need to be parallel-marked so multiple worktrees can advance concurrently.
  - The change is large enough that a single "implement everything" pass would be too coarse to verify.
  - Skip in favor of `blueprint` when mid-flight micro-checkpoints between phases matter — `blueprint` collapses `design` + `plan` into a single iterative pass.
inputs:
  - name: design artifact
    required: true
    source: Path to `.rpiv/artifacts/designs/*.md`
    notes: All architectural decisions must be settled; if Open Questions remain, `plan` stops and returns to `design`.
outputs:
  - artifact: Implementation plan
    path: .rpiv/artifacts/plans/
    format: markdown with `- [ ]` success-criteria checkboxes
key_steps:
  - title: Read the design artifact fully
    rationale: Architecture · File Map · Ordering Constraints · Verification Notes are the only valid phasing inputs. Anything not in the design is out of scope for this pass — re-evaluation would break the design's authority.
  - title: Decompose into worktree-sized phases
    rationale: Each phase must compile and pass tests independently, touch ~3–8 files, group coherent file changes together, and follow the design's ordering constraints. Independent phases are explicitly marked parallel so multiple worktrees can advance concurrently.
  - title: Confirm phase structure with the developer
    rationale: Phase count and granularity are checked *before* code blocks are written. Catches split/merge corrections cheaply — fixing structure after fill is expensive.
  - title: Write skeleton, then fill code per phase via Edit
    rationale: Skeleton-first guarantees structural decisions happen up-front; per-phase `Edit` calls insert before/after code blocks from the design without rewriting prior phases. Lets long plans stream cleanly.
  - title: Attach success criteria to every phase
    rationale: Each phase carries `- [ ]` checkboxes that `implement` and `validate` re-run. The criteria are what mean "done" — the plan's verification contract.
related:
  upstream: [design]
  downstream: [implement, validate]
---
