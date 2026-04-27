---
name: design2
description: Design features through architectural grill-me + per-slice grill-me with Slice Contract specification. Walks a decision-DAG to exhaustion at architectural scope, then per slice. Produces design artifacts in thoughts/shared/designs/ — contracts, not code. For complex multi-component features touching 6+ files across multiple layers. Always requires a research artifact.
argument-hint: [research artifact path] [discover artifact path] [task description]
---

# Design

You are tasked with designing how code will be shaped for a feature or change. This grill-me variant walks a decision-DAG architecturally to fix architectural decisions, decomposes the feature into vertical slices, then walks each slice's decision-DAG to fix Slice Contracts. The design produces contracts — no code generation. The plan skill synthesizes contract-fulfilling code at plan-time.

**How it works**:
- Read input and key source files into context (Step 1)
- Spawn targeted research agents for depth analysis (Step 2)
- Architectural grill-me — walk the decision-DAG to exhaustion, fixing architectural decisions (Step 3)
- Decompose into vertical slices holistically (Step 4)
- Per-slice grill-me — interview the developer per slice and draft Slice Contracts (Step 5)
- Verify cross-slice integration consistency (Step 6)
- Finalize the design artifact (Step 7)
- Review and iterate with the developer (Step 8)

The final artifact is plan-compatible. Plan extracts Slice Contracts and Q/A pairs to dispatch per-slice pattern-finder agents and synthesize contract-fulfilling code.

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

   `/skill:design2 [research artifact] [discover] [task description]`

   Research artifact is required. Discover and task description are optional, in any order.
   ```
   Then wait for input.

2. **Read any additional files mentioned** — tickets, related designs, existing implementations. Read them FULLY before proceeding.

## Step 2: Targeted Research

This is NOT a discovery sweep. Focus on DEPTH (how things work, what patterns to follow) not BREADTH (where things are).

1. **Dispatch all agents below as parallel `subagent` tool calls in the same assistant message** — multiple tool_use blocks in one response, not one call per turn. Each call matches this shape: `subagent({ agent: "<agent-name>", task: "<task>", context: "fresh", artifacts: false })`. Wait for all to return before proceeding.

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

## Step 3: Architectural Grill-Me

The architectural grill-me is a relentless interview that walks the design's decision-DAG to exhaustion. It absorbs the dimension sweep, holistic self-critique, and grounded-questions checkpoint into one phase. The dimensions seed the DAG; the walk produces fixed architectural decisions recorded with full Q/A trace.

### Decision-DAG seeded by dimensions

Six architectural dimensions seed the initial DAG roots (each contributes 0-N root questions):

- **Data model** — types, schemas, entities
- **API surface** — signatures, exports, routes
- **Integration wiring** — mount points, DI, events, config
- **Scope** — in / explicitly deferred
- **Verification** — tests, assertions, risk-bearing behaviors
- **Performance** — load paths, caching, N+1 risks

Add **migration** as a seventh dimension if the feature changes persisted schema.

For each dimension, walk Step 2 findings, inherited research Q/As, and carried Open Questions. Classify findings as **simple decisions** (one valid option, obvious from codebase — record in Decisions with `file:line` evidence, do not ask) or **DAG nodes** (multiple valid options, conflicting patterns, scope questions, novel choices — feed into the grill-me walk). Inherited research Q/As land as simple; Open Questions filter by dimension — architectural survives, implementation-detail defers.

Pre-validate every option against research constraints and runtime code behavior. Eliminate or caveat options that contradict Steps 1-2 evidence.

### Grill-me walk

Walk the DAG dependency-topologically. The lead question is the topologically earliest one — the node with the most downstream dependents. Each answer becomes a fixed architectural decision recorded in the artifact's Decisions section with full Q/A trace.

**Question rules** (preserved from grounded-questions pattern):
- Reference real findings with `file:line` evidence
- Present concrete options (not abstract choices)
- Pull a DECISION from the developer, not confirm what you already found
- Ask ONE question at a time. Wait for the answer before asking the next.

**Question patterns by ambiguity type** (preserved):

- **Pattern conflict**: "Found 2 patterns for [X]: [pattern A] at `file:line` and [pattern B] at `file:line`. They differ in [specific way]. Which should the new [feature] follow?"
- **Missing pattern**: "No existing [pattern type] in the codebase. Options: (A) [approach] modeled after [external reference], (B) [approach] extending [existing code at file:line]. Which fits the project's direction?"
- **Scope boundary**: "The [research/description] mentions both [feature A] and [feature B]. Should this design cover both, or just [feature A] with [feature B] deferred?"
- **Integration choice**: "[Feature] can wire into [point A] at `file:line` or [point B] at `file:line`. [Point A] matches the [existing pattern] pattern. Agree, or prefer [point B]?"
- **Novel approach**: "No existing [X] in the project. Options: (A) [library/pattern] — [evidence/rationale], (B) [library/pattern] — [evidence/rationale]. Which fits?"

**Question format choice** (preserved):
- **`ask_user_question` tool** — when your question has 2-4 concrete options from code analysis. The user can always pick "Other" for free-text.
- **Free-text with ❓ Question: prefix** — when the question is open-ended and options can't be predicted (discovery, "what am I missing?", corrections).

**Per-question check** (absorbs holistic self-critique):
After each answer, before the next question, ask yourself:
- Does this answer reveal new DAG branches that weren't seeded by the dimensions?
- Does this answer conflict with a prior answer? If so, surface the conflict explicitly (see Evidence-driven reopen below).
- Does this answer cover a multi-faceted concern that should split into sub-questions?

Add new branches to the DAG when discovered. Resolve conflicts proactively. Split multi-faceted nodes.

### FIXED-decision rule with evidence-driven reopen

Decisions stay FIXED within a single branch traversal — no oscillation. When a downstream branch surfaces evidence that an upstream answer was wrong-framed, the grill-me PROACTIVELY surfaces the conflict as one explicit reopen question:

> "❓ Question: Decision D1 (use pattern A at `file:line`) was framed assuming [X], but D5 just established [Y] which means D1 needs to be reopened. Do you want to: (A) revise D1 in light of D5, (B) revise D5's premise, or (C) accept the inconsistency for now and document the tension in Verification Notes?"

This activates the existing "no revisiting unless the developer explicitly asks" clause proactively. Mirrors the cascade-revision pattern from later phases moved earlier in the lifecycle.

### Two-gate exit

The grill-me phase exits when BOTH gates hold:

- **Gate 1 (depth)**: Every DAG node has a recorded answer or simple-decision classification. No unresolved children.
- **Gate 2 (breadth)**: Coverage check — every dimension is addressed. Silent-resolved is valid (a dimension whose findings all classified as simple decisions counts as addressed). Skipped-unchecked does NOT count as addressed.

If Migration was added as the seventh dimension, it gates Gate 2 conditionally on persisted-schema changes.

### Classify each response

**Decision** (e.g., "use pattern A", "yes, follow that approach"):
- Record in Decisions section under heading `### D<N>: <title>` (sequential D1, D2, … — IDs are mandatory; plan2 references them by ID) with full Q/A trace inline (Ambiguity → Explored → Decision format).
- Update `architectural_qa_count` frontmatter counter.

