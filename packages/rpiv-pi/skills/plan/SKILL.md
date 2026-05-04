---
name: plan
description: Convert a design artifact into a phased implementation plan with parallelized atomic phases and explicit success criteria, written to thoughts/shared/plans/. Use after the design skill when the user wants a design turned into an actionable, phase-by-phase plan to hand to the implement skill. Prefer plan when a straightforward phased breakdown is sufficient, and prefer blueprint when iterative vertical-slice micro-checkpoints between phases are needed.
argument-hint: [design artifact path]
---

# Write Plan

You are tasked with creating phased implementation plans from design artifacts. The design artifact contains all architectural decisions, full implementation code, and ordering constraints. Your job is to decompose that design into parallelized atomic phases with success criteria that implement can execute.

## Step 1: Read Design Artifact

When this command is invoked:

1. **Determine input mode**:

   **Design artifact provided** (path to a `.md` file in `thoughts/shared/designs/`):
   - Read the design artifact FULLY using the Read tool WITHOUT limit/offset
   - Extract: Architecture (the code changes), File Map, Ordering Constraints, Verification Notes, Performance Considerations, Scope
   - These are the inputs for phasing
   - Design decisions are settled — do not re-evaluate them
   - If the design has unresolved questions, STOP — tell the developer to return to design

   **No arguments provided**:
   ```
   I'll create an implementation plan from a design artifact. Please provide the path:

   `/skill:plan thoughts/shared/designs/2025-01-20_09-30-00_feature.md`

   Run `/skill:design` first to produce the design artifact. There is no standalone path.
   ```
   Then wait for input.

2. **Read any additional files mentioned** in the design's References — research documents, tickets. Read them FULLY for context.

## Step 2: Decompose into Phases

Read the Ordering Constraints and File Map from the design artifact. Apply phasing rules:

1. **Independently implementable**: Each phase must compile and pass tests on its own — no cross-phase runtime state
2. **Parallelizable**: Phases that don't depend on each other are explicitly marked (e.g., "Phases 2 and 3 can run in parallel")
3. **Worktree-sized**: Each phase should be appropriate for a single implement session in a worktree (~3-8 files changed, 1-3 components touched)
4. **Dependency-ordered**: Phase ordering follows the design artifact's Ordering Constraints
5. **Grouped coherently**: Related file changes go in the same phase (e.g., import change + hook setup + JSX modification for one component)

**If the design's Ordering Constraints say "all files independent"**, consider whether a single phase is appropriate. Don't split into phases just for the sake of it — if all changes can be done in one worktree session, one phase is correct.

Present phase outline and get developer feedback BEFORE writing details:

```
Here's my proposed plan structure based on the design at [path]:

## Implementation Phases:
1. [Phase name] - [what it accomplishes] ([N] files)
2. [Phase name] - [what it accomplishes] ([N] files)
3. [Phase name] - [what it accomplishes] ([N] files)

Phases [2] and [3] can run in parallel after Phase 1.
Total: [N] files across [M] phases.

Does this phasing make sense? Should I adjust the order or granularity?
```

Use the `ask_user_question` tool to confirm the phase structure. Question: "[N] phases, [M] total files. Does this structure work?". Header: "Phases". Options: "Proceed (Recommended)" (Write the detailed plan with code blocks and success criteria); "Adjust phases" (Split, merge, or reorder phases before writing); "Change scope" (Add or remove files from the plan).

Get feedback on structure before writing details.

## Step 3: Write Plan

After structure approval, write the plan **incrementally** — skeleton first, then fill each phase:

1. **Write the plan skeleton** to `thoughts/shared/plans/YYYY-MM-DD_HH-MM-SS_description.md`
   - Format: `YYYY-MM-DD_HH-MM-SS_description.md` where:
     - YYYY-MM-DD is today's date
     - HH-MM-SS is the current time in 24-hour format
     - description is a brief kebab-case description (may include ticket number)
   - Examples:
     - With ticket: `2025-01-08_14-30-00_ENG-1478-parent-child-tracking.md`
     - Without ticket: `2025-01-08_14-30-00_improve-error-handling.md`
   - The skeleton includes everything EXCEPT large code blocks: frontmatter, Overview, Desired End State, What We're NOT Doing, full phase structure (Overview, Changes Required with file paths and change summaries, Success Criteria, parallelism annotations), Testing Strategy, Performance Considerations, References. All phasing and structural decisions happen in this pass.

2. **Fill code blocks using Edit** — one phase at a time:
   - For each phase, Edit to insert the before/after code blocks from the design's Architecture section into the Changes Required subsections

3. **Use this template structure**:

