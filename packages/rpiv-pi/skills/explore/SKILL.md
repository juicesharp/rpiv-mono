---
name: explore
description: Analyze solution options for features or changes. Compares approaches with pros/cons and provides recommendations. Produces documents in thoughts/shared/solutions/. Use when multiple valid approaches exist.
argument-hint: [feature/change description]
---

# Research Solutions

You are tasked with analyzing solution options for new features or changes by invoking parallel skills and synthesizing their findings into actionable recommendations optimized for design consumption.

## Initial Setup:

When this command is invoked, respond with:
```
I'm ready to research solution options. Please provide:
- What feature/change you want to explore
- Any requirements or constraints you know about
- Reference to relevant ticket or research documents if available

I'll analyze the current codebase, generate solution options, and provide recommendations.
```

Then wait for the user's request.

## Steps

### Step 1: Read Mentioned Files

- If user mentions tickets, research docs, or other files, read them FULLY first
- **IMPORTANT**: Use Read tool WITHOUT limit/offset parameters
- **CRITICAL**: Read these files in main context before invoking skills
- Extract requirements, constraints, and goals
- Identify what problem we're solving

### Step 2: Generate Candidates and Dimensions

**Generate 2–4 named candidates** from three sources, then merge into one shortlist:

- **Ecosystem scan** — spawn `web-search-researcher` for any topic where the candidate space includes external libraries, frameworks, or services. Prompt it to return 2–4 named options with one-line "what it is" + canonical doc link per option. Skip only when the topic is wholly internal (e.g., "how to organize this service layer") and the orchestrator's design-space enumeration plus the user shortlist already cover the space.
- **Design-space enumeration** — orchestrator names abstract shapes from first principles when applicable (pub/sub vs direct-call vs event-bus; sync vs async; manual mapping vs auto-mapper). One-line "what it is" per shape.
- **User shortlist** — if the user pre-named candidates in the entry prompt ("compare TanStack Query vs SWR"), include those verbatim.

Merge to 2–4 candidates total. Name each with a short noun phrase ("TanStack Query", "Direct event bus"). Deduplicate.

**Default dimension list** (presented at Step 3; developer may drop irrelevant ones):

- **approach-shape** (hybrid) — what category of solution the candidate is, what core moving parts it requires.
- **precedent-fit** (codebase-anchored) — does the existing code already use this pattern; how many call sites would adopt the new option.
- **integration-risk** (codebase-anchored) — which existing seams the candidate would touch; what breaks if it lands.
- **migration-cost** (external-anchored for libraries; codebase-anchored for in-house code) — work to introduce the candidate plus work to remove the incumbent if there is one.
- **verification-cost** (codebase-anchored) — test/CI surface needed to make the candidate safe to adopt.
- **novelty** (external-anchored) — how recently the candidate emerged, ecosystem momentum, deprecation risk.

Hold the candidate set and default dimension list in working state for the Step 3 checkpoint. Do not dispatch fit agents yet.

### Step 3: Candidate Checkpoint

Present the candidate set and default dimensions to the developer before per-candidate fit dispatch.

1. **Show candidates and dimensions:**

   ```
   ## Candidates for: [Topic]

   1. [Candidate A] — [one-line what it is]
   2. [Candidate B] — [one-line what it is]
   ...

   Dimensions (default 6; drop any that don't apply):
   - approach-shape · precedent-fit · integration-risk
   - migration-cost · verification-cost · novelty
   ```

