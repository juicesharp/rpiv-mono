---
name: remediate
description: Surgically repair a working tree whose validate run returned a failing verdict — re-run each failed verify-at-implement risk ruling's prescribed procedure and each structured blocker's failing command, apply the minimal localized code fix grounded in the validation report, then confirm it passes. Single-pass, no subagents, no self-review, no questions. Workflow-gated repair arm dispatched after a failing validate; use as a gate's repair stage.
argument-hint: "--plans <plan-path> --validation <report-path>"
allowed-tools: Read, Edit, Write, Bash(*), Glob, Grep
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: side-effect
    meta:
      effect: code-mutation
  consumes:
    reads:
      plans:
        meta:
          artifactKind: plan
      validation:
        meta:
          artifactKind: validation
---

# Remediate

You surgically repair a **working tree** that a validate stage judged `verdict: fail`. You do **not** re-validate the whole plan, re-run the project's full build/test suite, or rewrite anything broadly — you clear exactly the localized defects the failing risk rulings and structured blockers prescribe, and re-run each item's own `procedure`/`command` to confirm it now passes. One pass, non-interactive, side-effect only: you mutate code, never emit an artifact. The workflow loops you straight back to the validate gate, which re-judges; that is the only validation, so you do **not** self-review or ask for approval.

You are the tools/contract twin of `implement` (`Bash(*)` + `code-mutation`, side-effect, not an artifact) and the body-discipline twin of `amend` (single-pass, surgical, no subagents, no self-review, no questions).

## Input

`$ARGUMENTS` — flags the orchestrator wires from the gate's channels. Parse flag-style (order-agnostic), exactly like `amend`:

- **`--plans <plan-path>`** — the plan under `.rpiv/artifacts/plans/`. Its frontmatter carries the `risks:` array; a ruling's `id` joins to a flag there.
- **`--validation <report-path>`** — the failing validation report under `.rpiv/artifacts/validation/`. Its frontmatter carries `verdict` + `risk_rulings: [{ id, pass }]` and, when whole-plan gates failed, `blockers: [{ id, command, file, line }]`.

If `--plans` or `--validation` is missing, print an error and stop — it is a dispatch error, not a failing phase.

## Steps

1. **Read the plan and the report fully** (no limit/offset). From the report's frontmatter read `verdict`, the `risk_rulings: [{ id, pass }]` array, and the `blockers: [{ id, command, file, line }]` array (absent ⇒ empty); from the plan's frontmatter read the `risks:` array (each flag is `{ id, claim, … }`).
2. **Build the work-list — ONLY the report's failing risk rulings + structured blockers.** Take every `risk_rulings` entry with `pass === false`, and join each to the plan's `risks:` flag by `id`. A `pass: false` ruling whose `id` matches no plan flag has no `claim`/`procedure`/`owner` to ground a fix — treat it as a drift-escape (step 4). Then append every `blockers:` entry — each is a whole-plan/automated-command failure validate attributed with a runnable `command` and an in-delta `file`; its `command` plays the role of a ruling's `procedure` and it joins no plan flag. Never source work from the report body's Potential Issues / Deviations prose on its own: those tie to a work item only when a `risk_rulings` or `blockers` entry names it.
3. **Partition the work-list into fixable vs drift-escape.** A failed ruling is **fixable** ONLY when its joined plan flag carries ALL of:
   - `disposition: verify-at-implement` — the ruling the plan deferred to this exact repair arm;
   - a concrete, non-empty `procedure` — the named command/test the ruling's own verification runs (the `owner` phase promised it);
   - a numeric `owner` phase.

   Every other failed ruling — a `claim_type: mechanics` flag (cited `file:line`, no `procedure`), a bare `{ id, claim }` flag, or a flag missing `owner` — is a **drift-escape**: it has no executable procedure a localized fix can discharge, so an open-ended repair would be guessing.

   A `blockers` entry is **fixable** when it carries a concrete, non-empty `command` AND a `file` — the command is its procedure, the file its localization. An entry missing either is a **drift-escape**.
