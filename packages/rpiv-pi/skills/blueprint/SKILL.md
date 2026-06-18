---
name: blueprint
description: Plan complex features by decomposing them into vertical slices (one slice equals one phase) with developer micro-checkpoints between phases, producing an implement-ready phased plan in .rpiv/artifacts/plans/. Use for complex multi-component features touching 6+ files across multiple layers when iterative review between slices is valuable. Optionally consumes a research/solutions artifact; can also run standalone with a free-text feature description for small tasks. Prefer blueprint over plan when mid-flight micro-checkpoints matter, and prefer plan when a straightforward phased breakdown is enough.
argument-hint: "[research artifact path or feature description]"
shell-timeout: 10
contract:
  produces:
    kind: produces
    interaction: foreground
    meta:
      artifactKind: plan
    data:
      type: object
      required: [phases, phase_count]
      properties:
        status:
          enum: [in-progress, in-review, ready]
        phase_count:
          type: integer
          minimum: 1
          maximum: 32
        phases:
          type: array
          minItems: 1
          maxItems: 32
          items:
            type: object
            required: [n, title]
            properties:
              n: { type: integer, minimum: 1 }
              title: { type: string }
  consumes:
    data:
      type: object
      properties:
        status:
          const: ready
    meta:
      artifactKind: [research, solutions]
---

# Blueprint

You are tasked with planning how code will be shaped for a feature or change AND emitting an implement-ready phased plan. Decompose the feature into vertical slices (one slice = one phase), generate code slice-by-slice with developer micro-checkpoints between slices, and write the final artifact directly into `.rpiv/artifacts/plans/` for `/skill:implement` to consume.

## Input

`$ARGUMENTS` — path to a research artifact (`.rpiv/artifacts/research/*.md`) or a solutions artifact (`.rpiv/artifacts/solutions/*.md`), or a free-text feature description (standalone mode for small tasks).

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
echo
echo "### recent (read only in case of empty user input)"
echo "recent research:"
node "${SKILL_DIR}/../_shared/list-recent.mjs" .rpiv/artifacts/research 4
echo
echo "recent solutions:"
node "${SKILL_DIR}/../_shared/list-recent.mjs" .rpiv/artifacts/solutions 4
```

Copy values verbatim — do not reformat the timezone offset.

## Flow

1. Input → 2. Research → 3. Dimension sweep → 4. Checkpoint → 5. Decompose → 6. Generate slices → 7. Finalize → 8. Independent review → 9. Triage & iterate → 10. Follow-ups

The final artifact is implement-ready.

## Steps

### Step 1: Input Handling

When this command is invoked:

1. **Read research artifact**:

   **Research artifact provided** (argument contains a path to a `.md` file in `.rpiv/artifacts/`):
   - Read the research artifact FULLY using the Read tool WITHOUT limit/offset
   - Extract: Summary, Code References, Integration Points, Architecture Insights, Precedents & Lessons, Developer Context, Open Questions
   - **Read the key source files from Code References** into the main context — especially hooks, shared utilities, and integration points the design will depend on. Read them FULLY. This ensures you have complete understanding before proceeding.
   - These become starting context — no need to re-discover what exists
   - Research Developer Context Q/As = inherited decisions (record in Decisions, never re-ask); Open Questions = starting ambiguity queue, filtered by dimension in Step 3

   **No arguments provided**, branch on the `recent research:` and `recent solutions:` listings in the Metadata block:
   - **Both empty** — no upstream artifacts available; ask the user for a free-text feature description and proceed in standalone mode (no artifact read; Step 2 fills the integration and precedent slots via agent dispatch).
   - **Exactly one entry total** — confirm with `ask_user_question`: "Blueprint from this artifact?" with options "Blueprint from `[<source>] <filename>` (Recommended)" and "Pick a different path".
   - **Two or more entries total** — present up to 4 most-recent across both listings as `ask_user_question` options, each prefixed `[research]` or `[solutions]` to flag source class.

   **Anything else** (plain free-text feature description, unrecognized `.md` path, ticket link) — treat the input as the topic for Step 2; skip the upstream artifact read.

2. **Read any additional files mentioned** — tickets, related designs, existing implementations. Read them FULLY before proceeding.

### Step 2: Targeted Research

This is NOT a discovery sweep. Focus on DEPTH (how things work, what patterns to follow) not BREADTH (where things are).

1. **Spawn parallel research agents** using the Agent tool:

   - Use **codebase-pattern-finder** to find existing implementations to model after — the primary template for code shape

   For integration wiring (inbound refs, outbound deps, config/DI/event registration), use the `## Integration Points` section already extracted from research in Step 1 when present; otherwise add **integration-scanner** to the parallel dispatch. For precedent context (similar past changes, blast radius, follow-up fixes, lessons), use the `## Precedents & Lessons` section already extracted from research in Step 1 when present; otherwise add **precedent-locator** when the topic touches risky surfaces (auth, migrations, schema changes, hot paths, perf-sensitive code). Do NOT dispatch either agent when its corresponding section is already in context.

   **External surfaces** — third-party APIs, SDKs, libraries, services, protocols, or wire formats not already in the codebase:
   - Add **web-search-researcher**

   Agent prompts should focus on (labeled by target agent):
   - **codebase-pattern-finder**: "Find the implementation pattern I should model after for {feature type}"
   - **integration-scanner** (when dispatched): "For {topic}, map inbound refs, outbound deps, and config/DI/event registration for the area where the new feature would wire in. Single pass."

   NOT: "Find all files related to X" — that's discovery's job, upstream of this skill.

