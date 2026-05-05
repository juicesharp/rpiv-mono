---
name: blueprint
description: Plan complex features by decomposing them into vertical slices (one slice equals one phase) with developer micro-checkpoints between phases, producing an implement-ready phased plan in thoughts/shared/plans/. Use for complex multi-component features touching 6+ files across multiple layers when iterative review between slices is valuable. Requires a research artifact or a solutions artifact (from explore). Prefer blueprint over plan when mid-flight micro-checkpoints matter, and prefer plan when a straightforward phased breakdown is enough.
argument-hint: [research artifact path]
---

# Plan

You are tasked with planning how code will be shaped for a feature or change AND emitting an implement-ready phased plan. Decompose the feature into vertical slices (one slice = one phase), generate code slice-by-slice with developer micro-checkpoints between slices, and write the final artifact directly into `thoughts/shared/plans/` for `/skill:implement` to consume.

**How it works**:
- Read input and key source files into context (Step 1)
- Spawn targeted research agents for depth analysis (Step 2)
- Identify ambiguities — triage into simple decisions and genuine ambiguities (Step 3)
- Holistic self-critique — review the combined design for gaps and contradictions (Step 4)
- Developer checkpoint — resolve genuine ambiguities one at a time (Step 5)
- Decompose into vertical slices holistically before generating code (Step 6)
- Generate code slice-by-slice with developer micro-checkpoints (Step 7)
- Verify cross-slice integration consistency (Step 8)
- Finalize the design artifact (Step 9)
- Review and iterate with the developer (Step 10)

The final artifact is implement-ready.

## Step 1: Input Handling

When this command is invoked:

1. **Read research artifact**:

   **Research artifact provided** (argument contains a path to a `.md` file in `thoughts/`):
   - Read the research artifact FULLY using the Read tool WITHOUT limit/offset
   - Extract: Summary, Code References, Integration Points, Architecture Insights, Precedents & Lessons, Developer Context, Open Questions
   - **Read the key source files from Code References** into the main context — especially hooks, shared utilities, and integration points the design will depend on. Read them FULLY. This ensures you have complete understanding before proceeding.
   - These become starting context — no need to re-discover what exists
   - Research Developer Context Q/As = inherited decisions (record in Decisions, never re-ask); Open Questions = starting ambiguity queue, filtered by dimension in Step 3

   **No arguments provided**:
   ```
   I'll plan a feature iteratively from a research artifact. Please provide:

   `/skill:blueprint [research artifact] [task description]`

   Research artifact is required. Task description is optional.
   ```
   Then wait for input.

2. **Read any additional files mentioned** — tickets, related designs, existing implementations. Read them FULLY before proceeding.

## Step 2: Targeted Research

This is NOT a discovery sweep. Focus on DEPTH (how things work, what patterns to follow) not BREADTH (where things are).

1. **Spawn parallel research agents** using the Agent tool:

   - Use **codebase-pattern-finder** to find existing implementations to model after — the primary template for code shape

   For integration wiring (inbound refs, outbound deps, config/DI/event registration), use the `## Integration Points` section already extracted from research in Step 1. For precedent context (similar past changes, blast radius, follow-up fixes, lessons), use the `## Precedents & Lessons` section already extracted from research in Step 1. Do NOT dispatch a fresh agent to re-map either surface.

   **Novel work** (new libraries, first-time patterns, no existing codebase precedent):
   - Add **web-search-researcher** for external documentation, API references, and community patterns
   - Instruct it to return LINKS with findings — include those links in the final design artifact

   Agent prompts should focus on (labeled by target agent):
   - **codebase-pattern-finder**: "Find the implementation pattern I should model after for [feature type]"

   NOT: "Find all files related to X" — that's discovery's job, upstream of this skill. NOT: "Analyze [component] integration" — the integration surface is in research's `## Integration Points`; if a specific anchor needs deeper inspection, defer to the on-demand `codebase-analyzer` dispatch in Step 5 (correction path) or Step 7a (mid-generation gap).

2. **Read all key files identified by agents** into the main context — especially the pattern templates you'll model after.

3. **Wait for ALL agents to complete** before proceeding.

4. **Analyze and verify understanding**:
   - Cross-reference research findings with actual code read in Step 1
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

