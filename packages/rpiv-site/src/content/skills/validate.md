---
slug: validate
tagline: Independently re-runs each phase's success criteria against the working tree and emits a pass/fail validation report that catches half-finished phases the implement loop missed.
purpose: |
  A post-implementation audit. `validate` re-reads the plan, re-runs every `- [ ]` success-criterion against the actual working tree, and emits a structured report: pass/fail per criterion plus drift notes and follow-up tickets. Trust-but-verify after `implement` declares done.
when_to_use:
  - "`implement` has finished and you want third-party confirmation of completion."
  - You suspect drift between the plan's claims and the working tree.
  - Skip when there is no plan to validate against. There is nothing for `validate` to anchor on.
inputs:
  - name: plan path
    required: false
    source: Path to `.rpiv/artifacts/plans/*.md`. When omitted, the skill lists the 10 most recent files under `.rpiv/artifacts/plans/` and asks which plan to validate
  - name: --goal
    required: false
    source: Path to the user's original brief, captured verbatim at run start
    notes: Shortfalls are reported under Deviations from Plan, quoting the goal's actual wording; unstated scope is never inferred. A goal requirement the plan never carried still counts as a gap.
  - name: --baseline
    required: false
    source: JSON snapshot (with a `paths` array) of files already dirty before the run started
    notes: "Baseline paths are subtracted from the dirty set before working-tree scope criteria are judged; they are reported for visibility but never counted as a scope violation and never force `verdict: fail`. A missing or unreadable file falls back to judging the whole tree."
outputs:
  - artifact: Validation report
    path: .rpiv/artifacts/validation/
    format: "markdown from `templates/validation.md`; frontmatter carries `verdict: pass | fail` (plus `risk_rulings: [{ id, pass }]` when the plan had `risks:`), body is pass/fail per criterion with drift notes"
key_steps:
  - title: Discover context (current session OR fresh)
    rationale: Validation works either as an immediate audit (same session) or a cold audit (later run). Detecting the mode picks the right evidence-gathering path (session memory vs git log + diff).
  - title: Check pattern conformance and drift
    rationale: New code is compared against established sibling files (imports, naming, error handling, test structure), and the tree is grepped for drift the change leaves behind — renamed or removed terms lingering in comments, docs, or test descriptions, and documentation the change makes untrue. Catches "implemented but wrong shape" failures single-axis checks miss.
  - title: Re-run automated verification commands
    rationale: Every plan command (`make check test`, etc.) is re-run against the working tree, independent of whatever `implement` claimed. The plan's checklist is treated as a contract to be re-verified, not as ground truth.
  - title: Walk each phase and re-check its `- [x]` claims
    rationale: A checked box without matching code is a drift signal. Drift notes surface mid-phase pivots and unfinished work the implement loop signed off prematurely.
  - title: Emit pass/fail report with follow-ups
    rationale: Output is structured for action. Every failure gets a follow-up note so nothing falls through the cracks between validation and the next pass.
related:
  upstream: [implement]
  downstream: [code-review, commit]
---