2. **Confirm via the `ask_user_question` tool with the following question:** "[N] candidates, [D] dimensions. Begin per-candidate fit dispatch?". Header: "Candidates". Options: "Proceed (Recommended)" (Begin per-candidate fit dispatch with all [N] candidates and all [D] dimensions); "Adjust candidates or dimensions" (Rename, add, or drop candidates; drop dimensions that don't apply); "Re-generate candidates" (Candidates look wrong — re-run Step 2 with adjusted scope).

3. **Handle developer input:**

   **"Proceed"**: lock the candidate × dimension set; advance to Step 4.

   **"Adjust candidates or dimensions"**: ask the follow-up free-text question with prefix `❓ Question:` — "Which candidates and dimensions should be added, dropped, or renamed?" — apply edits to the working set, re-present, and confirm again with the same three-option `ask_user_question`.

   **"Re-generate candidates"**: ask the follow-up free-text question with prefix `❓ Question:` — "What should be different in candidate generation? (narrower/wider scope, different ecosystem, exclude approach X, …)" — return to Step 2 with the updated scope, then re-enter Step 3.

   Loop until "Proceed" is selected.

### Step 4: Per-Candidate Fit Dispatch (parallel agents)

For each confirmed candidate, dispatch up to two agents in parallel — total ≤ 2 × N agents:

- **One `codebase-analyzer` per candidate** — when ≥1 kept dimension is codebase-anchored (precedent-fit, integration-risk, often migration-cost and verification-cost). The agent scores the candidate on every kept codebase-anchored dimension in a single pass, returning evidence per dimension with `file:line` references.
- **One `web-search-researcher` per candidate** — when ≥1 kept dimension is external-anchored (novelty, often migration-cost for libraries, approach-shape for ecosystem options). The agent scores the candidate on every kept external-anchored dimension in a single pass, returning evidence per dimension with doc/source links.

Skip either agent for a candidate when no dimension of that anchor-type was kept. Hybrid dimension `approach-shape` is scored by the orchestrator after both agents return, by combining their per-candidate findings.

**Per-candidate prompt shape** (use the same outer template, fill in candidate name and kept dimensions):

```
Candidate: [name] — [one-line what it is]
Topic: [topic from Step 1]

Score this single candidate on the following dimensions, each with concrete evidence ([file:line] for codebase, doc/source link for external). Report findings as one section per dimension.

Dimensions for this run:
- [dimension name] — [one-line of what to look for]
- ...

Do NOT compare against other candidates; another agent handles each one separately. Focus on depth of evidence for THIS candidate.
```

Wait for ALL agents to complete before proceeding.

**Coverage check**: every (candidate × kept-dimension) cell is filled — by an agent's evidence or by an explicit `null` ("does not apply to this candidate"). Cells silently dropped indicate a missing dispatch — re-run that candidate's agent.

### Step 5: Synthesize and Recommend

- Cross-reference per-candidate findings — fill the candidate × dimension grid with evidence per cell.
- Apply the fit filter qualitatively per candidate: a candidate "clears" when no kept dimension surfaces a blocking concern (integration-risk that breaks load-bearing seams, migration-cost that exceeds the topic's scope, verification-cost with no path to coverage).
- **If ≥1 candidate clears the fit filter**: pick the strongest, document rationale with evidence, and explain why alternatives weren't chosen. Identify conditions that would change the recommendation.
- **If every candidate fails the fit filter**: produce a "no-fit" recommendation — list each candidate's blocking dimension with evidence, recommend re-scoping the question or expanding the candidate pool, and set Step 7 frontmatter `confidence: low` and `status: blocked`.

### Step 6: Determine Metadata and Filename

- Filename format: `thoughts/shared/solutions/YYYY-MM-DD_HH-MM-SS_[topic].md`
  - YYYY-MM-DD_HH-MM-SS: Current date and time (e.g., 2025-10-11_14-30-22)
  - [topic]: Brief kebab-case description
- Repository name: from git root basename, or current directory basename if not a git repo
- Use the git branch and commit from the git context injected at the start of the session (or run `git branch --show-current` / `git rev-parse --short HEAD` directly)
- Researcher: use the User from the git context injected at the start of the session (fallback: "unknown")
- If metadata unavailable: use "unknown" for commit/branch

### Step 7: Generate Solutions Document

- Use the metadata gathered in step 6
- Structure the document with YAML frontmatter followed by content:

  ```markdown
  ---
  date: [Current date and time with timezone in ISO format]
  researcher: [Researcher name]
  git_commit: [Current commit hash]
  branch: [Current branch name]
  repository: [Repository name]
  topic: "[Feature/Problem]"
  confidence: high | medium | low
  complexity: low | medium | high
  status: ready | awaiting_input | blocked
  tags: [solutions, component-names]
  last_updated: [Current date in YYYY-MM-DD format]
  last_updated_by: [Researcher name]
  ---

  # Solution Analysis: [Feature/Problem]

  **Date**: [Current date and time with timezone from step 6]
  **Researcher**: [Researcher name from step 6]
  **Git Commit**: [Current commit hash from step 6]
  **Branch**: [Current branch name from step 6]
  **Repository**: [Repository name]

  ## Research Question
  [Original user query]

  ## Summary
  **Problem**: [What we're solving]
  **Recommended**: [Option name] - [One sentence why]
  **Effort**: [Low/Med/High] ([N days])
  **Confidence**: [High/Med/Low]

  ## Problem Statement

  **Requirements:**
  - [Requirement 1]
  - [Requirement 2]

  **Constraints:**
  - [Hard constraint - must respect]
  - [Soft constraint - should consider]

  **Success criteria:**
  - [What "done" looks like]

  ## Current State

  **Existing implementation:**
  [What exists with file:line references]

  **Relevant patterns:**
  - [Pattern 1]: `file.ext:line` - Used in [N] places
  - [Pattern 2]: `file.ext:line` - Used in [N] places

  **Integration points:**
  - `file.ext:line` - [Where feature hooks in]
  - `file.ext:line` - [Another integration point]

  ## Solution Options

  ### Option 1: [Name]
  **How it works:**
  [2-3 sentence description + implementation approach]

  **Pros:**
  - [Advantage with evidence from codebase]
  - [Advantage with evidence]

  **Cons:**
  - [Disadvantage with impact]

  **Complexity:** [Low/Med/High] (~[N] days)
  - Files to create: [N] (~[X] lines)
  - Files to modify: [N] (~[X] lines)
  - Risk level: [Low/Med/High]

  ### Option 2: [Alternative Name]
  [Same structure as Option 1]

  ### Option 3: [Another Alternative]
  [Same structure as Option 1]

  ## Comparison

  | Criteria | Option 1 | Option 2 | Option 3 |
  |----------|----------|----------|----------|
  | Complexity | [L/M/H] | [L/M/H] | [L/M/H] |
  | Codebase fit | [H/M/L] | [H/M/L] | [H/M/L] |
  | Risk | [L/M/H] | [L/M/H] | [L/M/H] |

  ## Recommendation

  <!-- Render exactly ONE of the two blocks below, based on Step 5's fit-filter outcome. -->

  **(A) When ≥1 candidate clears the fit filter:**

  **Selected:** [Option N]

  **Rationale:**
  - [Key reason with evidence]
  - [Key reason with evidence]
  - ...

  **Why not alternatives:**
  - Option X: [Reason]

  **Trade-offs:**
  - Accepting [limitation] for [benefit]

  **Implementation approach:**
  1. [Phase 1] - [What to build]
  2. ...

  **Integration points:**
  - `file.ext:line` - [Specific change]
  - `file.ext:line` - [Specific change]

  **Patterns to follow:**
  - [Pattern]: `file.ext:line`

  **Risks:**
  - [Risk]: [Mitigation]

  **(B) When every candidate fails the fit filter:**

  **No-fit:** every candidate surfaced a blocking concern on at least one kept dimension.

  **Per-candidate blockers:**
  - [Option 1]: [blocking dimension] — [evidence with file:line or doc link]
  - [Option 2]: [blocking dimension] — [evidence]
  - ...

  **Recommended next step:**
  - [Re-scope the question] — [how the topic should narrow/widen so candidates can clear]
  - OR [Expand the candidate pool] — [what new candidate sources to enumerate; e.g., named ecosystem option not surfaced by Step 2]

  **Frontmatter overrides:** set `confidence: low` and `status: blocked`.

  ## Scope Boundaries
  - [What we're building]
  - [What we're NOT doing]

  ## Testing Strategy

  **Unit tests:**
  - [Key test scenario 1]
  - ...

  **Integration tests:**
  - [End-to-end scenario 1]
  - ...

  **Manual verification:**
  - [ ] [Manual test 1]
  - [ ] ...

  ## Open Questions
  **Resolved during research:**
  - [Question that was answered] - [Answer with evidence from file:line]

  **Requires user input:**
  - [Business or design question] - [Default assumption for planning]

  **Blockers:**
  - [Critical unknown that prevents implementation] - [How to unblock]

  ## References

  - `thoughts/shared/research/[file].md` - [Context]
  - `src/file.ext:line` - [Similar implementation]
  - `thoughts/shared/[file].md` - [Historical decision]
  ```

### Step 8: Present Findings

- Present concise summary with clear recommendation
- Highlight key integration points
- Ask if they want to proceed to /skill:design with the chosen option or need clarification

### Step 9: Handle Follow-up Questions

- If user has questions, append to same document
- Update frontmatter: `last_updated` and `last_updated_by`
- Add section: `## Follow-up Analysis [timestamp]`
- Spawn additional agents as needed

## Important Notes

- Always use parallel subagent tool calls to maximize efficiency and minimize context usage
- Always spawn fresh research to validate current state - never rely on old research docs as source of truth
- Old research documents can provide historical context but must be validated against current code
- Generate 2-4 named candidates in Step 2; confirm them with the developer at Step 3 before per-candidate fit dispatch
- Web-search-researcher is a first-class Step 2 agent for ecosystem candidate-source — skip only when the topic is wholly internal and design-space enumeration plus user shortlist cover the space
- Per-candidate fit dispatch caps at two agents per candidate (one codebase-analyzer, one web-search-researcher) — skip either when no dimension of its anchor-type was kept
- Solutions documents should be self-contained with all necessary context
- Each agent prompt should be specific and focused on a single candidate scored on the kept dimensions
- Quantify pattern precedent — count usage in codebase, don't just say "follows pattern"
- Ground complexity estimates in actual similar work from git history
- Think like a software architect — option-shopping output is 2–4 comparable candidates plus an honest fit verdict
- Keep the main agent focused on synthesis and comparison, not deep implementation details
- Encourage agents to find existing patterns and examples, not just describe possibilities
- Resolve technical unknowns during research — don't leave critical questions for design
- **File reading**: Always read mentioned files FULLY (no limit/offset) before invoking skills
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read mentioned files first before invoking skills (step 1)
  - ALWAYS generate candidates and run the Step 3 checkpoint before per-candidate dispatch (steps 2 → 3 → 4)
  - ALWAYS wait for all per-candidate agents to complete before synthesizing (step 4)
  - ALWAYS gather metadata before writing the document (step 6 before step 7)
  - NEVER write the solutions document with placeholder values