2. **Read all key files identified by agents** into the main context — especially the pattern templates you'll model after.

3. **Wait for ALL agents to complete** before proceeding.

4. **Analyze and verify understanding**:
   - Cross-reference research findings with actual code read in Step 1
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

### Step 3: Identify Ambiguities — Dimension Sweep

Walk Step 2 findings, inherited research Q/As, and carried Open Questions through six architectural dimensions that map 1:1 to the plan artifact's section coverage — the sweep guarantees downstream completeness. Add **migration** as a seventh dimension only if the feature changes persisted schema.

- **Data model** — types, schemas, entities
- **API surface** — signatures, exports, routes
- **Integration wiring** — mount points, DI, events, config
- **Scope** — in / explicitly deferred
- **Verification** — tests, assertions, risk-bearing behaviors
- **Performance** — load paths, caching, N+1 risks

For each dimension, classify findings into three classes:

- **simple** — one valid option, obvious from codebase, no directional weight. Record in Decisions with `file:line` evidence; do not ask.
- **directional** — obvious *fit*, but the choice encodes a direction: propagates an existing pattern across new files, picks extend-vs-replace, or spreads a convention the project may be moving off. Queue for the **directional confirm** (Step 4, one batched ask).
- **genuine ambiguity** — multiple valid options, conflicting patterns, scope questions, novel choices. Queue for Step 4, one-at-a-time.

Inherited research Q/As land as simple unless directional; Open Questions filter by dimension — architectural survives, implementation-detail defers.

**Pre-validate every option** before queuing it against research constraints and runtime code behavior. Eliminate or caveat options that contradict Steps 1-2 evidence. **Coverage check**: every Step 2 file read appears in at least one decision, directional confirm, or ambiguity; every dimension is addressed (silently-resolved valid, skipped-unchecked not).

### Step 4: Developer Checkpoint

Use the grounded-questions-one-at-a-time pattern. Use a **❓ Question:** prefix so the developer knows their input is needed. Each question must:
- Reference real findings with `file:line` evidence
- Present concrete options (not abstract choices)
- Pull a DECISION from the developer, not confirm what you already found

**Directional confirms first.** Before the one-at-a-time questions, clear every **directional** finding from Step 3 in a single batched `ask_user_question` (up to 4 per call). Do not mark the "follow" option Recommended.

> Question: "About to follow {pattern X} (`file:line`, used ×N) across {the N new files} — confirm that's the direction, or moving off it?". Header: "Direction". Options: "Follow {X}" (propagate as-is); "Moving off {X}" (deliberate departure).

**Follow** records the decision as stated. **Moving off** promotes the finding to a genuine ambiguity — ask it one-at-a-time below with the alternative in view.

**Question patterns by ambiguity type:**

- **Pattern conflict**: "Found 2 patterns for {X}: {pattern A} at `file:line` and {pattern B} at `file:line`. They differ in {specific way}. Which should the new {feature} follow?"
- **Missing pattern**: "No existing {pattern type} in the codebase. Options: (A) {approach} modeled after {external reference}, (B) {approach} extending {existing code at file:line}. Which fits the project's direction?"
- **Scope boundary**: "The {research/description} mentions both {feature A} and {feature B}. Should this design cover both, or just {feature A} with {feature B} deferred?"
- **Integration choice**: "{Feature} can wire into {point A} at `file:line` or {point B} at `file:line`. {Point A} matches the {existing pattern} pattern. Agree, or prefer {point B}?"
- **Novel approach**: "No existing {X} in the project. Options: (A) {library/pattern} — {evidence/rationale}, (B) {library/pattern} — {evidence/rationale}. Which fits?"

**Critical rules:**
- Ask ONE question at a time. Wait for the answer before asking the next.
- Lead with the most architecturally significant ambiguity.
- Every answer becomes a FIXED decision — no revisiting unless the developer explicitly asks.

