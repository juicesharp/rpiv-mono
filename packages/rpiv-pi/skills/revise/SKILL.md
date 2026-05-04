---
name: revise
description: Surgically update an existing implementation plan in thoughts/shared/plans/ based on review feedback, mid-implementation discoveries, or new constraints, preserving structure and quality rather than rewriting. Use when the user wants a plan adjusted after code-review feedback, has hit a blocker mid-implement, scope changed, or asks to "revise the plan".
argument-hint: "[plan-path] [feedback]"
---

# Iterate Implementation Plan

You are tasked with updating existing implementation plans based on user feedback. You should be skeptical, thorough, and ensure changes are grounded in actual codebase reality.

## Initial Response

When this command is invoked:

1. **Parse the input to identify**:
   - Plan file path (e.g., `thoughts/shared/plans/2025-10-16_09-00-00_feature.md`)
   - Whether the user accidentally provided a review artifact path instead (e.g., `thoughts/shared/reviews/2025-10-16_10-00-00_feature.md`)
   - Requested changes/feedback

2. **Handle different input scenarios**:

   **If a REVIEW artifact path is provided**:
   ```
   `revise` updates implementation plans, not review artifacts.

   If you want to act on code-review findings, provide the target plan path plus the changes to make.

   Example:
   `/skill:revise thoughts/shared/plans/2025-10-16_09-00-00_feature.md "Address the findings from thoughts/shared/reviews/2025-10-16_10-00-00_feature.md by tightening validation in Phase 2 and expanding success criteria."`
   ```
   Wait for user input.

   **If NO plan file provided**:
   ```
   I'll help you iterate on an existing implementation plan.

   Which plan would you like to update? Please provide the path to the plan file (e.g., `thoughts/shared/plans/2025-10-16_09-00-00_feature.md`).

   If you're coming from `/skill:code-review`, pass the relevant plan path and summarize which findings should change the plan.

   Tip: You can list recent plans with `ls -lt thoughts/shared/plans/ | head`
   ```
   Wait for user input, then re-check for feedback.

   **If plan file provided but NO feedback**:
   ```
   I've found the plan at [path]. What changes would you like to make?

   For example:
   - "Add a phase for migration handling"
   - "Update the success criteria to include performance tests"
   - "Adjust the scope to exclude feature X"
   - "Split Phase 2 into two separate phases"
   ```
   Wait for user input.

   **If BOTH plan file AND feedback provided**:
   - Proceed immediately to Step 1
   - No preliminary questions needed

## Process Steps

### Step 1: Read and Understand Current Plan

1. **Read the existing plan file COMPLETELY**:
   - Use the Read tool WITHOUT limit/offset parameters
   - Understand the current structure, phases, and scope
   - Note the success criteria and implementation approach

2. **Understand the requested changes**:
   - Parse what the user wants to add/modify/remove
   - Identify if changes require codebase research
   - Determine scope of the update

### Step 2: Research If Needed

**Only spawn research tasks if the changes require new technical understanding.**

If the user's feedback requires understanding new code patterns or validating assumptions:

1. **Spawn parallel agents for research** using the Agent tool:
   **For code investigation:**
   - Use the **codebase-locator** agent to find relevant files
   - Use the **codebase-analyzer** agent to understand implementation details
   - Use the **codebase-pattern-finder** agent to find similar patterns

   **For historical context:**
   - Use the **thoughts-locator** agent to find related research or decisions in thoughts/
   - Use the **thoughts-analyzer** agent to extract insights from documents

   **Be EXTREMELY specific about directories**:
   - Include full path context in prompts

2. **Read any new files identified by research**:
   - Read them FULLY into the main context
   - Cross-reference with the plan requirements

3. **Wait for ALL agents to complete** before proceeding

### Step 3: Present Understanding and Approach

Before making changes, confirm your understanding:

```
Based on your feedback, I understand you want to:
- [Change 1 with specific detail]
- [Change 2 with specific detail]

My research found:
- [Relevant code pattern or constraint]
- [Important discovery that affects the change]

I plan to update the plan by:
1. [Specific modification to make]
2. [Another modification]

Does this align with your intent?
```

Use the `ask_user_question` tool to confirm before editing. Question: "[Summary of planned modifications]. Proceed with these edits?". Header: "Changes". Options: "Proceed (Recommended)" (Apply the planned changes to the existing plan); "Adjust approach" (Modify what will be changed before editing); "Show me first" (Show the exact text changes before applying).

### Step 4: Update the Plan

1. **Make focused, precise edits** to the existing plan:
   - Use the Edit tool for surgical changes
   - NEVER use Write tool - plan files already exist, use Edit tool only
   - Maintain the existing structure unless explicitly changing it
   - Keep all file:line references accurate
   - Update success criteria if needed

