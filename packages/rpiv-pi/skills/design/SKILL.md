---
name: design
description: Design features through iterative vertical-slice decomposition and progressive code generation with developer micro-checkpoints. For complex multi-component features touching 6+ files across multiple layers. Produces design artifacts in thoughts/shared/designs/. Always requires a research artifact from discover → research, or a solutions artifact from explore.
argument-hint: [research artifact path]
---

# Design

You are tasked with designing how code will be shaped for a feature or change. This iterative variant decomposes features into vertical slices and generates code slice-by-slice with developer micro-checkpoints between slices. The design artifact feeds directly into plan, which sequences it into phases.

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

The final artifact is plan-compatible.

## Step 1: Input Handling

When this command is invoked:

1. **Read research artifact**:

   **Research artifact provided** (argument contains a path to a `.md` file in `thoughts/`):
   - Read the research artifact FULLY using the Read tool WITHOUT limit/offset
   - Extract: Summary, Code References, Integration Points, Architecture Insights, Developer Context, Open Questions
   - **Read the key source files from Code References** into the main context — especially hooks, shared utilities, and integration points the design will depend on. Read them FULLY. This ensures you have complete understanding before proceeding.
   - These become starting context — no need to re-discover what exists
   - Research Developer Context Q/As = inherited decisions (record in Decisions, never re-ask); Open Questions = starting ambiguity queue, filtered by dimension in Step 3
   - If a discover artifact is also provided, read it for additional discovery context

   **No arguments provided**:
   ```
   I'll design a feature iteratively from a research artifact. Please provide:

   `/skill:design [research artifact] [discover] [task description]`

   Research artifact is required. Discover and task description are optional, in any order.
   ```
   Then wait for input.

2. **Read any additional files mentioned** — tickets, related designs, existing implementations. Read them FULLY before proceeding.

## Step 2: Targeted Research

This is NOT a discovery sweep. Focus on DEPTH (how things work, what patterns to follow) not BREADTH (where things are).

1. **Spawn parallel research agents** using the subagent tool:

   - Use **codebase-pattern-finder** to find existing implementations to model after — the primary template for code shape
   - Use **codebase-analyzer** to understand HOW integration points work in detail
   - Use **integration-scanner** to map the wiring surface — inbound refs, outbound deps, config/DI/event registration
   - Use **precedent-locator** to find similar past changes in git history — what commits introduced comparable features, what broke, and what lessons apply to this design. Only when `git_commit` is available (not `no-commit`); otherwise skip and note "git history unavailable" in Verification Notes.

   **Novel work** (new libraries, first-time patterns, no existing codebase precedent):
   - Add **web-search-researcher** for external documentation, API references, and community patterns
   - Instruct it to return LINKS with findings — include those links in the final design artifact

   Agent prompts should focus on (labeled by target agent):
   - **codebase-pattern-finder**: "Find the implementation pattern I should model after for [feature type]"
   - **codebase-analyzer**: "How does [integration point] work in detail"
   - **integration-scanner**: "What connects to [component] — inbound refs, outbound deps, config"

   NOT: "Find all files related to X" — that's discovery's job, upstream of this skill.

2. **Read all key files identified by agents** into the main context — especially the pattern templates you'll model after.

3. **Wait for ALL agents to complete** before proceeding.

4. **Analyze and verify understanding**:
   - Cross-reference research findings with actual code read in Step 1
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

## Step 3: Identify Ambiguities — Dimension Sweep