## Step 3: Identify Ambiguities — Dimension Sweep

Walk Step 2 findings, inherited research Q/As, and carried Open Questions through six architectural dimensions that map 1:1 to the plan artifact's section coverage — the sweep guarantees downstream completeness. Add **migration** as a seventh dimension only if the feature changes persisted schema.

- **Data model** — types, schemas, entities
- **API surface** — signatures, exports, routes
- **Integration wiring** — mount points, DI, events, config
- **Scope** — in / explicitly deferred
- **Verification** — tests, assertions, risk-bearing behaviors
- **Performance** — load paths, caching, N+1 risks

For each dimension, classify findings as **simple decisions** (one valid option, obvious from codebase — record in Decisions with `file:line` evidence, do not ask) or **genuine ambiguities** (multiple valid options, conflicting patterns, scope questions, novel choices — queue for Step 5). Inherited research Q/As land as simple; Open Questions filter by dimension — architectural survives, implementation-detail defers.

**Pre-validate every option** before queuing it against research constraints and runtime code behavior. Eliminate or caveat options that contradict Steps 1-2 evidence. **Coverage check**: every Step 2 file read appears in at least one decision or ambiguity; every dimension is addressed (silently-resolved valid, skipped-unchecked not).

## Step 4: Holistic Self-Critique

Before presenting ambiguities to the developer, review the combined design picture holistically. Step 3 triages findings individually — this step checks whether they fit together as a coherent whole.

**Prompt yourself:**
- What's inconsistent, missing, or contradictory across the research findings, resolved decisions, and identified ambiguities?
- What edge cases or failure modes aren't covered by any ambiguity or decision?
- Do any patterns from different agents conflict when combined?

**Areas to consider** (suggestive, not a checklist):
- Requirement coverage — is every requirement from Step 1 addressed by at least one decision or ambiguity?
- Cross-cutting concerns — do error handling, state management, or performance span multiple ambiguities without being owned by any?
- Pattern coherence — do the simple decisions from Step 3 still hold when viewed together, or does a combination reveal a conflict?
- Ambiguity completeness — did Step 3 miss a genuine ambiguity by treating a multi-faceted issue as simple?

**Remediation:**
- Issues you can resolve with evidence: fix in-place — reclassify simple decisions as genuine ambiguities, or resolve a genuine ambiguity as simple if holistic review provides clarity. Note what changed.
- Issues that need developer input: add as new genuine ambiguities to the Step 5 checkpoint queue.
- If no issues found: proceed to Step 5 with the existing ambiguity set.

## Step 5: Developer Checkpoint

Use the grounded-questions-one-at-a-time pattern. Use a **❓ Question:** prefix so the developer knows their input is needed. Each question must:
- Reference real findings with `file:line` evidence
- Present concrete options (not abstract choices)
- Pull a DECISION from the developer, not confirm what you already found

**Question patterns by ambiguity type:**

- **Pattern conflict**: "Found 2 patterns for [X]: [pattern A] at `file:line` and [pattern B] at `file:line`. They differ in [specific way]. Which should the new [feature] follow?"
- **Missing pattern**: "No existing [pattern type] in the codebase. Options: (A) [approach] modeled after [external reference], (B) [approach] extending [existing code at file:line]. Which fits the project's direction?"
- **Scope boundary**: "The [research/description] mentions both [feature A] and [feature B]. Should this design cover both, or just [feature A] with [feature B] deferred?"
- **Integration choice**: "[Feature] can wire into [point A] at `file:line` or [point B] at `file:line`. [Point A] matches the [existing pattern] pattern. Agree, or prefer [point B]?"
- **Novel approach**: "No existing [X] in the project. Options: (A) [library/pattern] — [evidence/rationale], (B) [library/pattern] — [evidence/rationale]. Which fits?"

**Critical rules:**
- Ask ONE question at a time. Wait for the answer before asking the next.
- Lead with the most architecturally significant ambiguity.
- Every answer becomes a FIXED decision — no revisiting unless the developer explicitly asks.

**Choosing question format:**