**Correction** (e.g., "no, there's a third option you missed", "check the events module"):
- Spawn targeted rescan: **codebase-analyzer** on the new area (max 1-2 agents).
- Merge results. Update DAG and re-walk affected branches.

**Scope adjustment** (e.g., "skip the UI, backend only", "include tests"):
- Record in Developer Context (non-Q/A interaction). Adjust Scope section.

### Exit gate

After both Gate 1 and Gate 2 hold, present a brief design summary (under 15 lines):

```
Design: [feature name]
Approach: [1-2 sentence summary of chosen architecture]

Decisions:
- [Decision 1]: [choice] — modeled after `file:line`
- [Decision 2]: [choice]
- [Decision 3]: [choice]

Scope: [what's in] | Not building: [what's out]
Slices: [N] preliminary slices identified | Files: [N] new, [M] modified
```

Use the `ask_user_question` tool to confirm. Question: "[Summary from design brief above]. Ready to proceed to decomposition?". Header: "Design". Options: "Proceed" (Decompose into vertical slices, then per-slice grill-me); "Adjust decisions" (Revisit one or more architectural decisions above); "Change scope" (Add or remove items from the building/not-building lists).

## Step 4: Feature Decomposition

After the architectural grill-me exit gate confirms, decompose the feature into vertical slices. Each slice is a self-contained unit: types + impl + wiring for one concern. Decomposition is one shot — define ALL slices, dependencies, and ordering before per-slice grill-me begins.