Walk Step 2 findings, inherited research Q/As, and carried Open Questions through six architectural dimensions that map 1:1 to `plan` extract sections — the sweep guarantees downstream completeness. Add **migration** as a seventh dimension only if the feature changes persisted schema.

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
  "❓ Question: Integration scanner found no background job registration for this area. Is that expected, or is there async processing I'm not seeing?"

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
   - Determine metadata: filename `thoughts/shared/designs/YYYY-MM-DD_HH-MM-SS_topic.md`, repository name from git root, branch and commit from the git context injected at the start of the session (fallbacks: "no-branch" / "no-commit"), designer from the injected User (fallback: "unknown")
   - Write skeleton using the Write tool with `status: in-progress` in frontmatter
   - **Include all prose sections filled** from Steps 1-5: Summary, Requirements, Current State Analysis, Scope, Decisions, Desired End State, File Map, Ordering Constraints, Verification Notes, Performance Considerations, Migration Notes, Pattern References, Developer Context, References
   - **Architecture section**: one `### path/to/file.ext — NEW/MODIFY` heading per file from the decomposition, with empty code fences as placeholders
   - **Design History section**: list all slices with `— pending` status
   - This is the living artifact — all subsequent writes use the Edit tool

   **Artifact template sections** (all required in skeleton):

   - **Frontmatter**: date, designer, git_commit, branch, repository, topic, tags, `status: in-progress`, research_source, last_updated, last_updated_by
   - **# Design: [Feature Name]**
   - **## Summary**: 2-3 sentences — what we're building and the chosen architectural approach. Settled decision, not a discussion.
   - **## Requirements**: Bullet list from ticket, research, or developer input.
   - **## Current State Analysis**: What exists now, what's missing, key constraints. Include `### Key Discoveries` with `file:line` references, patterns to follow, constraints to work within.
   - **## Scope**: `### Building` — concrete deliverables. `### Not Building` — developer-stated exclusions AND likely scope-creep vectors (alternative architectures not chosen, nearby code that looks related but shouldn't be touched).
   - **## Decisions**: `###` per decision. Complex: Ambiguity → Explored (Option A/B with `file:line` + pro/con) → Decision. Simple: just state decision with evidence.
   - **## Architecture**: `###` per file with NEW/MODIFY label. Empty code fences in skeleton (filled in Step 7d). NEW files get full implementation. MODIFY files get only modified/added code — no "Current" block.
   - **## Desired End State**: Usage examples showing the feature in use from a consumer's perspective — concrete code, not prose.
   - **## File Map**: `path/to/file.ext  # NEW/MODIFY — purpose` per line.
   - **## Ordering Constraints**: What must come before what. What can run in parallel.
   - **## Verification Notes**: Carry forward from research — known risks, build/test warnings, precedent lessons. Format as verifiable checks (commands, grep patterns, visual inspection). plan converts these to success criteria.
   - **## Performance Considerations**: Any performance implications or optimizations.
   - **## Migration Notes**: If applicable — existing data, schema changes, rollback strategy, backwards compatibility. Empty if not applicable.
   - **## Pattern References**: `path/to/similar.ext:line-range` — what pattern to follow and why.
   - **## Developer Context**: Record questions exactly as asked during checkpoint, including `file:line` evidence. For iterative variant: also record micro-checkpoint interactions from Step 7c.
   - **## Design History**: Slice approval/revision log. `- Slice N: [name] — pending/approved as generated/revised: [what changed]`. plan ignores this section.
   - **## References**: Research artifacts, tickets, similar implementations.

   **Architecture format in skeleton**:
   - **NEW files**: heading + empty code fence (filled with full implementation in Step 7d)
   - **MODIFY files**: heading with `file:line-range` + empty code fence (filled with only the modified code in Step 7d — no "Current" block, the original is on disk)

## Step 7: Generate Slices (Iterative)

Generate code one slice at a time. Each slice sees the fixed code from all previous slices.

**For each slice in the decomposition (sequential order):**

### 7a. Generate slice code (internal)

Generate complete, copy-pasteable code for every file in this slice — but **hold it for the artifact, do NOT present full code to the developer**. The developer sees a condensed review in 7c; the full code goes into the artifact in 7d.

- **New files**: complete code — imports, types, implementation, exports. Follow the pattern template from Step 2.
- **Modified files**: read current file FULLY, generate only the modified/added code scoped to changed sections (no full "Current" block — the original is on disk)
- **Test files**: complete test suites following project patterns
- **Wiring**: show where new code hooks into existing code

If additional context is needed, spawn a targeted **codebase-analyzer** agent.