- **`ask_user_question` tool** — when your question has 2-4 concrete options from code analysis (pattern conflicts, integration choices, scope boundaries, priority overrides). The user can always pick "Other" for free-text. Example:

  > Use the `ask_user_question` tool with the following question: "Found 2 mapping approaches — which should new code follow?". Header: "Pattern". Options: "Manual mapping (Recommended)" (Used in OrderService (src/services/OrderService.ts:45) — 8 occurrences); "AutoMapper" (Used in UserService (src/services/UserService.ts:12) — 2 occurrences).

- **Free-text with ❓ Question: prefix** — when the question is open-ended and options can't be predicted (discovery, "what am I missing?", corrections). Example:
  "❓ Question: Research's `## Integration Points` shows no background job registration for this area. Is that expected, or is there async processing not surfaced in the inbound/outbound sweep?"

**Batching**: When you have 2-4 independent questions (answers don't depend on each other), you MAY batch them in a single `ask_user_question` call. Keep dependent questions sequential.

**Classify each response:**

**Decision** (e.g., "use pattern A", "yes, follow that approach"):
- Record in Developer Context. Fix in Decisions section.

**Correction** (e.g., "no, there's a third option you missed", "check the events module"):
- Spawn targeted rescan: **codebase-analyzer** on the new area (max 1-2 agents).
- Merge results. Update ambiguity assessment.

**Scope adjustment** (e.g., "skip the UI, backend only", "include tests"):
- Record in Developer Context. Adjust scope.

**After all ambiguities are resolved**, present a brief design summary (under 15 lines):

```
Design: [feature name]
Approach: [1-2 sentence summary of chosen architecture]

Decisions:
- [Decision 1]: [choice] — modeled after `file:line`
- [Decision 2]: [choice]
- [Decision 3]: [choice]

Scope: [what's in] | Not building: [what's out]
Files: [N] new, [M] modified
```

Use the `ask_user_question` tool to confirm before proceeding. Question: "[Summary from design brief above]. Ready to proceed to decomposition?". Header: "Design". Options: "Proceed (Recommended)" (Decompose into vertical slices, then generate code slice-by-slice); "Adjust decisions" (Revisit one or more architectural decisions above); "Change scope" (Add or remove items from the building/not-building lists).

## Step 6: Feature Decomposition

After the design summary is confirmed, decompose the feature into vertical slices. Each slice is a self-contained unit: types + implementation + wiring for one concern.

1. **Decompose holistically** — define ALL slices, dependencies, and ordering before generating any code:

   ```
   Feature Breakdown: [feature name]

   Slice 1: [name] — [what this slice delivers]
     Files: path/to/file.ext (NEW), path/to/file.ext (MODIFY)
     Depends on: nothing (foundation)

   Slice 2: [name] — [what this slice delivers]
     Files: path/to/file.ext (NEW), path/to/file.ext (MODIFY)
     Depends on: Slice 1

   Slice 3: [name] — [what this slice delivers]
     Files: path/to/file.ext (NEW)
     Depends on: Slice 2
   ```

2. **Slice properties**:
   - End-to-end vertical: each slice is a complete cross-section of one concern (types + impl + wiring)
   - ~512-1024 tokens per slice (maps to individual file blocks)
   - Sequential: each builds on the previous (never parallel)
   - Foundation first: types/interfaces always Slice 1

3. **Confirm decomposition** using the `ask_user_question` tool. Question: "[N] slices for [feature]. Slice 1: [name] (foundation). Slices 2-N: [brief]. Approve decomposition?". Header: "Slices". Options: "Approve (Recommended)" (Proceed to slice-by-slice code generation); "Adjust slices" (Reorder, merge, or split slices before generating); "Change scope" (Add or remove files from the decomposition).

4. **Create skeleton artifact** — immediately after decomposition is approved:
   - Determine metadata: filename `thoughts/shared/plans/YYYY-MM-DD_HH-MM-SS_topic.md`, repository name from git root, branch and commit from the git context injected at the start of the session (fallbacks: "no-branch" / "no-commit"), planner from the injected User (fallback: "unknown")
   - Write skeleton using the Write tool with `status: in-progress` in frontmatter
   - **Include all prose sections filled** from Steps 1-5: Overview, Requirements, Current State Analysis, Desired End State, What We're NOT Doing, Decisions, Ordering Constraints, Verification Notes, Performance Considerations, Migration Notes, Pattern References, Developer Context, References
   - **Phase sections**: one `## Phase N: [slice name]` heading per slice from the decomposition (in slice order), each with `### Overview`, `### Changes Required:` (one `#### N. path/to/file.ext` subsection per file with empty code fence + NEW/MODIFY label), and `### Success Criteria:` (Automated + Manual placeholders — filled in Step 9)
   - **Plan History section**: list all phases with `— pending` status
   - This is the living artifact — all subsequent writes use the Edit tool

   **Artifact template sections** (all required in skeleton):

   - **Frontmatter**: date, planner, git_commit, branch, repository, topic, tags, `status: in-progress`, research_source, phase_count, unresolved_phase_count (initialized to phase_count, decrements as each phase's code is approved in Step 7d), last_updated, last_updated_by
   - **# [Feature Name] Implementation Plan**
   - **## Overview**: 2-3 sentences — what we're building and the chosen architectural approach. Settled decision, not a discussion.
   - **## Requirements**: Bullet list from ticket, research, or developer input.
   - **## Current State Analysis**: What exists now, what's missing, key constraints. Include `### Key Discoveries` with `file:line` references, patterns to follow, constraints to work within.
   - **## Desired End State**: Usage examples showing the feature in use from a consumer's perspective — concrete code, not prose.
   - **## What We're NOT Doing**: Developer-stated exclusions AND likely scope-creep vectors (alternative architectures not chosen, nearby code that looks related but shouldn't be touched).
   - **## Decisions**: `###` per decision. Complex: Ambiguity → Explored (Option A/B with `file:line` + pro/con) → Decision. Simple: just state decision with evidence.
   - **## Phase N: [slice name]** (one per slice, in slice order):
     - `### Overview`: one sentence describing what this phase delivers + parallelism note from `Depends on:` (e.g., "Depends on Phase 1; can run in parallel with Phase 3.").
     - `### Changes Required:` — one `#### N. path/to/file.ext` subsection per file in this slice. Each subsection has `**File**: path`, `**Changes**: [NEW | MODIFY — summary]`, and an empty code fence (filled in Step 7d). NEW files get full implementation. MODIFY files get only modified/added code — no "Current" block, the original is on disk.
     - `### Success Criteria:` with `#### Automated Verification:` and `#### Manual Verification:` subsections, each containing `- [ ] TBD` placeholder bullets (filled in Step 9 from Verification Notes).
   - **## Ordering Constraints**: What must come before what. What can run in parallel. (Carries the cross-phase view; per-phase parallelism note also lives in each Phase Overview.)
   - **## Verification Notes**: Carry forward from research — known risks, build/test warnings, precedent lessons. Format as verifiable checks (commands, grep patterns, visual inspection). Step 9 converts these to per-phase Success Criteria.
   - **## Performance Considerations**: Any performance implications or optimizations.
   - **## Migration Notes**: If applicable — existing data, schema changes, rollback strategy, backwards compatibility. Empty if not applicable.
   - **## Pattern References**: `path/to/similar.ext:line-range` — what pattern to follow and why.
   - **## Developer Context**: Record questions exactly as asked during checkpoint, including `file:line` evidence. Also record micro-checkpoint interactions from Step 7c.
   - **## Plan History**: Phase approval/revision log. `- Phase N: [name] — pending/approved as generated/revised: [what changed]`. implement ignores this section.
   - **## References**: Research artifacts, tickets, similar implementations.

   **Phase Changes Required format in skeleton**:
   - **NEW files**: `#### N. path/to/file.ext` + `**File**: path` + `**Changes**: NEW — [purpose]` + empty code fence (filled with full implementation in Step 7d)
   - **MODIFY files**: `#### N. path/to/file.ext:line-range` + `**File**: path` + `**Changes**: MODIFY — [summary]` + empty code fence (filled with only the modified code in Step 7d — no "Current" block, the original is on disk)

## Step 7: Generate Slices (Iterative)

Generate code one slice at a time. Each slice sees the fixed code from all previous slices.

**Before slice 1**: look at the decomposition. For slices whose code shape isn't already covered by Step 2's pattern-finder result (different layer, different file kind, different concern), dispatch additional **codebase-pattern-finder** calls in parallel — one assistant message, one tool call per slice that needs its own template. Slices whose shape matches a sibling reuse that sibling's result. Hold the returned templates in context for 7a; do not re-dispatch per slice during generation.

**For each slice in the decomposition (sequential order):**

### 7a. Generate slice code (internal)

Generate complete, copy-pasteable code for every file in this slice — but **hold it for the artifact, do NOT present full code to the developer**. The developer sees a condensed review in 7c; the full code goes into the artifact in 7d.

- **New files**: complete code — imports, types, implementation, exports. Follow the pattern template from Step 2.
- **Modified files**: read current file FULLY, generate only the modified/added code scoped to changed sections (no full "Current" block — the original is on disk)
- **Test files**: complete test suites following project patterns
- **Wiring**: show where new code hooks into existing code

If additional context is needed, spawn a targeted **codebase-analyzer** agent.

No pseudocode, no TODOs, no placeholders — the code must be copy-pasteable by implement.

**Context grounding** (after slice 2): Before generating, re-read the artifact's prior `## Phase N` sections for files this slice touches (a file may appear in earlier phases; if so, this phase extends or revisits it). The artifact is the source of truth — generate code that extends what's already emitted, not what you remember from conversation.

### 7b. Self-verify slice

Before presenting to the developer, cross-check this slice and produce a structured summary:

```
Self-verify Slice N:
- Decisions: [OK / VIOLATION: decision X — fix applied]
- Cross-slice: [OK / CONFLICT: file X has inconsistent types — fix applied]
- Research: [OK / WARNING: constraint Y not satisfied — fix applied]
```

If violations found: fix in-place before presenting. Include the self-verify summary in the 7c checkpoint presentation.

### 7c. Developer micro-checkpoint

Present a **condensed review** of the slice — NOT the full generated code. The developer reviews the design shape, not every line. For each file in the slice, show:

1. **Summary** (1-2 sentences): what changed, what pattern used, what it connects to
2. **Signatures**: type/interface definitions, exported function signatures with parameter and return types
3. **Key code blocks**: factory calls, wiring, non-obvious logic — the interesting parts that show the design decision in action

**Omit**: boilerplate, import lists, full function bodies, obvious implementations.
**MODIFY files**: focused diff (`- old` / `+ new`) with ~3 lines context. **Test files**: test case names only.

**If the developer asks to see full code**, show it inline — exception, not default.

Use the `ask_user_question` tool to confirm. Question: "Slice [N/M]: [slice name] — [files affected]. [1-line summary]. Approve?". Header: "Slice [N]". Options: "Approve (Recommended)" (Lock this slice, write to artifact, proceed to slice [N+1]); "Revise this slice" (Adjust code before proceeding — describe what to change); "Rethink remaining slices" (This slice reveals a design issue — revisit decomposition).

**Checkpoint cadence**: One slice per checkpoint. Present each slice individually, regardless of slice count.

### 7d. Incorporate feedback

**Approve**: Lock this slice's code and **Edit the artifact immediately**:
1. For each file in this slice, Edit the skeleton artifact to replace the empty code fence under that file's `#### N. path/...` subsection inside this slice's `## Phase N: [slice name]` section with the full generated code from 7a
2. If a later slice contributes to a file already filled by an earlier phase: emit a NEW `#### N. path/to/file.ext` subsection inside the later phase with only that phase's incremental changes (do NOT mutate the earlier phase's code fence — implement runs phases sequentially and the codebase state evolves between them). Each phase's code fence is the change set for that phase, applied on top of the codebase state after the previous phase.
3. After fill, verify within this phase: no duplicate function definitions inside the same code fence, imports deduplicated, exports list complete
4. Update the Plan History section: `- Phase N: [name] — approved as generated`
5. Decrement frontmatter `unresolved_phase_count` by 1
- Proceed to next slice

**Revise**: Update code per developer feedback. Re-run self-verify (7b). Re-present the same slice (7c). The artifact is NOT touched — only "Approve" writes to the artifact.

**Rethink**: Developer spotted a design issue. If a previously approved slice is affected, flag the conflict and offer cascade revision — developer decides whether to reopen (if yes, Edit the affected `## Phase N` entry).
Update decomposition (add/remove/reorder remaining slices) and confirm before continuing.

## Step 8: Integration Verification

After all phases are complete, review cross-phase consistency:

1. **Present integration summary** (under 15 lines):
   ```
   Integration: [feature name] — [N] phases complete

   Phases: [brief list of phase names and file counts]
   Cross-phase: [types consistent / imports valid / wiring complete]
   Research constraints: [all satisfied / N violations noted]
   ```

2. **Verify research constraints**: Check each Precedent & Lesson and Verification Note from the research artifact against the generated code. List satisfaction status.

3. **Confirm using the `ask_user_question` tool**. Question: "[N] phases complete, [M] files total. Cross-phase consistency verified. Proceed to finalize?". Header: "Verify". Options: "Proceed (Recommended)" (Finalize the plan artifact (fill Success Criteria, update status)); "Revisit phase" (Reopen a specific phase for revision — Edit the artifact after); "Add missing" (A file or integration point is missing — add to artifact).

## Step 9: Finalize Plan Artifact

The artifact was created as a skeleton in Step 6 and filled progressively in Step 7d. This step fills per-phase Success Criteria and finalizes.

1. **Verify all Phase code fences are filled**: Every `#### N. path/...` subsection inside every `## Phase N` must have a non-empty code block. If any are still empty (e.g., a slice was skipped), generate and fill them now.

2. **Fill per-phase Success Criteria from Verification Notes**. For each `## Phase N` section, replace the placeholder bullets in `### Success Criteria:` with concrete checks derived from this phase's scope and the artifact's `## Verification Notes`:

   - `#### Automated Verification:` — start with project-standard baseline (`npm run check`, `npm test`) and add phase-specific automated checks: file existence (`test -f path`), grep patterns from Verification Notes (`grep -r "pattern" packages/ | wc -l` returns expected count), test names that should now pass, type-check / lint scoped to changed files.
   - `#### Manual Verification:` — observable behaviors that can't be automated: UI/UX checks, performance under real load, edge cases requiring human judgment, precedent-lesson manual checks. Pull from Verification Notes that are visual or behavioral, scoped to what this phase delivers.

   Convert prose Verification Notes by phase ownership: a constraint that lands inside Phase N's scope becomes a Phase N criterion. Cross-phase constraints (e.g., "production build still succeeds") repeat across the relevant terminal phases.

   **Format** — each entry is a `- [ ]` markdown checkbox; commands wrapped in backticks. `implement` flips `- [ ]` to `- [x]` as it completes each criterion; `validate` extracts and runs each command listed under `#### Automated Verification:`. The example below illustrates the format only — actual per-phase content and bullet counts come from the guidance above (phase scope + `## Verification Notes`).

   ```markdown
   ### Success Criteria:

   #### Automated Verification:
   - [ ] Type checking passes: `npm run check`
   - [ ] Tests pass: `npm test`
   - [ ] Grep pattern from Verification Note: `grep -r "newApi" packages/ | wc -l` returns >= 3

   #### Manual Verification:
   - [ ] New widget renders correctly above the editor
   - [ ] Performance acceptable with 1000+ todo items
   ```

3. **Verify frontmatter counters**:
   - `unresolved_phase_count == 0` (every phase approved in Step 7d)
   - `phase_count` matches the number of `## Phase N` sections

   If any check fails, return to Step 7 for the unresolved phase. Do NOT flip status to ready.

4. **Update frontmatter** via Edit:
   - Set `status: ready`
   - Update `last_updated` to current date
   - Update `last_updated_by` to the User from the injected git context (fallback: "unknown")

5. **Verify template completeness**: Ensure all sections from the template reference in Step 6 are present and filled. Edit to fix any gaps.

6. **Phase Changes Required format reminder**:
   - **NEW files**: `#### N. path/to/file.ext` + `**File**` + `**Changes**: NEW — [purpose]` + full implementation code block
   - **MODIFY files**: `#### N. path/to/file.ext:line-range` + `**File**` + `**Changes**: MODIFY — [summary]` + code block with only the modified/added code (no "Current" block — the original is on disk, implement reads it)

## Step 10: Review & Iterate

1. **Present the plan artifact location**:
   ```
   Implementation plan written to:
   `thoughts/shared/plans/[filename].md`

   [N] architectural decisions fixed, [P] phases generated, [M] new files, [K] existing files modified.
   [R] revisions during generation.

   Please review and let me know:
   - Are the architectural decisions correct?
   - Does the code match what you envision?
   - Any missing integration points or edge cases?

   When ready, run `/skill:implement thoughts/shared/plans/[filename].md Phase 1` to start execution (or omit `Phase 1` to run all phases sequentially).
   ```

2. **Handle follow-up changes**:
   - Use the Edit tool to update the plan artifact in-place
   - Update frontmatter: `last_updated` and `last_updated_by`
   - Add `last_updated_note: "Updated [brief description]"` to frontmatter
   - If the change affects decisions, update both the Decisions section AND the affected `## Phase N` code
   - If new ambiguities arise, return to Step 5 (developer checkpoint)

## Guidelines

1. **Be Architectural**: Design shapes code; plans sequence work. Every decision must be grounded in `file:line` evidence from the actual codebase.

2. **Be Interactive**: Don't produce the full design in one shot. Resolve ambiguities through the checkpoint first, get buy-in on the approach, THEN decompose and generate slice-by-slice.

3. **Be Complete**: Code in every `## Phase N` `### Changes Required:` block must be copy-pasteable by implement. No pseudocode, no TODOs, no "implement here" placeholders. If you can't write complete code, an ambiguity wasn't resolved.

4. **Be Skeptical**: Question vague requirements. If an existing pattern doesn't fit the new feature, say so and propose alternatives. Don't force a pattern where it doesn't belong.

5. **Resolve Everything**: No unresolved questions in the final artifact. If something is ambiguous, ask during the checkpoint or micro-checkpoint. The plan must be complete enough that implement can execute each phase end-to-end without re-asking.

6. **Present Condensed, Persist Complete**: Micro-checkpoints show the developer summaries, signatures, and key code blocks. The artifact always contains full copy-pasteable code. If the developer asks to see full code, show it — but never default to walls of code in checkpoints.

## Subagent Usage

| Context | Agents Spawned |
|---|---|
| Default (research artifact provided) | codebase-pattern-finder |
| Novel work (new library/pattern) | + web-search-researcher |
| Step 5 correction path (developer flags missed area) | targeted codebase-analyzer (max 1-2) |
| Step 7a mid-generation gap (specific anchor unclear) | targeted codebase-analyzer (max 1) |

Spawn multiple agents in parallel when they're searching for different things. Each agent runs in isolation — provide complete context in the prompt, including specific directory paths when the feature targets a known module. Don't write detailed prompts about HOW to search — just tell it what you're looking for and where.

## Important Notes

- **Always chained**: This skill requires a research artifact produced by the research skill.
- **File reading**: Always read research artifacts and referenced files FULLY (no limit/offset) before spawning agents
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read input files first (Step 1) before spawning agents (Step 2)
  - ALWAYS wait for all agents to complete before identifying ambiguities (Step 3)
  - ALWAYS resolve all ambiguities (Step 5) before decomposing into slices (Step 6)
  - ALWAYS complete holistic decomposition before generating any slice code (Step 7)
  - ALWAYS create the skeleton artifact immediately after decomposition approval (Step 6)
  - NEVER leave Phase code fences empty after their slice is approved — fill via Edit in Step 7d
- NEVER skip the developer checkpoint — developer input on architectural decisions is the highest-value signal in the planning process
- NEVER edit source files — all code goes into the plan document, not the codebase. This skill produces a document, not implementation. Source file editing is implement's job.
- **Code is source of truth** — if a `## Phase N` code block conflicts with the Decisions prose, the code wins. Update the prose.
- **Checkpoint recordings**: Record micro-checkpoint interactions in Developer Context with `file:line` references, same as Step 5 questions.
- **Frontmatter consistency**: Always include frontmatter, use snake_case for multi-word fields, keep tags relevant

## Common Planning Patterns

- **New Features**: types first → backend logic → API surface → UI last. Research existing patterns first. Include tests alongside each implementation.
- **Modifications**: Read current file FULLY. Show only the modified/added code scoped to changed sections. Check integration points for side effects.
- **Database Changes**: schema/migration → store/repository → business logic → API → client. Include rollback strategy.
- **Refactoring**: Document current behavior first. Plan incremental backwards-compatible changes. Verify existing behavior preserved.
- **Novel Work**: Include approach comparison in Decisions. Ground in codebase evidence OR web research. Get explicit developer sign-off BEFORE writing code.
