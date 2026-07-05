---
name: validate
description: Verify that an implementation plan was correctly executed by running each phase's success criteria against the working tree and producing a validation report. Use after the implement skill completes, when the user asks to "validate the plan", wants a post-implementation audit, or needs to confirm a feature is fully shipped per its plan.
argument-hint: "[plan-path] [--goal <path>]"
allowed-tools: Read, Bash(git *), Bash(make *), Glob, Grep, Agent
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

Expected shape: an optional plan path (usually under `.rpiv/artifacts/plans/`), optionally followed by `--goal <path>` (the user's original brief, captured verbatim at run start). Peel the `--goal` flag first; what remains is the plan path. Only if the user input above is empty, or no plan path remains after peeling, branch on the recent-plans list in the Metadata block.

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

## Steps

### Step 1: Input Handling and Context Discovery

When invoked:

1. **Determine context** — fresh or existing conversation?
   - If existing: review what was implemented in this session, then proceed to Step 2.
   - If fresh: continue with the substeps below.

2. **Locate the plan**:
   - If plan path provided, use it.
   - Otherwise, branch on the `recent plans:` listing in the Metadata block:
     - **Empty** — no plans under `.rpiv/artifacts/plans/`; ask the user for a path in prose.
     - **Exactly one entry** — confirm with `ask_user_question`: "Validate this plan?" with options "Validate `<filename>` (Recommended)" and "Pick a different path".
     - **Two or more entries** — present the top 4 filenames as `ask_user_question` options (a free-text "Other" row is appended automatically).

3. **Read the implementation plan** completely

4. **Identify what should have changed**:
   - List all files that should be modified
   - Note all success criteria (automated and manual)
   - Identify key functionality to verify

5. **Gather implementation evidence**:

   **If `in_repo:` in the Metadata block is `no`:**
   - Skip git-based evidence gathering (git log, git diff).
   - Validate via file inspection, the plan's `#### Automated Verification:` commands, and the plan checklist.
   - Note in report: "Git history unavailable — validation based on file inspection only".

   Otherwise:
   - `git log --oneline -n 20` — recent commits for implementation context.
   - `git diff <base>..HEAD` — where `<base>` covers the implementation commits (determine from `git log` above). Scope to specific paths if the diff is large.
   - The plan's own `#### Automated Verification:` commands — read them out of the plan and run them as-written. Do NOT hardcode `make` or any project-specific build tool here; the plan encodes the right commands per project (e.g. `npm run check`, `npm test`, `cargo test`, `pytest`).

6. **Spawn parallel research agents** to verify implementation:

   Spawn the agents below in parallel using the Agent tool — all in a **single assistant message with multiple Agent calls** (concurrent, synchronous). **Never `run_in_background`**: its completion can't re-drive a workflow session, so the skill ends its turn before writing the validation report and the stage fails with no artifact. Wait for ALL agents to complete before proceeding.

   **Analyzer agent:**
   - subagent_type: `codebase-analyzer`
   - Prompt: "Analyze {component} and verify it implements {plan requirement} correctly."

   **Pattern finder agent:**
   - subagent_type: `codebase-pattern-finder`
   - Prompt: "Find patterns similar to {new code} and check if conventions are followed."

### Step 2: Systematic Validation

For each phase in the plan:

1. **Check completion status**:
   - Look for checkmarks in the plan (- [x])
   - Verify the actual code matches claimed completion

2. **Run automated verification**:
   - Execute each command from "Automated Verification"
   - Document pass/fail status
   - If failures, investigate root cause

3. **Assess manual criteria**:
   - List what needs manual testing
   - Provide clear steps for user verification

4. **Think deeply about edge cases**:
   - Were error conditions handled?
   - Are there missing validations?
   - Could the implementation break existing functionality?

5. **Check goal conformance** (only when `--goal` was provided):
   - Read the goal file fully — it is the user's brief in their own words.
   - Verify the delivered result honors every explicit ask and constraint in it. A goal requirement the plan never carried is still a gap — the plan, not just the implementation, can deviate from the user.
   - Report shortfalls under **Deviations from Plan**, quoting the goal's actual wording; never infer unstated scope from it.

6. **Rule every plan risk flag** (when the plan carries a `risks:` frontmatter array):
   - The plan's `risks:` array (each `{ id, claim }`, described under `## Risk Flags`) is the structured channel of decisions the planner asked to have checked. You are REQUIRED to rule on each one against the actual implementation — not skip it.
   - For each flag, verify its `claim` against the delivered code (Read/Grep the relevant `file:line`) and record a `risk_rulings: [{ id, pass }]` entry — `pass: true` when the risk is unfounded or handled, `pass: false` when it is real and unaddressed in the shipped code.
   - **Any `pass: false` ruling forces `verdict: fail`** and is reported under **Potential Issues**, quoting the flag's claim. A flagged risk that shipped unaddressed is exactly the class of defect this gate exists to catch.

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
   - `verdict: pass` — every phase marked `- [x]` in the plan is verified against the code, every automated command passes, no Deviations from Plan and no Potential Issues require action, and every plan `risks:` flag ruled `pass`.
   - `verdict: fail` — any phase fails verification, any automated command fails, any Deviations / Potential Issues list items that require action, **or any plan risk flag ruled `pass: false`** (a flagged risk shipped unaddressed).
   - When the plan carried a `risks:` array, add a `risk_rulings: [{ id, pass }]` field to the report frontmatter — one ruling per flag.

3. **Write the artifact** using the Write tool (no Edit — this skill writes once per run). Read `templates/validation.md`, fill every `{placeholder}` with the values determined above and the observations gathered in Step 2, apply the section-omission rules in the template (omit `#### Pattern Conformance:` and `#### Potential Issues:` entirely when empty; keep all other sections and emit `None — …` literals when empty), and Write the result to the target path.

**What is NOT emitted to the artifact**: per-agent dispatch logs, raw `git log` output, intermediate reasoning. The Findings subsections capture verified outcomes only — the agent trace stays in the skill run, not the artifact.

### Step 4: Present Summary

```
Validation written to:
`.rpiv/artifacts/validation/{filename}.md`

Verdict: {pass | fail}
```

Follow-up footer:

---

💬 Follow-up: if findings are localized, fix them and re-run `/skill:validate`. If findings imply plan-level changes, escalate to `/skill:revise <plan-path>` first.

**Next step:** `/skill:commit` — group the validated changes into atomic commits (skip if `verdict: fail` — fix the gaps first, then re-run `/skill:validate`).

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.

## Handle Follow-ups

- **Validate does not edit code or plans.** It produces a report. Fixes happen in implement; plan revisions happen in revise.
- **Localized gaps.** If findings are small and localized, fix them in-place and re-run `/skill:validate` for a fresh report.
- **Plan-level gaps.** If findings imply the plan itself is wrong (missing phases, wrong approach, untestable success criteria), escalate to `/skill:revise <plan-path>` first, then re-implement, then re-validate.
- **No append mode.** Each validation run produces a fresh report — there is no `## Follow-up` append. The previous block's `Next step:` stays valid only when `verdict: pass`.

## Working with Existing Context

If you were part of the implementation:
- Review the conversation history
- Check your todo list for what was completed
- Focus validation on work done in this session
- Be honest about any shortcuts or incomplete items

## Important Guidelines

1. **Be thorough but practical** - Focus on what matters
2. **Run all automated checks** - Don't skip verification commands
3. **Document everything** - Both successes and issues
4. **Think critically** - Question if the implementation truly solves the problem
5. **Consider maintenance** - Will this be maintainable long-term?

## Validation Checklist

Always verify:
- [ ] Goal conformance checked when `--goal` was provided
- [ ] All phases marked complete are actually done
- [ ] Automated tests pass
- [ ] Code follows existing patterns
- [ ] No regressions introduced
- [ ] Error handling is robust
- [ ] Documentation updated if needed
- [ ] Manual test steps are clear

## Relationship to Other Skills

Recommended workflow:
1. `/skill:implement` - Execute the implementation
2. `/skill:validate` - Verify implementation correctness
3. `/skill:commit` - Create atomic commits for the validated changes

Validate runs against the working tree (staged or committed), so running it before commit avoids amend churn when fixing a `verdict: fail`.

Remember: Good validation catches issues before they reach production. Be constructive but thorough in identifying gaps or improvements.