```markdown
---
date: [Current date and time with timezone in ISO format]
planner: [User from injected git context]
git_commit: [Current commit hash]
branch: [Current branch name]
repository: [Repository name]
topic: "[Feature/Task Name]"
tags: [plan, relevant-component-names]
status: ready
design_source: "[path to design artifact]"
last_updated: [Current date in YYYY-MM-DD format]
last_updated_by: [User from injected git context]
---

# [Feature/Task Name] Implementation Plan

## Overview

[Brief description of what we're implementing and why. Reference design artifact.]

## Desired End State

[From design artifact's Desired End State / Summary — what "done" looks like and how to verify it]

## What We're NOT Doing

[From design artifact's Scope → Not Building]

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

```[language]
// Code from design artifact's Architecture section
```

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `pnpm typecheck`
- [ ] Linting passes: `pnpm lint`
- [ ] Tests pass: `pnpm test`

#### Manual Verification:
- [ ] [From design's Verification Notes — specific visual/behavioral check]
- [ ] [Component-specific verification]

---

## Phase 2: [Descriptive Name]

[Similar structure with both automated and manual success criteria...]

---

## Testing Strategy

### Automated:
- [Standard project checks from success criteria]

### Manual Testing Steps:
1. [From design's Verification Notes — converted to step-by-step]
2. [Another verification step]

## Performance Considerations

[From design artifact — copied directly]

## Migration Notes

[From design artifact — copied directly. If applicable: schema changes, data migration, rollback strategy, backwards compatibility. Empty if not applicable.]

## References

- Design: `thoughts/shared/designs/[file].md`
- Research: `thoughts/shared/research/[file].md`
- Original ticket: `thoughts/me/tickets/[file].md`
```

## Step 4: Review

1. **Present the plan location**:
   ```
   Implementation plan written to:
   `thoughts/shared/plans/[filename].md`

   [N] phases, [M] total file changes.

   Please review:
   - Are the phases properly scoped for worktree execution?
   - Are the success criteria specific enough?
   - Any phase that should be split or merged?

   When ready, run `/skill:implement thoughts/shared/plans/[filename].md Phase 1`
   ```

2. **Iterate based on feedback** — be ready to:
   - Split large phases
   - Merge small phases
   - Adjust success criteria
   - Reorder phases

3. **Continue refining** until the developer is satisfied

## Guidelines

1. **Trust the Design**:
   - Design decisions are fixed — do not re-evaluate architectural choices
   - If something in the design seems wrong, flag it to the developer
   - Don't silently change the approach or add scope
   - The design is the source of truth for what to build

2. **Be Interactive**:
   - Don't write the full plan in one shot
   - Get buy-in on phase structure first
   - Allow course corrections on granularity
   - Work collaboratively

3. **Be Practical**:
   - Focus on incremental, testable changes
   - Each phase should leave the codebase in a working state
   - Think about what can be verified independently
   - Include "what we're NOT doing" from the design's scope

4. **Phase for Worktrees**:
   - Each phase should be implementable in an isolated worktree
   - No phase should depend on another phase's uncommitted changes
   - If the design says "all independent," one phase may be correct
   - Don't split for the sake of splitting

5. **Track Progress**:
   - Use a todo list to track planning tasks
   - Mark planning tasks complete when done

6. **No Open Questions in Final Plan**:
   - If you encounter open questions during planning, STOP
   - If the design artifact has unresolved questions, send the developer back to design
   - Do NOT write the plan with unresolved questions
   - The implementation plan must be complete and actionable

## Success Criteria Guidelines

**Always separate success criteria into two categories:**

1. **Automated Verification** (can be run by execution agents):
   - Commands that can be run: `make test`, `npm run lint`, etc.
   - Specific files that should exist
   - Code compilation/type checking
   - Automated test suites

2. **Manual Verification** (requires human testing):
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases that are hard to automate
   - User acceptance criteria

**Format example:**
```markdown
### Success Criteria:

#### Automated Verification:
- [ ] Database migration runs successfully: `make migrate`
- [ ] All unit tests pass: `go test ./...`
- [ ] No linting errors: `golangci-lint run`
- [ ] API endpoint returns 200: `curl localhost:8080/api/new-endpoint`

#### Manual Verification:
- [ ] New feature appears correctly in the UI
- [ ] Performance is acceptable with 1000+ items
- [ ] Error messages are user-friendly
- [ ] Feature works correctly on mobile devices
```

**Convert design's Verification Notes to success criteria:**
- Prose warnings → specific automated commands or manual steps
- "Test production builds" → `pnpm build && verify in built app`
- "Verify scrollbar appearance" → `[ ] Open [component], scroll, observe slim scrollbar`
- "Do NOT use X" → `grep -r "X" src/ should return 0 matches`

## Important Notes

- NEVER edit source files — this skill produces a plan document, not implementation
- Always read the design artifact FULLY before decomposing into phases
- The plan template must be compatible with implement — preserve the phase/success criteria structure
- If the design artifact has unresolved questions, STOP — send the developer back to design
- Code in the plan comes from the design artifact's Architecture section — do not invent new code
- **Frontmatter consistency**: Use snake_case for multi-word field names in plan frontmatter