1. **Decompose holistically** — define ALL slices, dependencies, and ordering before any per-slice grill-me runs:

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
   - ~512-1024 tokens per slice contract block
   - Sequential. 5a/5b drafting may be done internally for sibling slices in any order, but Step 5c micro-checkpoints are strictly one slice at a time — never batched, never parallel from the developer's view.
   - Foundation first when applicable: if the feature has shared types/interfaces, they're typically Slice 1
   - Encode `depends_on` per slice — drives both per-slice grill-me parallelization eligibility and plan's parallel-phase eligibility

3. **Confirm decomposition** using the `ask_user_question` tool. Question: "[N] slices for [feature]. Slice 1: [name] (foundation). Slices 2-N: [brief]. Approve decomposition?". Header: "Slices". Options: "Approve" (Proceed to per-slice grill-me); "Adjust slices" (Reorder, merge, or split slices before grill-me); "Change scope" (Add or remove files from the decomposition).

4. **Create skeleton artifact** — immediately after decomposition is approved:
   - Determine metadata: filename `thoughts/shared/designs/YYYY-MM-DD_HH-MM-SS_topic.md`, repository name from git root, branch and commit from the git context injected at the start of the session (fallbacks: "no-branch" / "no-commit"), designer from the injected User (fallback: "unknown")
   - Write skeleton using the Write tool with `status: in-progress` in frontmatter
   - **Include all prose sections filled** from Steps 1-3: Summary, Requirements, Current State Analysis, Scope, Decisions (architectural Q/A trace inline), Desired End State, File Map, Ordering Constraints, Verification Notes, Performance Considerations, Migration Notes, Pattern References, Developer Context, References
   - **Slice Contracts section**: one `### Slice N: [name] — Contract` heading per slice from the decomposition, each with empty placeholders for the seven required contract fields plus a `#### Q/A` placeholder
   - **Design History section**: list all slices with `— pending` status
   - This is the living artifact — all subsequent writes use the Edit tool

   **Artifact template sections** (all required in skeleton):

   - **Frontmatter**: standard metadata (date, designer, git_commit, branch, repository, topic, tags, `status: in-progress`, research_source, last_updated, last_updated_by) plus contract-validation counters initialized at skeleton write: `architectural_qa_count: <Step 3 final total>`, `per_slice_qa_count: 0` (5d increments), `slice_count: <N>`, `unresolved_qa_count: 0` (sentinel; two-gate exit guarantees), `unresolved_contract_count: <slice_count>` (5d decrements; 0 to complete), `slices: [{name, contract_status: pending, qa_count: 0, files, depends_on}]` (status → approved/revised in 5d), `contract_fields_required: [inputs, outputs, types, integration_anchors, invariants, verification_hooks]`.
   - **# Design: [Feature Name]**
   - **## Summary**: 2-3 sentences — what we're building and the chosen architectural approach. Settled decision, not a discussion.
   - **## Requirements**: Bullet list from ticket, research, or developer input.
   - **## Current State Analysis**: What exists now, what's missing, key constraints. Include `### Key Discoveries` with `file:line` references, patterns to follow, constraints to work within.
   - **## Scope**: `### Building` — concrete deliverables. `### Not Building` — developer-stated exclusions AND likely scope-creep vectors (alternative architectures not chosen, nearby code that looks related but shouldn't be touched).
   - **## Decisions**: `### D<N>: <title>` per architectural decision (sequential D1, D2, … — IDs are mandatory; plan2 references them by ID). Complex: Ambiguity → Explored (Option A/B with `file:line` + pro/con) → Decision. Simple: just state decision with evidence. Each `### D<N>:` includes inline Q/A trace per decision.
   - **## Slice Contracts**: `###` per slice with `Slice N: [name] — Contract` heading. Required field bullets in order: Inputs, Outputs, Types/Data Model, Integration anchors, Invariants, Verification hooks, Files touched. `#### Q/A` subsection embeds the per-slice grill-me transcript. No implementation code. (Filled progressively in Step 5d.)
   - **## Desired End State**: Usage examples showing the feature in use from a consumer's perspective — concrete code, not prose.
   - **## File Map**: `path/to/file.ext  # NEW/MODIFY — purpose` per line. Stays at artifact level as the canonical flat list. NEW/MODIFY labels also appear inside each slice contract's Files touched field (slice-scoped duplicate is intentional).
   - **## Ordering Constraints**: What must come before what. What can run in parallel. Drives plan's phase eligibility.
   - **## Verification Notes**: Carry forward from research — known risks, build/test warnings, precedent lessons. Format as verifiable checks (commands, grep patterns, visual inspection). plan converts these to success criteria.
   - **## Performance Considerations**: Any performance implications or optimizations.
   - **## Migration Notes**: If applicable — existing data, schema changes, rollback strategy, backwards compatibility. Empty if not applicable.
   - **## Pattern References**: one entry per reference, formatted as `path/to/similar.ext:line-range — Slice <N> (<slice name>): <one-line reason>`. Each entry MUST tag at least one slice it serves; references that serve multiple slices repeat across multiple lines, one tag per line. Plan dispatches `codebase-pattern-finder` per slice using the references tagged for that slice.
   - **## Developer Context**: Non-Q/A interactions — corrections (rescans triggered by codebase-analyzer correction path), scope adjustments, mid-walk redirects. Q/A pairs live inside `## Decisions` (architectural) and `## Slice Contracts` `#### Q/A` (per-slice).
   - **## Design History**: Slice contract approval/revision log. `- Slice N: [name] — pending/approved as drafted/revised: [what changed]`. plan ignores this section AND the `#### Q/A` subsections inside Slice Contracts.
   - **## References**: Research artifacts, tickets, similar implementations.

   **Slice contract block format in skeleton**:
   - `### Slice N: [name] — Contract` heading
   - Required field bullets with TBD placeholders:
     - `**Inputs**: TBD`
     - `**Outputs**: TBD`
     - `**Types/Data Model**: TBD`
     - `**Integration anchors**: TBD`
     - `**Invariants**: TBD`
     - `**Verification hooks**: TBD`
     - `**Files touched**: TBD`
   - `#### Q/A` heading with empty body
   - Filled in Step 5d via Edit when the slice's contract is approved.