4. **Drift-escape gate (checked BEFORE any edit).** If the work-list is empty (`verdict: fail` with no `pass: false` risk ruling and no `blockers` entry at all), print `remediation not localized: no-prescribed-rulings`, edit nothing, and stop. If ANY failed ruling or blocker is non-fixable, print `remediation not localized: <item-id>` for each non-fixable item, edit nothing, and stop. Either way, do NOT print the success closing block.
5. **Repair pass — one cycle per fixable item (ruling or blocker), single-pass (no in-skill retry loop).** For each fixable item, in turn:
   - **Run its verification command** via `Bash`, verbatim — a ruling's `flag.procedure`, a blocker's `command`. Capture pass/fail.
   - **If it passes already** (the tree may have drifted since validate), the item is cleared — record it and move on (no edit).
   - **If it fails**, Read/Grep the report body items tied to that item's `id` (Risk Flag Rulings, Potential Issues, Automated Verification Results) and its grounding — a ruling's plan-flag `claim` + cited `file:line`, a blocker's own `file`/`line` — then apply the **minimal localized code fix** — the smallest edit grounded in the current tree that makes the command pass. Then **re-run the command** and record the result. One fix attempt per item; never loop, never widen the edit, never `ask_user_question`.
6. **Emit the result.** If every fixable item's command now passes, print the success closing block (below) — the run is fully cleared. If an item's command still fails after its one localized fix, it is not localized either: print `remediation not localized: <item-id>` for each un-cleared item and OMIT the success closing block; the fixes already applied to cleared items stand (single-pass), and re-validate will catch what remains.

## Hard rules

- **Drift-escape, never an open-ended repair.** A failed ruling with no executable `procedure` (a `claim_type: mechanics` flag, a bare `{ id, claim }` flag), a `blockers` entry missing its `command` or `file`, an empty work-list when `verdict: fail` has no `pass: false` risk ruling and no `blockers` entry, or a fixable item whose command won't clear in one localized fix — each emits `remediation not localized: <item-id>` (or `remediation not localized: no-prescribed-rulings` for the empty case), and the success closing block is withheld. The upfront gate (non-fixable / empty) edits nothing and stops. Never `ask_user_question`, never widen into an un-prescribed repair, never re-run the project's whole build/test suite — that is the downstream validate gate's job.
- **Surgical, single-pass.** Touch only the code a fixable ruling's `procedure` gates; leave passing rulings' code and untouched files byte-for-byte. One fix attempt per ruling — no in-skill retry loop. The validate gate re-judges; that is the validation.
- **Fix the code, never the plan or any `.rpiv/artifacts/` document.** Remediate mutates the working tree only. Reading the plan/report to locate a ruling is required; editing the plan, the report, or any artifact is out of scope (that is amend's / revise's authority). The embedded code blocks in a spliced plan are the plan's own content too — remediate does not edit them either; it edits the repo files the ruling's `procedure` exercises.
- **Never touch code a passing ruling owns.** A `pass: true` ruling's cited area is verified-correct; editing it risks regressing a cleared dimension.
- **Repo-located scratch lives under `.rpiv/tmp/`, nowhere else.** Any file you create that is not a ruling's minimal code fix — a procedure driver script, a fixture, a captured payload — goes under `.rpiv/tmp/` (exempt from the workflow's scope floor) or outside the repo entirely. The floor counts **untracked** files too (`git status -uall`): a scratch file left at the repo root or in any undeclared directory is an undeclared write the next `implement-scope-check` flags. Delete repo-located scratch when its procedure is done regardless.
- **No subagents. No self-review. No `ask_user_question`.** Apply the localized fixes and re-run the procedures; the validate gate is the validation.

## Closing block

On a fully-cleared run (every failed ruling/blocker fixable, every command now passing), print:

```
Remediation complete: {N} failed item(s) addressed, {M} file(s) changed, {C} command(s) re-run (all pass).
Items: {id1} ✓, {id2} ✓ …
Outstanding: none.
```

Omit this block on any drift-escape — print only the `remediation not localized: …` line(s) and stop.