**Choosing question format:**

- **`ask_user_question` tool** — when your question has 2-4 concrete options from code analysis (pattern conflicts, integration choices, scope boundaries, priority overrides). The user can always pick "Other" for free-text. Example:

  > Use the `ask_user_question` tool with the following question: "Found 2 mapping approaches — which should new code follow?". Header: "Pattern". Options: "Manual mapping (Recommended)" (Used in OrderService (src/services/OrderService.ts:45) — 8 occurrences); "AutoMapper" (Used in UserService (src/services/UserService.ts:12) — 2 occurrences).

- **Open-ended** (discovery, "what am I missing?", corrections) — still `ask_user_question`; offer your best 1-2 guesses and let "Other" carry the unpredictable answer.

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
Design: {feature name}
Approach: {1-2 sentence summary of chosen architecture}

Decisions:
- {Decision 1}: {choice} — modeled after `file:line`
- {Decision 2}: {choice}
- {Decision 3}: {choice}

Scope: {what's in} | Not building: {what's out}
Files: {N} new, {M} modified
```

Use the `ask_user_question` tool to confirm before proceeding. Question: "{Summary from design brief above}. Ready to proceed to decomposition?". Header: "Design". Options: "Proceed (Recommended)" (Decompose into vertical slices, then generate code slice-by-slice); "Adjust decisions" (Revisit one or more architectural decisions above); "Change scope" (Add or remove items from the building/not-building lists).

### Step 5: Feature Decomposition

After the design summary is confirmed, decompose the feature into vertical slices. Each slice is a self-contained unit: types + implementation + wiring for one concern.

1. **Decompose holistically** — define ALL slices, dependencies, and ordering before generating any code:

   ```
   Feature Breakdown: {feature name}

   Slice 1: {name} — {what this slice delivers}
     Files: path/to/file.ext (NEW), path/to/file.ext (MODIFY)
     Depends on: nothing (foundation)

   Slice 2: {name} — {what this slice delivers}
     Files: path/to/file.ext (NEW), path/to/file.ext (MODIFY)
     Depends on: Slice 1

   Slice 3: {name} — {what this slice delivers}
     Files: path/to/file.ext (NEW)
     Depends on: Slice 2
   ```

2. **Slice properties**:
   - End-to-end vertical: each slice is a complete cross-section of one concern (types + impl + wiring)
   - ~512-1024 tokens per slice (maps to individual file blocks)
   - Sequential: each builds on the previous (never parallel)
   - Foundation first: types/interfaces always Slice 1

3. **Confirm decomposition** using the `ask_user_question` tool. Question: "{N} slices for {feature}. Slice 1: {name} (foundation). Slices 2-N: {brief}. Approve decomposition?". Header: "Slices". Options: "Approve (Recommended)" (Proceed to slice-by-slice code generation); "Adjust slices" (Reorder, merge, or split slices before generating); "Change scope" (Add or remove files from the decomposition).

4. **Create skeleton artifact** — immediately after decomposition is approved:
   - Determine metadata from the Metadata block above: filename `.rpiv/artifacts/plans/<slug>_<topic>.md` (use `<slug>` from line 1 of the Metadata block above); `repository:` from `repo:`; `branch:` / `commit:` from matching labels; `author:` ← matching label (fallback: `unknown`).
   - Timestamp: use `<iso>` from line 1 of the Metadata block above for `date:` and `last_updated:` (copy the offset verbatim).
   - Write skeleton using the Write tool with `status: in-progress` in frontmatter
   - **Include all prose sections filled** from Steps 1-5: Overview, Requirements, Current State Analysis, Desired End State, What We're NOT Doing, Decisions, Ordering Constraints, Verification Notes, Performance Considerations, Migration Notes, Pattern References, Developer Context, References
   - **Phase sections**: one `## Phase N: {slice name}` heading per slice from the decomposition (in slice order), each with `### Overview`, `### Changes Required:` (one `#### N. path/to/file.ext` subsection per file with empty code fence + NEW/MODIFY label), and `### Success Criteria:` (empty Automated + Manual subsection headers — filled in Step 6.4 on approval)
   - **Plan History section**: list all phases with `— pending` status
   - This is the living artifact — all subsequent writes use the Edit tool

   **Artifact template sections** (all required in skeleton):

   - **Frontmatter**: date, author, commit, branch, repository, topic, tags, `status: in-progress`, parent, phase_count, `phases` (derived from the `## Phase N:` headings — see Step 7.2), unresolved_phase_count (initialized to phase_count, decrements as each phase's code is approved in Step 6.4), last_updated, last_updated_by
   - **# {Feature Name} Implementation Plan**
   - **## Overview**: 2-3 sentences — what we're building and the chosen architectural approach. Settled decision, not a discussion.
   - **## Requirements**: Bullet list from ticket, research, or developer input.
   - **## Current State Analysis**: What exists now, what's missing, key constraints. Include `### Key Discoveries` with `file:line` references, patterns to follow, constraints to work within.
   - **## Desired End State**: Usage examples showing the feature in use from a consumer's perspective — concrete code, not prose.
   - **## What We're NOT Doing**: Developer-stated exclusions AND likely scope-creep vectors (alternative architectures not chosen, nearby code that looks related but shouldn't be touched).
   - **## Decisions**: `###` per decision. Complex: Ambiguity → Explored (Option A/B with `file:line` + pro/con) → Decision. Simple: just state decision with evidence.
   - **## Phase N: {slice name}** (one per slice, in slice order):
     - `### Overview`: one sentence describing what this phase delivers + parallelism note from `Depends on:` (e.g., "Depends on Phase 1; can run in parallel with Phase 3.").
     - `### Changes Required:` — one `#### N. path/to/file.ext` subsection per file in this slice. Each subsection has `**File**: path`, `**Changes**: {NEW | MODIFY — summary}`, and an empty code fence (filled in Step 6.4). NEW files get full implementation. MODIFY files get only modified/added code — no "Current" block, the original is on disk.
     - `### Success Criteria:` with empty `#### Automated Verification:` and `#### Manual Verification:` subsection headers — no TBD bullets; filled in Step 6.4 on phase approval, scoped to that phase's deliverables and matching `## Verification Notes`.
   - **## Ordering Constraints**: What must come before what. What can run in parallel. (Carries the cross-phase view; per-phase parallelism note also lives in each Phase Overview.)
   - **## Verification Notes**: Carry forward from research — known risks, build/test warnings, precedent lessons. Format as verifiable checks (commands, grep patterns, visual inspection). Step 6.1 lifts these into per-phase Success Criteria during slice generation; Step 6.4 writes them to the artifact on approval.
   - **## Performance Considerations**: Any performance implications or optimizations.
   - **## Migration Notes**: If applicable — existing data, schema changes, rollback strategy, backwards compatibility. Empty if not applicable.
   - **## Pattern References**: `path/to/similar.ext:line-range` — what pattern to follow and why.
   - **## Developer Context**: Record questions exactly as asked during checkpoint, including `file:line` evidence. Also record micro-checkpoint interactions from Step 6.3 and Step 8.4 reviewer-failure fallback notes.
   - **## Plan History**: Phase approval/revision log. `- Phase N: {name} — pending/approved as generated/revised: {what changed}`. implement ignores this section.
   - **## References**: Research artifacts, tickets, similar implementations.

   **Phase Changes Required format in skeleton**:
   - **NEW files**: `#### N. path/to/file.ext` + `**File**: path` + `**Changes**: NEW — {purpose}` + empty code fence (generated in Step 6.1, written in Step 6.4)
   - **MODIFY files**: `#### N. path/to/file.ext:line-range` + `**File**: path` + `**Changes**: MODIFY — {summary}` + empty code fence (generated in Step 6.1 with only the modified code, written in Step 6.4 — no "Current" block, the original is on disk)

### Step 6: Generate Slices (Iterative)

Generate code one slice at a time. Each slice sees the fixed code from all previous slices.

**Before slice 1**: look at the decomposition. For slices whose code shape isn't already covered by Step 2's pattern-finder result (different layer, different file kind, different concern), dispatch additional **codebase-pattern-finder** calls in parallel — one assistant message, one tool call per slice that needs its own template. Slices whose shape matches a sibling reuse that sibling's result. Hold the returned templates in context for 6.1; do not re-dispatch per slice during generation.

**For each slice in the decomposition (sequential order):**

#### 6.1. Generate slice code and success criteria (internal)

Generate complete, copy-pasteable code AND the phase's `### Success Criteria:` for every file in this slice — but **hold both for the artifact, do NOT present full code to the developer**. The developer sees a condensed review in 6.3; the full code and criteria go into the artifact in 6.4.

- **New files**: complete code — imports, types, implementation, exports. Follow the pattern template from Step 2.
- **Modified files**: read current file FULLY, generate only the modified/added code scoped to changed sections (no full "Current" block — the original is on disk)
- **Test files**: complete test suites following project patterns
- **Wiring**: show where new code hooks into existing code
- **Success Criteria**: derive `### Success Criteria:` from this phase's file changes plus `## Verification Notes` entries that map to this phase's scope. Use the same `- [ ]` format as 6.4 (see template below). Project-baseline checks (`npm run check`, `npm test`) go on the terminal phase only. Commands in backticks.

If additional context is needed, spawn a targeted **codebase-analyzer** agent.

No pseudocode, no TODOs, no placeholders — the code must be copy-pasteable by implement. Success Criteria must be atomic for this phase: no bullets that depend on symbols/files a later phase introduces.

**Context grounding** (after slice 2): Before generating, re-read the artifact's prior `## Phase N` sections for files this slice touches (a file may appear in earlier phases; if so, this phase extends or revisits it). The artifact is the source of truth — generate code that extends what's already emitted, not what you remember from conversation.

#### 6.2. Verify slice

Mandatory for every slice — no skipping, no shortcuts.

First compute the cross-slice overlap partition deterministically — this keeps the O(M) prior-phase classification out of the agent:

```
node "${SKILL_DIR}/../_shared/slice-overlap.mjs" "<artifact_path>" "Phase N"
```

Then dispatch the `slice-verifier` agent with:
- `artifact_path`: the Step-5 Write `file_path` (contains the skeleton plus locked prior phases)
- `slice_id`: `Phase N`
- `current_slice_code`: inline the just-generated slice verbatim — every `#### N. path/...` block with its full code fence AND the `### Success Criteria:` block (Automated + Manual subsections).
- `target_files`: files this slice modifies, plus key files prior phases introduced
- `overlapping_priors`: the `overlapping:` ids from slice-overlap.mjs — the only priors to deep-walk. Omit if the helper failed (agent self-partitions).

The agent emits a 3-row summary (`Decisions / Cross-slice / Research`). On any VIOLATION, take one of:

- **Fix-and-re-dispatch**: when the finding is a real gap, fix the slice in-place per the citation and re-dispatch until OK.
- **Surface-and-proceed**: when the finding is plausibly by-design (e.g. foundation-phase atomicity tension, deferred resolution covered by ordering constraints), include the verbatim VIOLATION row in the 6.3 slice presentation with a one-line by-design rationale. The existing 6.3 approve question is the ratification — no separate prompt.

Never proceed to 6.3 with a VIOLATION absent from the presentation.

#### 6.3. Developer micro-checkpoint

Present a **condensed review** of the slice — NOT the full generated code. The developer reviews the design shape, not every line. For each file in the slice, show:

1. **Summary** (1-2 sentences): what changed, what pattern used, what it connects to
2. **Signatures**: type/interface definitions, exported function signatures with parameter and return types
3. **Key code blocks**: factory calls, wiring, non-obvious logic — the interesting parts that show the design decision in action

**Then, once per slice, a mandatory Fit line** (always shown, regardless of the omit list below):

> **Fit** — Reused: {existing helpers/utils/types this slice builds on, `file:line`}. New surface: {new abstractions/exports introduced}. Convention: {naming/error/logging pattern followed + source `file:line`}.

If the slice introduces a new abstraction where an existing one would serve, or reuses nothing, say so explicitly.

**Omit**: boilerplate, import lists, full function bodies, obvious implementations.
**MODIFY files**: focused diff (`- old` / `+ new`) with ~3 lines context. **Test files**: test case names only.

**If the developer asks to see full code**, show it inline — exception, not default.

Use the `ask_user_question` tool to confirm. Question: "Slice {N/M}: {slice name} — {files affected}. {1-line summary}. Approve?". Header: "Slice {N}". Options: "Approve (Recommended)" (Lock this slice, write to artifact, proceed to slice {N+1}); "Revise this slice" (Adjust code before proceeding — describe what to change); "Rethink remaining slices" (This slice reveals a design issue — revisit decomposition); "Revisit a decision" (A Step-4 decision is wrong — return to Step 4 for that decision before continuing).

**Final slice**: prepend `Cross-slice: {OK | violations: ...}.` to the question using slice-verifier's Cross-slice row from the final slice's 6.2 dispatch. Approve subtext becomes "Lock, write, run Step 7 finalize and Step 8 reviewer dispatch automatically; pause at Step 9 for triage." Replace "Rethink remaining slices" with "Reopen earlier phase" (cascade per 6.4.Rethink) — no remaining slices to rethink.

**Checkpoint cadence**: One slice per checkpoint. Present each slice individually, regardless of slice count.

#### 6.4. Incorporate feedback

**Approve**: Lock this slice's code and criteria and **Edit the artifact immediately**:
1. For each file in this slice, Edit the skeleton artifact to replace the empty code fence under that file's `#### N. path/...` subsection inside this slice's `## Phase N: {slice name}` section with the full generated code from 6.1
2. If a later slice contributes to a file already filled by an earlier phase: emit a NEW `#### N. path/to/file.ext` subsection inside the later phase with only that phase's incremental changes (do NOT mutate the earlier phase's code fence — implement runs phases sequentially and the codebase state evolves between them). Each phase's code fence is the change set for that phase, applied on top of the codebase state after the previous phase.
3. After fill, verify within this phase: no duplicate function definitions inside the same code fence, imports deduplicated, exports list complete
4. **Write `### Success Criteria:`** for this phase: Edit the empty Automated + Manual subsections with the `- [ ]` bullets generated in 6.1. Contract: `implement` flips `- [ ]` → `- [x]` as it completes each; `validate` extracts and runs every command under `#### Automated Verification:`.

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
5. Update the Plan History section: `- Phase N: {name} — approved as generated`
6. Decrement frontmatter `unresolved_phase_count` by 1
- Proceed to next slice