## Step 5: Per-Slice Grill-Me

Walk each slice's decision-DAG to draft its Slice Contract. Each per-slice grill-me runs after holistic decomposition is locked. The developer is a serial resource — Step 5c micro-checkpoints are strictly one slice at a time. Slices are NEVER batched at the checkpoint, regardless of `depends_on` independence.

**For each slice in the decomposition (strictly sequential at the developer checkpoint):**

### 5a. Draft contract internally

**Commitments before drafting.** Before populating contract fields, scan the slice for any choice where two reasonable implementers reading the same spec would diverge in their code — those divergence points are architectural commitments, not local logic. Pull each as a Q/A in the slice's `#### Q/A` before drafting. If you catch yourself choosing between alternatives during drafting, stop and pull the Q/A first.

Walk the slice's decision-DAG. Reuse the grounded-questions pattern from Step 3, scoped to this slice. The slice's contract walk seeds DAG roots from the seven required fields:

- **Inputs** — what does this slice receive? Function/route parameters with types, request shapes, event payloads.
- **Outputs** — what does this slice produce? Return types, response shapes, side effects.
- **Types/Data Model** — what new entities/schemas does this slice introduce?
- **Integration anchors** — where does this slice mount? `file:line` for DI calls, route registration, event subscription, hook installation.
- **Invariants** — what cross-cutting properties must this slice preserve? Transaction boundaries, ordering guarantees.
- **Verification hooks** — how do we prove the contract holds? Test names with intent, grep patterns, observable behaviors.
- **Files touched** — which files does this slice create or modify? `path (NEW)` or `path:line-range (MODIFY)`.

Walk the DAG dependency-topologically. Resolve each node before drafting the dependent contract field. If additional context is needed, spawn a targeted **codebase-analyzer** agent (max 1).