No pseudocode, no TODOs, no placeholders — the code must be copy-pasteable by implement.

**Context grounding** (after slice 2): Before generating, re-read the artifact's Architecture section for files this slice touches. The artifact is the source of truth — generate code that extends what's already there, not what you remember from conversation.

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

**Checkpoint cadence**: Slices 1-2: always individual. Slices 3+: individual if (a) mid-generation agent spawn was needed, (b) MODIFY touches an undiscussed file, or (c) self-verify fixed a violation.
Otherwise batch 2-3 slices (max 3).

### 7d. Incorporate feedback

**Approve**: Lock this slice's code and **Edit the artifact immediately**:
1. For each file in this slice, Edit the skeleton artifact to replace the empty code fence under that file's Architecture heading with the full generated code from 7a
2. If a later slice contributes to a file already filled by an earlier slice: **rewrite the entire code fence** with the merged result (do not append alongside existing code)
3. After merge, verify: no duplicate function definitions, imports deduplicated, exports list complete
4. Update the Design History section: `- Slice N: [name] — approved as generated`
- Proceed to next slice

**Revise**: Update code per developer feedback. Re-run self-verify (7b). Re-present the same slice (7c). The artifact is NOT touched — only "Approve" writes to the artifact.

**Rethink**: Developer spotted a design issue. If a previously approved slice is affected, flag the conflict and offer cascade revision — developer decides whether to reopen (if yes, Edit artifact entry).
Update decomposition (add/remove/reorder remaining slices) and confirm before continuing.

## Step 8: Integration Verification

After all slices are complete, review cross-slice consistency:

1. **Present integration summary** (under 15 lines):
   ```
   Integration: [feature name] — [N] slices complete

   Slices: [brief list of slice names and file counts]
   Cross-slice: [types consistent / imports valid / wiring complete]
   Research constraints: [all satisfied / N violations noted]
   ```

2. **Verify research constraints**: Check each Precedent & Lesson and Verification Note from the research artifact against the generated code. List satisfaction status.

3. **Confirm using the `ask_user_question` tool**. Question: "[N] slices complete, [M] files total. Cross-slice consistency verified. Proceed to design artifact?". Header: "Verify". Options: "Proceed (Recommended)" (Finalize the design artifact (verify completeness, update status)); "Revisit slice" (Reopen a specific slice for revision — Edit the artifact after); "Add missing" (A file or integration point is missing — add to artifact).

## Step 9: Finalize Design Artifact

The artifact was created as a skeleton in Step 6 and filled progressively in Step 7d. This step verifies completeness and finalizes.

1. **Verify all Architecture entries are filled**: Every file heading from the decomposition must have a non-empty code block. If any are still empty (e.g., a slice was skipped), generate and fill them now.

2. **Verify cross-slice file merges**: For files touched by multiple slices, confirm the Architecture entry contains the final merged code, not just the last slice's contribution.

3. **Update frontmatter** via Edit:
   - Set `status: complete`
   - Update `last_updated` to current date
   - Update `last_updated_by` to the User from the injected git context (fallback: "unknown")

4. **Verify template completeness**: Ensure all 17 sections from the template reference in Step 6 are present and filled. Edit to fix any gaps.

5. **Architecture format reminder**:
   - **NEW files**: `### path/to/file.ext — NEW` + one-line purpose + full implementation code block
   - **MODIFY files**: `### path/to/file.ext:line-range — MODIFY` + code block with only the modified/added code (no "Current" block — the original is on disk, implement reads it)

## Step 10: Review & Iterate

1. **Present the design artifact location**:
   ```
   Design artifact written to:
   `thoughts/shared/designs/[filename].md`

   [N] architectural decisions fixed, [M] new files designed, [K] existing files modified.
   [S] slices generated, [R] revisions during generation.

   Please review and let me know:
   - Are the architectural decisions correct?
   - Does the code match what you envision?
   - Any missing integration points or edge cases?

   When ready, run `/skill:plan thoughts/shared/designs/[filename].md` to sequence into phases.
   ```