**Revise**: Update code and/or success criteria per developer feedback. Re-run verify (6.2). Re-present the same slice (6.3). The artifact is NOT touched — only "Approve" writes to the artifact.

**Rethink**: Developer spotted a design issue. If a previously approved slice is affected, flag the conflict and offer cascade revision — developer decides whether to reopen (if yes, Edit the affected `## Phase N` entry).
Update decomposition (add/remove/reorder remaining slices) and confirm before continuing.

**Revisit a decision**: Re-run Step 4 for the flagged ambiguity (one question). If decomposition is unaffected, update `## Decisions` and resume 6.1. If affected, cascade like Rethink — for each invalidated approved phase, ask reopen vs. annotate Plan History, then update remaining slices. Re-run 6.2 before re-presenting 6.3; artifact untouched until approval.

### Step 7: Finalize Plan Artifact

The artifact was created as a skeleton in Step 5 and filled progressively in Step 6.4 (code fences + Success Criteria). This step verifies and flips status.

1. **Verify all Phase content is filled**: every `#### N. path/...` has a non-empty code block AND every `### Success Criteria:` has non-empty Automated + Manual subsections (generated in Step 6.1, written in Step 6.4). If any are empty, **return to Step 6** — never fill at finalize time (bypasses 6.2/6.3). Empty here = workflow off-rail.