**Context grounding** (after slice 2): Before drafting, re-read the artifact's Slice Contracts section for prior slices. The artifact is the source of truth — generate contract anchors that align with what's already declared, not what you remember from conversation.

### 5b. Self-verify slice contract

Before presenting to the developer, cross-check the drafted contract and produce a structured summary:

```
Self-verify Slice N contract:
- Architectural decisions: [OK / VIOLATION: contract violates decision X — fix applied]
- Cross-slice: [OK / CONFLICT: integration anchors at file:line clash with prior slice — fix applied]
- Research: [OK / WARNING: research constraint Y not satisfied by verification hooks — fix applied]
- Required fields: [all populated / missing: <field list>]
```

If violations found: fix in-place before presenting. Include the self-verify summary in the 5c micro-checkpoint presentation.

### 5c. Developer micro-checkpoint

Present a **condensed contract review** — the developer reviews the contract shape, not every field's prose. For each contract field, show:

1. **Summary** (1-2 sentences): what this slice does, what pattern it follows, what it connects to
2. **Inputs/Outputs**: the surface — types, parameters, return shapes
3. **Integration anchors**: `file:line` mount points — the wiring decisions
4. **Verification hooks**: test names + grep patterns — how we'll know it works

**Omit**: full prose for Types/Data Model (named only), Invariants summary line only, Files touched as a path list.

**If the developer asks to see the full contract**, show it inline — exception, not default.

