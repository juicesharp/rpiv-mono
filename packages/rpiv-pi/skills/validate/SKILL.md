---
name: validate
description: Verify that an implementation plan was correctly executed by running each phase's success criteria against the working tree and producing a validation report. Use after the implement skill completes, when the user asks to "validate the plan", wants a post-implementation audit, or needs to confirm a feature is fully shipped per its plan.
argument-hint: "[plan-path]"
allowed-tools: Read, Bash(git *), Bash(make *), Glob, Grep, Agent
shell-timeout: 10
---

# Validate

You are tasked with validating that an implementation plan was correctly executed, verifying all success criteria and identifying any deviations or issues.

## Input

`$ARGUMENTS` — optional path to a plan in `.rpiv/artifacts/plans/`. If omitted, branch on the recent-plans list in the Metadata block.

## Metadata

```!
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

   Spawn the agents below in parallel using the Agent tool. Wait for ALL agents to complete before proceeding.
   - **general-purpose** agent — Verify implementation details match plan specifications (analyzer role)
   - **general-purpose** agent — Verify implementation follows established codebase patterns (pattern-finder role)

   Example agent prompts:
   - "Analyze {component} and verify it implements {plan requirement} correctly"
   - "Find patterns similar to {new code} and check if conventions are followed"

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

### Step 3: Generate Validation Report

Create comprehensive validation summary:

```markdown
## Validation Report: {Plan Name}

### Implementation Status
✓ Phase 1: {Name} - Fully implemented
✓ Phase 2: {Name} - Fully implemented
⚠️ Phase 3: {Name} - Partially implemented (see issues)

### Automated Verification Results
✓ Build passes: `make build`
✓ Tests pass: `make test`
✗ Linting issues: `make lint` (3 warnings)

### Code Review Findings

#### Matches Plan:
- Database migration correctly adds {table}
- API endpoints implement specified methods
- Error handling follows plan

#### Deviations from Plan:
- Used different variable names in {file:line}
- Added extra validation in {file:line} (improvement)

#### Potential Issues:
- Missing index on foreign key could impact performance
- No rollback handling in migration

### Manual Testing Required:
1. UI functionality:
   - [ ] Verify {feature} appears correctly
   - [ ] Test error states with invalid input

2. Integration:
   - [ ] Confirm works with existing {component}
   - [ ] Check performance with large datasets

### Recommendations:
- Address linting warnings before merge
- Consider adding integration test for {scenario}
- Document new API endpoints

---

💬 Follow-up: if findings are localized, fix them and re-run `/skill:validate`. If findings imply plan-level changes, escalate to `/skill:revise <plan-path>` first.

**Next step:** `/skill:commit` — group the validated changes into atomic commits (skip if status is `needs_changes` — fix the gaps first, then re-run `/skill:validate`).

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

## Handle Follow-ups

- **Validate does not edit code or plans.** It produces a report. Fixes happen in implement; plan revisions happen in revise.
- **Localized gaps.** If findings are small and localized, fix them in-place and re-run `/skill:validate` for a fresh report.
- **Plan-level gaps.** If findings imply the plan itself is wrong (missing phases, wrong approach, untestable success criteria), escalate to `/skill:revise <plan-path>` first, then re-implement, then re-validate.
- **No append mode.** Each validation run produces a fresh report — there is no `## Follow-up` append. The previous block's `Next step:` stays valid only when status is `complete`.

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
2. `/skill:commit` - Create atomic commits for changes
3. `/skill:validate` - Verify implementation correctness

The validation works best after commits are made, as it can analyze the git history to understand what was implemented.

Remember: Good validation catches issues before they reach production. Be constructive but thorough in identifying gaps or improvements.