2. **Verify frontmatter counters**:
   - `unresolved_phase_count == 0` (every phase approved in Step 6.4)
   - `phase_count` matches the number of `## Phase N` sections

   If any check fails, return to Step 6. Do NOT flip status. (7.1 and 7.2 guard the same invariant — empty content ↔ unresolved counter.)

   Then **rebuild the `phases:` frontmatter array from the `## Phase N:` headings** — one `{ n, title }` entry per section, in body order:
   ```yaml
   phases:
     - { n: 1, title: Schema layer }
     - { n: 2, title: Runtime wiring }
   ```

3. **Update frontmatter** via Edit: `status: in-progress` → `status: in-review` (Step 9 flips to `ready` after triage — keeps consumers off an artifact still being edited). Leave `last_updated` / `last_updated_by` as-is.

4. **Verify template completeness**: Ensure all sections from the template reference in Step 5 are present and filled. Edit to fix any gaps.

5. **Phase Changes Required format reminder**:
   - **NEW files**: `#### N. path/to/file.ext` + `**File**` + `**Changes**: NEW — {purpose}` + full implementation code block
   - **MODIFY files**: `#### N. path/to/file.ext:line-range` + `**File**` + `**Changes**: MODIFY — {summary}` + code block with only the modified/added code (no "Current" block — the original is on disk, implement reads it)

