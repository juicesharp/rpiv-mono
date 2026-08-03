---
slug: plan
tagline: Sequences a design artifact into parallelized atomic phases with explicit success criteria, written to `.rpiv/artifacts/plans/`.
purpose: |
  Turns a finished design into phases sized for one verification loop each, with the success criteria that prove a phase is done. The plan is the contract `implement` executes against: no rediscovery, no re-deciding architecture mid-build.
when_to_use:
  - You have a `design` artifact and want it broken into runnable phases.
  - Phases need to be parallel-marked so multiple worktrees can advance concurrently.
  - The change is large enough that a single "implement everything" pass would be too coarse to verify.
  - Skip in favor of `blueprint` when mid-flight micro-checkpoints between phases matter. `blueprint` collapses `design` + `plan` into a single iterative pass.
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
    rationale: Architecture · File Map · Ordering Constraints · Verification Notes are the only valid phasing inputs. Anything not in the design is out of scope for this pass. Re-evaluation would break the design's authority.
  - title: "Inherit phase boundaries 1:1 from the design's `## Slices`"
    rationale: "Slice ≡ phase, 1:1 — no merging, splitting, or reordering. The slice-verifier already validated each slice's atomicity and criteria/code alignment at design Step 6.2; recomposing here would discard that guarantee. Ordering Constraints and File Map are reference material only, and parallelism annotations carry forward from them when slices have no inter-dependency. Boundary changes are out of scope for `plan` — they go back to `design`."
  - title: Announce the inherited phase structure (no question asked)
    rationale: "Step 2 prints the inherited slice→phase list as confirmation only — no recomposition options and no developer question at this step. Boundary changes are out of scope: a developer who wants different boundaries revisits `/skill:design` and re-decomposes."
  - title: Write skeleton, then fill code per phase via Edit
    rationale: Skeleton-first guarantees structural decisions happen up-front; per-phase `Edit` calls insert before/after code blocks from the design without rewriting prior phases. Lets long plans stream cleanly.
  - title: Pass Success Criteria through verbatim from the design's `## Slices`
    rationale: Criteria are authored at design Step 6.1 and verified by slice-verifier at 6.2 — re-authoring here would discard that guarantee. They land in the skeleton at Step 3 as `- [ ]` checkboxes that `implement` runs and `validate` re-runs. If the design's criteria look wrong, that is a design defect; do not patch in plan.
  - title: Dispatch artifact-code-reviewer and artifact-coverage-reviewer in parallel
    rationale: Step 4 is the single post-finalization quality gate for the whole `design → plan` pipeline — code review is deliberately deferred from design to here, where code, Success Criteria, and phasing are all visible in one artifact. `status` flips to `in-review` first; the merged severity-sorted table is persisted to the artifact even when both reviewers clear it.
  - title: Triage every finding with the developer, then flip to `ready`
    rationale: No finding is ever auto-applied — each row is applied, deferred, or dismissed by the developer and gets a `resolution`. Only then are `phases:`/`phase_count` rebuilt from the `## Phase N:` headings and `status` flipped to `ready`.
related:
  upstream: [design]
  downstream: [implement, validate]
---