2. **Handle follow-up changes**:
   - Use the Edit tool to update the design artifact in-place
   - Update frontmatter: `last_updated` and `last_updated_by`
   - Add `last_updated_note: "Updated [brief description]"` to frontmatter
   - If the change affects decisions, update both the Decisions section AND the Architecture code
   - If new ambiguities arise, return to Step 5 (developer checkpoint)

## Guidelines

1. **Be Architectural**: Design shapes code; plans sequence work. Every decision must be grounded in `file:line` evidence from the actual codebase.

2. **Be Interactive**: Don't produce the full design in one shot. Resolve ambiguities through the checkpoint first, get buy-in on the approach, THEN decompose and generate slice-by-slice.

3. **Be Complete**: Code in the Architecture section must be copy-pasteable by implement. No pseudocode, no TODOs, no "implement here" placeholders. If you can't write complete code, an ambiguity wasn't resolved.

4. **Be Skeptical**: Question vague requirements. If an existing pattern doesn't fit the new feature, say so and propose alternatives. Don't force a pattern where it doesn't belong.

5. **Resolve Everything**: No unresolved questions in the final artifact. If something is ambiguous, ask during the checkpoint or micro-checkpoint. The design must be complete enough that plan can mechanically decompose it into phases.

6. **Present Condensed, Persist Complete**: Micro-checkpoints show the developer summaries, signatures, and key code blocks. The artifact always contains full copy-pasteable code. If the developer asks to see full code, show it — but never default to walls of code in checkpoints.

## Subagent Usage

| Context | Agents Spawned |
|---|---|
| Default (research artifact provided) | codebase-pattern-finder, codebase-analyzer, integration-scanner, precedent-locator |
| Novel work (new library/pattern) | + web-search-researcher |
| During code writing (if needed) | targeted codebase-analyzer for specific files |

Spawn multiple agents in parallel when they're searching for different things. Each agent runs in isolation — provide complete context in the prompt, including specific directory paths when the feature targets a known module. Don't write detailed prompts about HOW to search — just tell it what you're looking for and where.

## Important Notes

- **Always chained**: This skill requires a research artifact produced by the research skill. There is no standalone design mode.
- **File reading**: Always read research artifacts and referenced files FULLY (no limit/offset) before spawning agents
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read input files first (Step 1) before spawning agents (Step 2)
  - ALWAYS wait for all agents to complete before identifying ambiguities (Step 3)
  - ALWAYS resolve all ambiguities (Step 5) before decomposing into slices (Step 6)
  - ALWAYS complete holistic decomposition before generating any slice code (Step 7)
  - ALWAYS create the skeleton artifact immediately after decomposition approval (Step 6)
  - NEVER leave Architecture code fences empty after their slice is approved — fill via Edit in Step 7d
- NEVER skip the developer checkpoint — developer input on architectural decisions is the highest-value signal in the design process
- NEVER edit source files — all code goes into the design document, not the codebase. This skill produces a document, not implementation. Source file editing is implement's job.
- **Code is source of truth** — if the Architecture code section conflicts with the Decisions prose, the code wins. Update the prose.
- **Checkpoint recordings**: Record micro-checkpoint interactions in Developer Context with `file:line` references, same as Step 5 questions.
- **Frontmatter consistency**: Always include frontmatter, use snake_case for multi-word fields, keep tags relevant
- CC auto-loads CLAUDE.md files when agents read files in a directory — no need to scan for them explicitly

## Common Design Patterns

- **New Features**: types first → backend logic → API surface → UI last. Research existing patterns first. Include tests alongside each implementation.
- **Modifications**: Read current file FULLY. Show only the modified/added code scoped to changed sections. Check integration points for side effects.
- **Database Changes**: schema/migration → store/repository → business logic → API → client. Include rollback strategy.
- **Refactoring**: Document current behavior first. Plan incremental backwards-compatible changes. Verify existing behavior preserved.
- **Novel Work**: Include approach comparison in Decisions. Ground in codebase evidence OR web research. Get explicit developer sign-off BEFORE writing code.