### Step 8: Independent Plan Review

After Step 7 finalizes the artifact, dispatch two independent review subagents in parallel — one to walk every Phase code fence, one to walk every verification intent — both against the live codebase at HEAD.

#### 8.1. Dispatch artifact-code-reviewer and artifact-coverage-reviewer in parallel

Reuse the exact `file_path` string passed to `Write` at Step 5 — the runtime already resolved it for this platform; do not rebuild it from `pwd`. `ls` to verify it still exists; abort dispatch on miss.

Send both Agent calls in a single assistant message so they run in parallel:

```
Agent({
  subagent_type: "artifact-code-reviewer",
  description: "post-finalization plan code review",
  prompt: `Plan artifact: {Step-5 Write file_path, ls-verified}

Review the finalized plan against the live codebase at HEAD. Walk every Phase code fence, audit against code-quality / codebase-fit / actionability, emit one severity-tagged row per finding.`
})

Agent({
  subagent_type: "artifact-coverage-reviewer",
  description: "post-finalization plan coverage review",
  prompt: `Plan artifact: {Step-5 Write file_path, ls-verified}

Review the finalized plan's verification-intent coverage. Walk every ## Verification Notes and ## Precedents & Lessons entry; for each, verify it lands in either a phase's ### Success Criteria: bullet or as a visible code mirror. Emit one severity-tagged row per uncovered entry.`
})
```

#### 8.2. Persist the merged review table to the artifact

Each agent returns a markdown table with columns `plan-loc | codebase-loc | severity | dimension | finding | recommendation`. Merge both tables into one section, prepending a `source` column (`code` for artifact-code-reviewer rows, `coverage` for artifact-coverage-reviewer rows) and appending a `resolution` column (initially blank, filled progressively at Step 9):

```markdown
## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution         |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | ------------------ |
| code     | {plan-loc}        | {codebase-loc}              | {severity} | {dimension}           | {finding} | {recommendation} | (filled at Step 9) |
| coverage | {plan-loc}        | <n/a>                       | {severity} | verification-coverage | {finding} | {recommendation} | (filled at Step 9) |
| ...      |                   |                             |            |                       |           |                  |                    |
```

Sort merged rows by severity first (blocker → concern → suggestion), then by source (`code` before `coverage` for stable ordering within a severity). Within a `(severity, source)` bucket, preserve each agent's own emitted order — do not re-sort across source spaces (the two agents key on different artifact loci: `Phase N §M` for code, `## Verification Notes §K` for coverage).