Use the `ask_user_question` tool to confirm. Question: "Slice [N/M]: [slice name] — [files affected]. [1-line contract summary]. Approve?". Header: "Slice [N]". Options: "Approve" (Lock this slice's contract, write to artifact, proceed to slice [N+1]); "Revise this slice" (Adjust contract before proceeding — describe what to change); "Rethink remaining slices" (This slice reveals a design issue — revisit decomposition).

**Checkpoint cadence**:
- Every slice is presented individually. No batching, no grouping — one slice per `ask_user_question` call. The developer reviews and approves each slice's contract on its own before the next slice's 5a draft begins.

### 5d. Incorporate feedback

**Approve**: Lock this slice's contract and **Edit the artifact immediately**:
1. Edit the slice's `### Slice N: [name] — Contract` block to replace TBD placeholders with the drafted contract fields
2. Append the per-slice grill-me transcript to the slice's `#### Q/A` subsection (one bullet per Q/A pair with `file:line` evidence)
3. Update the Design History section: `- Slice N: [name] — approved as drafted`
4. Increment frontmatter `per_slice_qa_count` by the number of new Q/As; decrement `unresolved_contract_count` by 1; update the `slices: [{contract_status}]` entry for this slice from `pending` to `approved`
- Proceed to next slice

**Revise**: Update contract per developer feedback. Re-run self-verify (5b). Re-present the same slice (5c). The artifact is NOT touched — only "Approve" writes to the artifact.

**Rethink**: Developer spotted a design issue. If a previously approved slice's contract is affected, flag the conflict and offer cascade revision — developer decides whether to reopen (if yes, Edit artifact entry). Update decomposition (add/remove/reorder remaining slices) and confirm before continuing. If the conflict invalidates an architectural decision from Step 3, surface as evidence-driven reopen at architectural scope.

## Step 6: Integration Verification

After all slices' contracts are drafted, review cross-slice consistency:

1. **Present integration summary** (under 15 lines):
   ```
   Integration: [feature name] — [N] slice contracts complete

   Slices: [brief list of slice names and file counts]
   Cross-slice: [integration anchors consistent / outputs feed inputs / no orphan invariants]
   Research constraints: [all satisfied by verification hooks / N gaps noted]
   ```

2. **Verify research constraints**: Check each Precedent & Lesson and Verification Note from the research artifact against each slice's verification hooks. List satisfaction status per constraint.

3. **Verify cross-slice contract consistency**:
   - Outputs of upstream slices match Inputs of downstream slices that depend on them
   - Integration anchors don't conflict (two slices claiming the same `file:line` for incompatible mount points)
   - No invariant declared in one slice is contradicted by another slice's contract

4. **Self-verify and proceed**. If steps 2–3 above pass, proceed directly to Step 7 finalize. If a research constraint is unsatisfied, an integration anchor conflicts, or a slice's outputs don't match a downstream slice's inputs, return to that slice's grill-me (Step 5) — do NOT ask the developer to choose; reopening the affected slice is the only correct action.

## Step 7: Finalize Design Artifact

The artifact was created as a skeleton in Step 4 and filled progressively in Step 5d. This step verifies completeness and finalizes.

1. **Verify every slice contract is fully specified**: Every `### Slice N:` heading has populated Inputs, Outputs, Types/Data Model, Integration anchors, Invariants, Verification hooks, and Files touched fields. Empty TBD placeholders fail. If any are still empty, return to per-slice grill-me for that slice.

2. **Verify frontmatter counters**:
   - `unresolved_qa_count == 0`
   - `unresolved_contract_count == 0`
   - `slice_count ==` actual slice count in `## Slice Contracts`
   - `architectural_qa_count` matches Q/A pairs in `## Decisions`
   - `per_slice_qa_count` matches Q/A pairs across all `#### Q/A` subsections

   If any check fails, return to the relevant grill-me phase. Do NOT flip status to complete.

3. **Update frontmatter** via Edit:
   - Set `status: complete`
   - Update `last_updated` to current date
   - Update `last_updated_by` to the User from the injected git context (fallback: "unknown")
   - Update `slices: [{contract_status}]` array — every entry should be `approved` or `revised`

4. **Verify template completeness**: Ensure all 16 sections from the template reference in Step 4 are present and filled. Edit to fix any gaps.

5. **Slice Contract block format reminder**:
   - Heading: `### Slice N: [name] — Contract`
   - Required field bullets in order: Inputs, Outputs, Types/Data Model, Integration anchors, Invariants, Verification hooks, Files touched
   - File entries inside Files touched carry `(NEW)` or `:line-range (MODIFY)` labels
   - `#### Q/A` subsection logs the per-slice grill-me transcript (one bullet per Q/A pair with `file:line` evidence)
   - No code blocks — contract fields are prose specs

## Step 8: Review & Iterate

1. **Present the design artifact location**:
   ```
   Design artifact written to:
   `thoughts/shared/designs/[filename].md`

   [N] architectural decisions fixed, [M] slices with full contracts.
   [A] architectural Q/As, [P] per-slice Q/As across the decomposition.

   Please review and let me know:
   - Are the architectural decisions correct?
   - Do the slice contracts capture the design you envision?
   - Any missing integration points or edge cases?

   When ready, run `/skill:plan2 thoughts/shared/designs/[filename].md` to synthesize per-slice code into phases.
   ```

2. **Handle follow-up changes**:
   - Use the Edit tool to update the design artifact in-place
   - Update frontmatter: `last_updated` and `last_updated_by`
   - Add `last_updated_note: "Updated [brief description]"` to frontmatter
   - If the change affects an architectural decision, return to Step 3 (architectural grill-me reopen)
   - If the change affects a slice contract, return to Step 5 (per-slice grill-me for that slice)
   - Update affected frontmatter counters

## Guidelines

1. **Be Architectural**: Design fixes architectural decisions and shapes contracts; plans synthesize code from contracts. Every architectural decision and every contract field must be grounded in `file:line` evidence from the actual codebase.

2. **Be Interactive**: Don't produce the full design in one shot. Walk the architectural decision-DAG to exhaustion first, get buy-in on the approach, decompose into slices, THEN walk each slice's contract DAG.

3. **Be Complete**: Slice contracts must be unambiguous enough that plan can synthesize copy-pasteable code from them. No TBD placeholders, no "implementer decides" cop-outs. If you can't fully specify a contract field, an architectural ambiguity wasn't resolved — return to Step 3.

4. **Be Skeptical**: Question vague requirements. If an existing pattern doesn't fit the new feature, say so and propose alternatives. Don't force a pattern where it doesn't belong.

5. **Resolve Everything**: No unresolved questions in the final artifact. If something is ambiguous, ask during the architectural grill-me or per-slice grill-me. The design must be complete enough that plan can synthesize phase code by reading contracts + Q/A pairs.

6. **Present Condensed, Persist Complete**: Micro-checkpoints show the developer condensed contract reviews. The artifact always contains full contract fields. If the developer asks to see the full contract, show it — but never default to walls of contract prose in checkpoints.

7. **No code in design**: Source code does NOT appear in the design artifact. The Slice Contracts section specifies inputs/outputs/anchors/invariants/verification, never implementation. Plan synthesizes implementation from the contract.

## Subagent Usage

| Context | Agents Spawned |
|---|---|
| Default (research artifact provided) | codebase-pattern-finder, codebase-analyzer, integration-scanner, precedent-locator |
| Novel work (new library/pattern) | + web-search-researcher |
| During architectural grill-me (correction path) | targeted codebase-analyzer for the new area (max 1-2) |
| During per-slice grill-me (5a clarification) | targeted codebase-analyzer when contract has `file:line` ambiguity (max 1) |

When agents are searching for different things, dispatch them as parallel `subagent(...)` tool calls in the same assistant message — multiple tool_use blocks in one response, not one call per turn. Call shape: `subagent({ agent: "<agent-name>", task: "<task>", context: "fresh", artifacts: false })`. Each agent runs in isolation — provide complete context in the prompt, including specific directory paths when the feature targets a known module. Don't write detailed prompts about HOW to search — just tell it what you're looking for and where.

## Important Notes

- **Always chained**: This skill requires a research artifact produced by the research skill. There is no standalone design mode.
- **File reading**: Always read research artifacts and referenced files FULLY (no limit/offset) before spawning agents
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read input files first (Step 1) before spawning agents (Step 2)
  - ALWAYS wait for all agents to complete before architectural grill-me (Step 3)
  - ALWAYS exit architectural grill-me via the two-gate check (depth + breadth) before decomposition (Step 4)
  - ALWAYS complete holistic decomposition before per-slice grill-me (Step 5)
  - ALWAYS create the skeleton artifact immediately after decomposition approval (Step 4)
  - NEVER make architectural commitments during 5a drafting — the orchestrator drafts, the developer decides; pull divergent-implementer choices as Q/As first
  - NEVER leave a slice contract with TBD placeholders after the slice is approved — fill via Edit in Step 5d
- NEVER skip the architectural grill-me or per-slice grill-me — developer input on architectural decisions and contract shape is the highest-value signal in the design process
- NEVER edit source files — all output goes into the design document, not the codebase. This skill produces a contract document, not implementation. Source file editing is implement's job; code synthesis is plan's job.
- **Contract is source of truth** — if the Slice Contracts section conflicts with Decisions prose, the contract fields win. Update the prose to match.
- **Checkpoint recordings**: Architectural Q/As live inline in `## Decisions` (per-decision Q/A trace). Per-slice Q/As live inside each slice's `#### Q/A` subsection in `## Slice Contracts`. `## Developer Context` records non-Q/A interactions (corrections, scope adjustments, rescans). Plan reads contract fields; plan IGNORES `#### Q/A` subsections (extends the Design History "plan ignores" annotation).
- **Frontmatter consistency**: Always include frontmatter, use snake_case for multi-word fields, keep tags relevant. Frontmatter counters (`architectural_qa_count`, `per_slice_qa_count`, `slice_count`, `unresolved_qa_count`, `unresolved_contract_count`, `slices: [...]`, `contract_fields_required`) are machine-validatable preflight signals plan uses to STOP on incomplete designs.
- CC auto-loads CLAUDE.md files when agents read files in a directory — no need to scan for them explicitly

## Common Design Patterns

- **New Features**: types first → backend logic → API surface → UI last. Research existing patterns first. Each slice's verification hooks include test surface alongside implementation surface.
- **Modifications**: Read current file FULLY in Step 1. Per-slice contracts capture only the modified portions in Files touched (`path:line-range (MODIFY)`) and Integration anchors. Check integration points for side effects.
- **Database Changes**: schema/migration → store/repository → business logic → API → client. Migration becomes a seventh dimension in Step 3's seed list. Include rollback strategy in the migration slice's Verification hooks.
- **Refactoring**: Document current behavior first via research. Plan incremental backwards-compatible changes — each slice contract preserves an invariant ("existing behavior preserved").
- **Novel Work**: Include approach comparison in Decisions Q/A trace. Ground in codebase evidence OR web research. Get explicit developer sign-off via the architectural grill-me exit gate BEFORE decomposing into slices.