2. **Ensure consistency**:
   - If adding a new phase, ensure it follows the existing pattern
   - If modifying scope, update "What We're NOT Doing" section
   - If changing approach, update "Implementation Approach" section
   - Maintain the distinction between automated vs manual success criteria
   - If the plan has YAML frontmatter, update `last_updated` to today's date and `last_updated_by` to your name

3. **Preserve quality standards**:
   - Include specific file paths and line numbers for new content
   - Write measurable success criteria
   - Use project's build/test commands (`make`, `npm`, etc.) for automated verification
   - Keep language clear and actionable

### Step 5: Sync and Review

1. **Present the changes made**:
   ```
   I've updated the plan at `thoughts/shared/plans/[filename].md`

   Changes made:
   - [Specific change 1]
   - [Specific change 2]

   The updated plan now:
   - [Key improvement]
   - [Another improvement]

   Would you like any further adjustments?
   ```

2. **Be ready to iterate further** based on feedback

## Important Guidelines

1. **Be Skeptical**:
   - Don't blindly accept change requests that seem problematic
   - Question vague feedback - ask for clarification
   - Use AskUserQuestion tool for structured clarification when there are multiple valid approaches
   - Verify technical feasibility with code research
   - Point out potential conflicts with existing plan phases

2. **Be Surgical**:
   - Make precise edits, not wholesale rewrites
   - Preserve good content that doesn't need changing
   - Only research what's necessary for the specific changes
   - Don't over-engineer the updates

3. **Be Thorough**:
   - Read the entire existing plan before making changes
   - Research code patterns if changes require new technical understanding
   - Ensure updated sections maintain quality standards
   - Verify success criteria are still measurable

4. **Be Interactive**:
   - Confirm understanding before making changes
   - Show what you plan to change before doing it
   - Allow course corrections
   - Don't disappear into research without communicating

5. **Track Progress**:
   - Update todos as you complete research
   - Mark tasks complete when done

6. **No Open Questions**:
   - If the requested change raises questions, ASK
   - Research or get clarification immediately
   - Do NOT update the plan with unresolved questions
   - Every change must be complete and actionable

## Success Criteria Guidelines

When updating success criteria, always maintain the two-category structure:

1. **Automated Verification** (can be run by execution agents):
   - Commands that can be run: `make test`, `npm run lint`, etc.
   - Specific files that should exist
   - Code compilation/type checking

2. **Manual Verification** (requires human testing):
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases that are hard to automate
   - User acceptance criteria

## Subagent Invocation Best Practices

When spawning research agents:

1. **Only spawn if truly needed** - don't research for simple changes
2. **Parallel dispatch** — every `Agent(...)` call in the same assistant message (multiple tool_use blocks in one response), never one per turn. Call shape: `Agent({ subagent_type: "<agent-name>", description: "<3-5 word task label>", prompt: "<task>" })`.
3. **Each agent should be focused** on a specific area
4. **Provide detailed instructions** including:
   - Exactly what to search for
   - Which directories to focus on
   - What information to extract
   - Expected output format
5. **Request specific file:line references** in responses
6. **Wait for all agents to complete** before synthesizing
7. **Verify agent results** - if something seems off, spawn follow-up agents

## Example Interaction Flows

**Scenario 1: User provides everything upfront**
```
User: /skill:revise thoughts/shared/plans/2025-10-16_09-00-00_feature.md - add phase for error handling
Assistant: [Reads plan, researches error handling patterns, updates plan]
```

**Scenario 2: User provides just plan file**
```
User: /skill:revise thoughts/shared/plans/2025-10-16_09-00-00_feature.md
Assistant: I've found the plan. What changes would you like to make?
User: Split Phase 2 into two phases - one for backend, one for frontend
Assistant: [Proceeds with update]
```

**Scenario 3: User provides no arguments**
```
User: /skill:revise
Assistant: Which plan would you like to update? Please provide the path...
User: thoughts/shared/plans/2025-10-16_09-00-00_feature.md
Assistant: I've found the plan. What changes would you like to make?
User: Add more specific success criteria
Assistant: [Proceeds with update]
```

**Scenario 4: User passes a review artifact instead of a plan**
```
User: /skill:revise thoughts/shared/reviews/2025-10-16_10-00-00_feature.md
Assistant: `revise` updates implementation plans, not review artifacts. Please provide the target plan path plus the changes to make.
User: /skill:revise thoughts/shared/plans/2025-10-16_09-00-00_feature.md "Address the review findings by splitting Phase 2 and adding validation coverage"
Assistant: [Proceeds with update]
```