If both agents emit zero rows, still emit the section with a single line: `_No findings — both reviewers cleared the artifact._`. Persistence is mandatory regardless of finding count — the section is the durable audit trail.

#### 8.3. Tally findings for Step 9's prompt

Count merged rows by severity. Store the counts in main context for Step 9's developer prompt:

```
{B} blockers, {C} concerns, {S} suggestions
```

Do NOT auto-apply any finding. The orchestrator never makes the apply / defer / dismiss judgment alone — that lives with the developer at Step 9. The reviewers' role is to surface; the developer's role is to triage.

#### 8.4. Failure handling

Per-agent: if one reviewer errors out (subprocess crash, malformed output, timeout) and the other succeeds, persist the successful agent's rows and append a one-line failure note for the missing source. If both fail, append the failure note alone.

- Successful side: persist its rows as in 8.2.
- Failed side: append `_Step 8 {code|coverage} review failed: {one-line cause}._` under the `## Plan Review (Step 8)` heading.
- Record any failure in `## Developer Context`: `Step 8 {code|coverage} review unavailable; proceeded to developer review without {agent-name} findings.`
- Proceed to Step 9 regardless.

The 8-column header is retained when only one source returns; only rows from the failing agent are absent. Step 9 triage iterates whatever rows are present.

### Step 9: Review & Iterate

