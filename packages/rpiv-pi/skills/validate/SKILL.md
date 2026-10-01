---
name: validate
description: Verify that an implementation plan was correctly executed by running each phase's success criteria against the working tree and producing a validation report. Use after the implement skill completes, when the user asks to "validate the plan", wants a post-implementation audit, or needs to confirm a feature is fully shipped per its plan.
argument-hint: "[plan-path] [--goal <path>] [--baseline <path>] [--scope <path>] [--acceptance <path>]"
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: validation
    data:
      type: object
      required: [verdict]
      properties:
        status:
          enum: [in-progress, in-review, ready]
        verdict:
          enum: [pass, fail]
        blockers:
          type: array
          items:
            type: object
            required: [command, file]
            properties:
              id:
                type: string
              command:
                type: string
              file:
                type: string
              line:
                type: number
  consumes:
    reads:
      plans: {}
    meta:
      world: working-tree
---

# Validate

You are tasked with validating that an implementation plan was correctly executed, verifying all success criteria and identifying any deviations or issues.

## Input

User input (raw): `$ARGUMENTS`

Expected shape: an optional plan path (usually under `.rpiv/artifacts/plans/`), optionally followed by `--goal <path>` (the user's original brief, captured verbatim at run start), `--baseline <path>` (the run-start snapshot of paths that were ALREADY dirty before the run touched anything — a JSON file with a `paths` array), `--scope <path>` (the workflow scope floor's verdict JSON — `{ verdict, findings: [{ detail, where }] }` — recording writes outside the plan's declared write-set for you to adjudicate), and/or `--acceptance <path>` (the goal-derived acceptance inventory — `items:` frontmatter, ids `a1…`, each with a runnable evidence `command` or a `manual` procedure — frozen before planning; you EXECUTE it in Step 2.10). Peel the `--goal`, `--baseline`, `--scope`, and `--acceptance` flags first; what remains is the plan path. Only if the user input above is empty, or no plan path remains after peeling, branch on the recent-plans list in the Metadata block.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
echo
echo "### recent (read only in case of empty user input)"
echo "recent plans:"
node "${SKILL_DIR}/../_shared/list-recent.mjs" .rpiv/artifacts/plans 10
```

## Execution Rules

Use the available tools needed to execute the plan's verification procedures, including shell commands, browser interactions, artifact inspection, and explicitly prescribed native workflows. Follow the host's authorization rules. This skill does not grant unavailable tools or additional permissions.

If a required capability is unavailable, record the affected criterion as unverified with the exact missing prerequisite. Continue independent checks.

## Steps

### Step 1: Input Handling and Context Discovery

When invoked:

1. **Determine context** — fresh or existing conversation?
   - If existing: review what was implemented in this session for context.
   - In either case, continue with the substeps below; existing context does not replace reading the selected plan.

2. **Locate the plan**:
   - If plan path provided, use it.
   - Otherwise, branch on the `recent plans:` listing in the Metadata block:
     - **Empty** — no plans under `.rpiv/artifacts/plans/`; ask the user for a path in prose.
     - **Exactly one entry** — confirm with `ask_user_question`: "Validate this plan?" with options "Validate `<filename>` (Recommended)" and "Pick a different path".
     - **Two or more entries** — present the top 4 filenames as `ask_user_question` options. The tool automatically appends a `Type something.` free-text row; do not list it manually.

3. **Read the implementation plan** completely

4. **Identify what should have changed**:
   - List all files that should be modified
   - Note all success criteria (automated and manual)
   - Identify key functionality to verify

5. **Gather implementation evidence**:

   **If `in_repo:` in the Metadata block is `no`:**
   - Skip git-based evidence gathering (git log, git diff).
   - Validate via file inspection and execution of the plan's automated and manual verification procedures.
   - Note in report: "Git history unavailable — validation based on file inspection and executed verification"; identify any checks that remain unverified.

   Otherwise:
   - `git log --oneline -n 20` — recent commits for implementation context.
   - `git diff <base>..HEAD` — where `<base>` covers the implementation commits (determine from `git log` above). Scope to specific paths if the diff is large.
   - The plan's own `#### Automated Verification:` commands — read them out of the plan and run them as-written. Do NOT hardcode `make` or any project-specific build tool here; the plan encodes the right commands per project (e.g. `npm run check`, `npm test`, `cargo test`, `pytest`).

6. **Check pattern conformance and drift**:
   - For each new or substantially rewritten file, Read an established sibling (same directory or role) and compare shape: imports, naming, error handling, test structure. Record only genuine divergences.
   - Grep for drift the change leaves behind: renamed or removed terms still appearing in comments, docs, or test descriptions; documentation the change makes untrue.
   - Report convention notes under `#### Pattern Conformance:`; stale references and invalidated statements under `#### Deviations from Plan:` or `#### Potential Issues:` by severity.

### Step 2: Systematic Validation

For each phase in the plan:

1. **Check completion status**:
   - Look for checkmarks in the plan (- [x])
   - Verify the actual code matches claimed completion

2. **Run automated verification**:
   - Execute each command from "Automated Verification"
   - Document pass/fail status
   - If failures, investigate root cause

3. **Execute manual verification**:
   - "Manual" describes the verification method, not who must perform it. Execute every manual criterion yourself when available tools and authorization permit. Do not hand an executable check to the user merely because the plan labels it manual.
   - Include both checked and unchecked criteria. A plan checkbox is a claim to verify, not evidence and not permission to skip the criterion.
   - Follow the stated procedure and expected outcome. Inspect actual behavior and resulting artifacts. When live execution is required, fixtures, mocks, historical runs, and passing unit tests are not substitutes.
   - For asynchronous work, await its authoritative terminal state and inspect the required outputs. A successful launch is not a successful verification.
   - Record each criterion's source location, procedure, expected outcome, observed outcome, evidence location, and result: passed, failed, or unverified. Record approved deferrals separately with their existing reason.
   - Ask the owner only for genuinely required inputs, authorization, or subjective acceptance decisions. Never invent owner input or infer acceptance from technical completion.
   - If a prerequisite is missing or the procedure cannot be completed, record unverified and the specific blocker. Do not weaken the criterion or silently defer it. Continue checks that do not depend on that prerequisite.
   - Verification may exercise the application and generate required outputs; it does not authorize implementation fixes or changes to plan criteria.

4. **Think deeply about edge cases**:
   - Were error conditions handled?
   - Are there missing validations?
   - Could the implementation break existing functionality?

5. **Scope working-tree criteria to the run's own delta** (only when `--baseline` was provided):
   - Read the baseline file's `paths` array — these paths were dirty BEFORE the run started (recorded by the workflow at run start; the commit skill fences them off the same way).
   - Any criterion judging what the work touched ("only these files touched", "no unrelated changes", diff-scope checks) is evaluated against the working tree MINUS the baseline paths: subtract every baseline path from the dirty set before comparing to the plan's file list.
   - Baseline paths are pre-existing, out-of-scope dirt — report them under a short "Pre-existing working-tree changes (baseline)" note for visibility, but NEVER count them as a scope violation or let them force `verdict: fail`.
   - A missing or unreadable baseline file: fall back to judging the whole tree (today's behavior) and say so in the report.

6. **Attribute whole-plan command failures before they force the verdict.** When a whole-plan (not per-phase) command fails, attribute each failing finding to its file:
   - If **every** failing file is outside the run's own delta — in the `--baseline` paths, or byte-identical to the merge base, verified per file with `git diff --quiet <base> -- <file>` (when the implementation is uncommitted — the workflow's normal case, validate runs before commit — `<base>` is simply `HEAD`) — the failure is pre-existing debt: the criterion was authored against an assumed-clean repo and is unachievable as written. Report it under `#### Potential Issues:` as "pre-existing at base — criterion unachievable as written", rule the criterion **not met, non-blocking**, and record it under `#### Deviations from Plan:` as a *plan* deviation (the criterion, not the implementation, deviated). Do NOT let such a failure alone force `verdict: fail`.
   - The evidence bar is mandatory: no `git diff --quiet` proof for a failing file, no downgrade — the failure blocks as usual.
   - Any failing finding inside the run's delta keeps normal behavior: the command fails, the verdict fails.

7. **Adjudicate scope-floor findings** (only when `--scope` was provided):
   - Read the verdict JSON. If `verdict` is `"pass"` or `findings` is empty, there are no floor findings to rule — but the quarantine-manifest check in the last bullet below **still applies**: a post-quarantine re-check threads a clean `pass` verdict, and the manifest is then the only surviving record of what the run's quarantine arm moved.
   - Each finding names a write outside the plan's declared write-set that the deterministic floor could not classify. Rule each one: an out-of-scope tracked write you can **explain** — a lockfile or generated artifact a declared phase's own commands produce, churn already listed in the `--baseline` paths — is a non-blocking note under `#### Potential Issues:`, quoting the explanation. A write that is **demonstrably the run's own in-goal work** — it implements a named phase's stated change and that phase's verification covers it — is also explained: record it under `#### Deviations from Plan:` as a plan deviation (the owning phase's `files:` is incomplete), non-blocking. An out-of-scope write you **cannot explain forces `verdict: fail`** and is reported as a scope violation (a phase escaped its declared `files:` and may have overwritten sibling work — or the write is not the run's work at all).
   - **Quarantine manifest — check unconditionally, whatever the verdict says.** Glob `.rpiv/artifacts/verdicts/scope-quarantine__*.json`. If a manifest exists, rule on **every** `moved` entry (the record accumulates across fix-loop rounds): each names a run-created undeclared file moved — never deleted — from `from` to `to` under `.rpiv/tmp/scope-quarantine/`. A moved **scratch** file (probe script, fixture, captured payload) is a non-blocking note. A moved file the **deliverable needs** — anything a phase's change references or a criterion exercises — means its phase forgot to declare it in `files:`: report it under `#### Deviations from Plan:`, name the quarantine path it can be restored from, and rule **`verdict: fail`** (the working tree is missing the file). Treat `refused` entries (paths the arm declined to move) the same way.

8. **Check goal conformance** (only when `--goal` was provided):
   - Read the goal file fully — it is the user's brief in their own words.
   - Verify the delivered result honors every explicit ask and constraint in it. A goal requirement the plan never carried is still a gap — the plan, not just the implementation, can deviate from the user.
   - Report shortfalls under **Deviations from Plan**, quoting the goal's actual wording; never infer unstated scope from it.

9. **Rule every plan risk flag** (when the plan carries a `risks:` frontmatter array):
   - The plan's `risks:` array (each `{ id, claim }`, described under `## Risk Flags`) is the structured channel of decisions the planner asked to have checked. You are REQUIRED to rule on each one against the actual implementation — not skip it.
   - For each flag, verify its `claim` against the delivered code (Read/Grep the relevant `file:line`) and record a `risk_rulings: [{ id, pass }]` entry — `pass: true` when the risk is unfounded or handled, `pass: false` when it is real and unaddressed in the shipped code.
   - **For a `disposition: verify-at-implement` flag**, do not just Read/Grep — RUN its declared `procedure` (the named command/test the plan's `owner` phase promised) against the shipped code and rule `pass: false` if that procedure fails. This is the phase that discharges the deferral the plan-grade panel accepted on trust; a deferred risk whose procedure now fails is exactly the un-addressed-defect class this gate catches. A mechanics (`claim_type: mechanics`) flag is verified against its shipped `file:line` as above.
   - **Any `pass: false` ruling forces `verdict: fail`** and is reported under **Potential Issues**, quoting the flag's claim. A flagged risk that shipped unaddressed is exactly the class of defect this gate exists to catch.

10. **Execute the acceptance inventory** (only when `--acceptance` was provided):
   - Read the inventory fully. Its `items:` are the goal-derived standard of completion, frozen BEFORE planning — the one executable measure the plan did not author, so it catches what the plan's own criteria structurally cannot: an ask the planning narrowed away. Cross-reference the plan's `acceptance:` disposition mapping when it carries one.
   - **An item the plan marked `deferred`** (with a reason, matching an `## Out of Scope` line): do not run its command; record the deferral under `#### Deviations from Plan:` as a non-blocking note quoting the reason — the deferral was legible and gate-approved. An item the plan never disposed of at all is judged exactly like an `implemented` one — silence does not defer.
   - **An item the plan marked `rebound`** (`command` + `reason` present; else undisposed): run the rebound command instead of the inventory's. Exit 0 ⇒ met, noted under `#### Deviations from Plan:` with the reason and both commands. Non-zero ⇒ fails like `implemented`, rebound command in the `blockers:` entry. Never run both and keep the passing one.
   - **An item with a `command`** (not deferred): RUN it as written from the repo root. Exit 0 ⇒ the item holds — record it met. Non-zero ⇒ the item fails: force **`verdict: fail`**, report it under **Deviations from Plan** quoting the item's `statement`, and add a `blockers:` entry for it (Step 3.2's shape — the item's `command` verbatim; attribute `file`/`line` to the in-delta file the command or the item's statement most directly names). A failing acceptance command with a sound premise is never "pre-existing debt" — the inventory is future-tense by construction. Only when the command itself is unrunnable as written (a path that never existed at any revision, a malformed invocation) rule the ITEM unmeasurable, non-blocking, under `#### Potential Issues:` — never silently rewrite the command into something weaker.
   - **An item with only a `manual` procedure** (not deferred): execute it using Step 2.3. Record the acceptance item ID and statement alongside its evidence in `### Manual Verification Results`. A failed or unverified item forces `verdict: fail`. Do not classify it as homework for the human or automatically non-blocking.

### Step 3: Write the Validation Report

1. **Determine metadata** (from the Metadata block at the top of this skill):
   - Filename: `.rpiv/artifacts/validation/<slug>_<plan-topic-kebab>.md` — `<slug>` is the second tab-separated field on line 1 of the Metadata block above; `<plan-topic-kebab>` is the plan's `topic:` frontmatter value lowercased and hyphen-joined.
   - `repository:` ← `repo:` label; `branch:` / `commit:` ← matching labels.
   - `date:` ← `<iso>` (first tab-separated field on line 1 of the Metadata block above, offset verbatim).
   - `author:` ← matching label (fallback: `unknown`).
   - `parent:` ← the plan path resolved in Step 1.
   - `tags:` ← `[validation, ...]` plus any tags carried from the plan's frontmatter.
   - `topic:` ← `"Validation of <plan topic>"`.

2. **Determine verdict** (`status` is always `ready` — written once):
   - `verdict: pass` — every phase marked `- [x]` in the plan is verified against the code, every automated command passes (excluding whole-plan failures ruled pre-existing/non-blocking per Step 2.6), no Deviations from Plan and no Potential Issues require action, every plan `risks:` flag ruled `pass`, every scope-floor finding and quarantine-manifest entry (Step 2.7) is explained, and every non-deferred `--acceptance` item with a command passed (Step 2.10).
   - `verdict: fail` — any phase fails verification, any automated command fails (excluding whole-plan failures ruled pre-existing/non-blocking per Step 2.6), any Deviations / Potential Issues list items that require action, **any plan risk flag ruled `pass: false`** (a flagged risk shipped unaddressed), **any scope-floor finding or quarantined/refused file you could not rule benign** (Step 2.7), or **any non-deferred acceptance item whose command fails** (Step 2.10).
   - A passing verdict additionally requires every required manual criterion and every non-deferred manual acceptance item to have passed.
   - Any required manual criterion that failed or remains unverified forces `verdict: fail`. Explain whether this represents an observed defect or an incomplete verification; do not present missing prerequisites as proven implementation defects.
   - Existing explicitly defined non-blocking exceptions remain applicable only to the checks they describe. Do not extend command-failure exceptions to manual criteria.
   - When the plan carried a `risks:` array, add a `risk_rulings: [{ id, pass }]` field to the report frontmatter — one ruling per flag.
   - When a blocking command failure is NOT already captured by a `pass: false` risk ruling — a whole-plan gate command, a phase's automated command failing on files inside the run's delta, a failing acceptance-item command (Step 2.10), or a reproducible command failure from manual verification — add a `blockers:` array to the report frontmatter, one entry per failing command: `blockers: [{ id: b1, command: "<the failing command, verbatim-runnable from the repo root>", file: "<in-delta file the failure attributes to>", line: <line> }]` (`file`/`line` come from the actual failure attribution, using Step 2.6 or Step 2.10 where applicable; number ids `b1`, `b2`, …). Use this field only for actual failing, reproducible commands that fit the existing schema and attribution rules. Never invent a command or implementation file for a browser observation, missing prerequisite, or owner decision. Omit the field when no eligible command failures remain.
   - For blocking manual failures without such a command, record the criterion, evidence, blocker, and required next action under `### Verification Blockers`. These failures still force `verdict: fail`. The workflow's remediation arm uses structured failing risk rulings and command blockers; a prose-only blocker must stop at the validation gate for resolution rather than receive a fabricated automatic-remediation handle.

3. **Write the artifact** using the Write tool (no Edit — this skill writes once per run). Read `templates/validation.md`, fill every `{placeholder}` with the values determined above and the observations gathered in Step 2, apply the section-omission rules in the template (omit `#### Pattern Conformance:` and `#### Potential Issues:` entirely when empty; keep all other sections and emit `None — …` literals when empty), and Write the result to the target path.

**What is NOT emitted to the artifact**: raw command or `git log` output, intermediate reasoning. The Findings subsections capture verified outcomes only.

### Step 4: Present Summary

```
Validation written to:
`.rpiv/artifacts/validation/{filename}.md`

Verdict: {pass | fail}
```

Follow-up footer:

---

💬 Follow-up: for localized implementation defects, use `/skill:implement` to fix them and re-run `/skill:validate`. For missing inputs, authorization, owner acceptance, or tool access, obtain the specific prerequisite and re-run the affected verification. If findings imply plan-level changes, escalate to `/skill:revise <plan-path>` first.

**Next step:** `/skill:commit` — group the validated changes into atomic commits (skip if `verdict: fail` — resolve defects or verification blockers first, then re-run `/skill:validate`).

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.

## Handle Follow-ups

- **Validate does not edit implementation code or plan checkboxes.** It executes verification and writes its results. Implementation fixes belong to implement; plan revisions belong to revise.
- **Localized gaps.** Use implement to fix localized implementation defects, then re-run `/skill:validate` for a fresh report.
- **Missing prerequisites.** Request the specific input, authorization, owner decision, or tool access needed. Keep the affected criterion unverified until its procedure is completed; do not send missing prerequisites into code remediation.
- **Plan-level gaps.** If findings imply the plan itself is wrong (missing phases, wrong approach, untestable success criteria), escalate to `/skill:revise <plan-path>` first, then re-implement, then re-validate.
- **No append mode.** Each validation run produces a fresh report — there is no `## Follow-up` append. The previous block's `Next step:` stays valid only when `verdict: pass`.

## Working with Existing Context

If you were part of the implementation:
- Review the conversation history
- Check your todo list for what was completed
- Validate the full selected plan and supplied acceptance inventory. Use session history as context, not as a limit on verification coverage.
- Be honest about any shortcuts or incomplete items

## Important Guidelines

1. **Be thorough but practical** - Focus on what matters
2. **Run all automated checks** - Don't skip verification commands
3. **Document everything** - Both successes and issues
4. **Think critically** - Question if the implementation truly solves the problem
5. **Consider maintenance** - Will this be maintainable long-term?
6. **Distinguish temporary scratch from required verification artifacts** - Temporary drivers and fixtures belong under `.rpiv/tmp/` (exempt from the workflow's scope floor) or outside the repository. The floor counts **untracked** files too (`git status -uall`): scratch left elsewhere can be flagged as an undeclared write. Remove temporary scratch when finished, but first preserve any evidence cited by the report in a durable evidence location. Preserve required native run artifacts and application outputs in their prescribed locations; do not relocate or delete them as scratch. Record verification-created outputs so scope review can distinguish them from unrelated implementation changes. Preserve pre-existing artifacts.

## Validation Checklist

Always verify:
- [ ] Goal conformance checked when `--goal` was provided
- [ ] Working-tree scope criteria judged against tree-minus-baseline when `--baseline` was provided
- [ ] Scope-floor findings adjudicated AND the quarantine manifest checked (unconditionally) when `--scope` was provided
- [ ] Whole-plan command failures attributed (run's delta vs. pre-existing at base) before forcing the verdict
- [ ] All phases marked complete are actually done
- [ ] Automated tests pass
- [ ] Code follows existing patterns
- [ ] No regressions introduced
- [ ] Error handling is robust
- [ ] Documentation updated if needed
- [ ] Every required manual criterion was executed and passed
- [ ] Manual acceptance items were executed or explicitly deferred under the existing rules
- [ ] Failed and unverified checks have evidence, blockers, and next actions recorded

## Relationship to Other Skills

Recommended workflow:
1. `/skill:implement` - Execute the implementation
2. `/skill:validate` - Verify implementation correctness
3. `/skill:commit` - Create atomic commits for the validated changes

Validate runs against the working tree (staged or committed), so running it before commit avoids amend churn when fixing a `verdict: fail`.

Remember: Good validation catches issues before they reach production. Be constructive but thorough in identifying gaps or improvements.