1. **Triage Step 8 reviewer findings first** (skip if Step 8 returned no findings):

   Present the Plan Review table from Step 8 to the developer with severity-grouped framing:

   ```
   Plan-reviewer findings: {B} blockers, {C} concerns, {S} suggestions

   Triage each row before the freeform review below:
   - applied — code change made; I'll Edit the affected `## Phase N` code fence and fill the row's resolution as `applied: {one-line summary}`
   - deferred — noted but not fixing now; resolution cites why (e.g., "out of scope for this plan", "follow-up commit")
   - dismissed — not a real issue; resolution explains why the reviewer was wrong (e.g., "X is intentional because Y")
   ```

   Use `ask_user_question` with options "applied / deferred / dismissed":
   - **applied**: Edit per the recommendation target — if the recommendation names a `## Phase N` code fence, Edit that fence; if it names a `### Success Criteria:` bullet, Edit that block; if it names both, Edit both. Routing follows the recommendation text, not the `source` column. Fill `resolution`.
   - **deferred** / **dismissed**: fill `resolution` with the reason.

   **Order and batching**: blockers sequentially (resolution may invalidate later rows). Concerns and suggestions: batch up to 4 independent rows per `ask_user_question` call (Step 4's rule). Independent = different files / different intents AND neither recommendation references the other's location; otherwise sequential.

2. **Flip status to ready**: once every row has a `resolution` (or the table is empty per Step 8's no-findings / failure-fallback path), Edit frontmatter `status: in-review` → `status: ready`. Artifact is now implement-ready.

3. **Present the plan artifact location** (after triage is complete):
   ```
   Implementation plan written to:
   `.rpiv/artifacts/plans/{filename}.md`

   {N} architectural decisions fixed, {P} phases generated, {M} new files, {K} existing files modified.
   {R} revisions during generation. {T} reviewer findings triaged at Step 9 ({A} applied, {D} deferred, {DD} dismissed).

   Please review and let me know:
   - Are the architectural decisions correct?
   - Does the code match what you envision?
   - Any missing integration points or edge cases?

   ---

   💬 Follow-up: describe the change in chat to append a timestamped Follow-up section to this artifact. Re-run `/skill:blueprint` for a fresh artifact.

   **Next step:** `/skill:implement .rpiv/artifacts/plans/{filename}.md Phase 1` — start execution at Phase 1 (omit `Phase 1` to run all phases sequentially).

   > 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
   ```

### Step 10: Handle Follow-ups

- **Edit in-place.** Use the Edit tool to update the plan artifact directly — phase code stays one source of truth.
- **Bump frontmatter.** Update `last_updated` + `last_updated_by`; set `last_updated_note: "Updated <brief description>"`.
- **Sync decisions ↔ code.** If the change affects decisions, update both the Decisions section AND the affected `## Phase N` code. Code is source of truth — if they conflict, the code wins, update the prose.
- **Return to checkpoint on new ambiguities.** If new ambiguities surface, return to Step 4 (developer checkpoint) before regenerating phases.
- **When to re-invoke instead.** For surgical edits to a specific phase, prefer `/skill:revise <plan-path>` over re-running the full skill. Re-run `/skill:blueprint` only when the underlying research changed materially. The previous block's `Next step:` stays valid for the existing plan.

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
| Step 4 correction path (developer flags missed area) | targeted codebase-analyzer (max 1-2) |
| Step 6 pre-slice-1 template fetch | codebase-pattern-finder (one per slice needing its own template) |
| Step 6.1 mid-generation gap (specific anchor unclear) | targeted codebase-analyzer (max 1) |
| Step 6.2 per-slice verify (mandatory) | slice-verifier |
| Step 8 post-finalization code review (mandatory) | artifact-code-reviewer |
| Step 8 post-finalization coverage review (mandatory) | artifact-coverage-reviewer |

Spawn multiple agents in parallel when they're searching for different things. Each agent runs in isolation — provide complete context in the prompt, including specific directory paths when the feature targets a known module. Don't write detailed prompts about HOW to search — just tell it what you're looking for and where.

## Important Notes

- **Always chained**: This skill requires a research artifact produced by the research skill.
- **File reading**: Always read research artifacts and referenced files FULLY (no limit/offset) before spawning agents
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read input files first (Step 1) before spawning agents (Step 2)
  - ALWAYS wait for all agents to complete before identifying ambiguities (Step 3)
  - ALWAYS resolve all ambiguities (Step 4) before decomposing into slices (Step 5)
  - ALWAYS complete holistic decomposition before generating any slice code (Step 6)
  - ALWAYS create the skeleton artifact immediately after decomposition approval (Step 5)
  - ALWAYS generate Success Criteria in Step 6.1 alongside code; NEVER leave Phase code fences or Success Criteria empty after their slice is approved — both are written via Edit in Step 6.4 from what 6.1 produced
  - NEVER fill empty Phase content at Step 7 — empty at finalize time = return to Step 6 (preserves the 6.3 micro-checkpoint)
  - ALWAYS dispatch slice-verifier at Step 6.2 for every slice before presenting at 6.3; never skip, never batch across slices
  - NEVER silently dismiss a slice-verifier VIOLATION — either fix and re-dispatch, or surface the verbatim finding to the developer at 6.3 for ratification
  - ALWAYS dispatch artifact-code-reviewer AND artifact-coverage-reviewer in parallel at Step 8 after Step 7 finalize, BEFORE the developer review at Step 9
  - NEVER auto-apply a Step 8 reviewer finding; triage is the developer's call at Step 9
  - ALWAYS hold `status: in-review` from Step 7 through Step 9; flip to `ready` only after every row has a `resolution` (or the table is empty)
  - Step 6.3 → Step 4 exists for late-discovered decision errors; revisit rather than force a wrong shape through remaining slices
- NEVER skip the developer checkpoint — developer input on architectural decisions is the highest-value signal in the planning process
- NEVER edit source files — all code goes into the plan document, not the codebase. This skill produces a document, not implementation. Source file editing is implement's job.
- **Code is source of truth** — if a `## Phase N` code block conflicts with the Decisions prose, the code wins. Update the prose.
- **Checkpoint recordings**: Record micro-checkpoint interactions in Developer Context with `file:line` references, same as Step 4 questions.
- **Frontmatter consistency**: Always include frontmatter, use snake_case for multi-word fields, keep tags relevant

## Common Planning Patterns

- **New Features**: types first → backend logic → API surface → UI last. Research existing patterns first. Include tests alongside each implementation.
- **Modifications**: Read current file FULLY. Show only the modified/added code scoped to changed sections. Check integration points for side effects.
- **Database Changes**: schema/migration → store/repository → business logic → API → client. Include rollback strategy.
- **Refactoring**: Document current behavior first. Plan incremental backwards-compatible changes. Verify existing behavior preserved.
- **Novel Work**: Include approach comparison in Decisions. Ground in codebase evidence OR web research. Get explicit developer sign-off BEFORE writing code.
