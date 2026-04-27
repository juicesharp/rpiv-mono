---
name: plan2
description: Synthesize implementation plans from design artifacts. One design slice maps 1:1 to one plan phase, synthesized in topological order, with per-phase Success Criteria. Produces plans in thoughts/shared/plans/. Use after design.
argument-hint: [design artifact path]
---

# Write Plan

You are tasked with synthesizing implementation plans from design artifacts. The design artifact contains all architectural decisions, per-slice Slice Contracts, and Q/A pairs — but NO source code. Your job is to synthesize contract-fulfilling code one phase at a time in topological order. Each design slice maps 1:1 to a plan phase; the plan artifact is phase-shaped from skeleton-write onward and consumed by `/skill:implement` phase by phase.

## Step 1: Read Design Artifact

When this command is invoked:

1. **Determine input mode**:

   **Design artifact provided** (path to a `.md` file in `thoughts/shared/designs/`):
   - Read the design artifact FULLY using the Read tool WITHOUT limit/offset
   - Extract: Slice Contracts, Decisions (architectural Q/A trace), File Map, Ordering Constraints, Verification Notes, Performance Considerations, Migration Notes, Scope, Pattern References
   - Architectural decisions and slice contracts are settled — do not re-evaluate them
   - **Two-pass STOP gate**:
     - **Pass A**: Frontmatter `unresolved_qa_count == 0`. If > 0 or missing, STOP — tell the developer to return to design (architectural grill-me or per-slice grill-me has unresolved Q/As).
     - **Pass B**: Frontmatter `unresolved_contract_count == 0` AND every slice in `## Slice Contracts` has populated Inputs, Outputs, Types/Data Model, Integration anchors, Invariants, Verification hooks, Files touched (no TBD placeholders). If any contract is incomplete, STOP — tell the developer to return to design Step 5 for the affected slice.
   - **Pre-restructure designs** (no `slices:` frontmatter array): treat as legacy. STOP with: "This design predates the contract restructure. Re-run /skill:design2 to produce a contract-format artifact." Do NOT attempt to plan a legacy design.

   **No arguments provided**:
   ```
   I'll synthesize an implementation plan from a design artifact. Please provide the path:

   `/skill:plan2 thoughts/shared/designs/2026-01-20_09-30-00_feature.md`

   Run `/skill:design2` first to produce the design artifact. There is no standalone path.
   ```
   Then wait for input.

2. **Read any additional files mentioned** in the design's References — research documents, tickets. Read them FULLY for context.

3. **Read each Pattern Reference**: For every `path/to/similar.ext:line-range` in the design's `## Pattern References`, read the cited range FULLY. These are the templates plan synthesizes against.

4. **Anchor reverification gate** — runs every plan2 invocation, unconditionally. Source code drifts between runs; a prior `last_updated_note` is an audit entry, not a skip signal. Re-read every anchor every time. For every `file:line` (or `file:line-range`) cited in each slice's `Integration anchors` and `Files touched` fields under `## Slice Contracts`, read the cited range using the Read tool with the line offset.
   - **If the cited range still contains the symbol/text the contract describes** (e.g., the schema, interface, function, or call site referenced in prose): proceed.
   - **If the line range has drifted** (the cited symbol now lives at a different line range in the same file): use the Edit tool to update every occurrence of the stale `file:line` in the design artifact to the correct line range, and bump frontmatter `last_updated` + `last_updated_by` + append a dated audit entry to `last_updated_note` of the form `"<YYYY-MM-DD HH:MM>: anchor reverification adjusted <slice-id>:<old-range> → <new-range> in <file>"`.
   - **If the cited symbol is gone** (renamed, deleted, or moved): STOP — return the developer to /skill:design2 Step 5. Do NOT guess at a corrected anchor.

## Step 2: Per-Phase Synthesis Loop

Synthesis runs one phase at a time in topological order (`depends_on` of the corresponding design slice). One design slice = one plan phase. Each iteration produces complete, copy-pasteable code for one slice's contract written under `## Phase N` in the plan artifact.

1. **Write the phase-shaped skeleton** to `thoughts/shared/plans/YYYY-MM-DD_HH-MM-SS_description.md`:
   - Filename format: `YYYY-MM-DD_HH-MM-SS_description.md` (kebab-case description, ticket prefix optional). Examples: `2026-01-08_14-30-00_ENG-1478-parent-child-tracking.md`, `2026-01-08_14-30-00_improve-error-handling.md`.
   - One phase per design slice, in topological order (`depends_on`). Skeleton includes everything EXCEPT code blocks: frontmatter, Overview, Desired End State, What We're NOT Doing, one `## Phase N: [slice name]` section per slice with `### Overview` (one sentence + parallelism note from `depends_on`), `### Changes Required:` placeholders sourced from the design's `Files touched` and Verification hooks (no code), and `### Success Criteria:` (Automated + Manual placeholders per the Success Criteria Conversion section), Performance Considerations, Migration Notes, References, and a `## Plan History` section listing each phase as `— pending`.
   - Skeleton frontmatter MUST include: `slice_count` (informational, from design), `phase_count` (= `slice_count`), `unresolved_phase_count` (initialized to `phase_count`, decrements as each phase's synthesis is approved).

2. **Topological order**: Sort slices by `depends_on` so every slice's prerequisites are already synthesized and written to the artifact before its own synthesis begins.

3. **Parallel pre-fetch of pattern-finder for every slice (Step 2.0)**.

   **Hard rule — fan-out, not loop.** Emit ONE assistant message that contains N `subagent(...)` tool calls, where N = `slice_count`. Every slice's pattern-finder dispatches in the SAME message as a separate `tool_use` block. The model that emits this message MUST list all N tool calls before sending. If you find yourself sending one tool call per assistant turn, STOP — you are violating Step 2.0; restart the message with all N blocks together.

   Forbidden anti-patterns:
   - One `subagent(...)` call per assistant message, looping through slices serially.
   - Mixing pattern-finder dispatches with synthesis or other tool calls.
   - Dispatching pattern-finder for "the next slice" inside the topological loop (Step 2a) — pattern-finder is pre-fetched ONCE for ALL slices before the loop starts.

   Required shape — one assistant message with N parallel blocks (illustration for N=3; scale to actual `slice_count`):

   ```
   subagent({ agent: "codebase-pattern-finder", task: "<contract excerpt for Slice 1>", context: "fresh", artifacts: false })
   subagent({ agent: "codebase-pattern-finder", task: "<contract excerpt for Slice 2>", context: "fresh", artifacts: false })
   subagent({ agent: "codebase-pattern-finder", task: "<contract excerpt for Slice 3>", context: "fresh", artifacts: false })
   ```

   Each `task` prompt includes that slice's contract excerpt verbatim:

   ```
   "Find code templates I can model the [slice name] implementation after.

   Contract excerpt from the design artifact:
     Inputs: <slice Inputs field verbatim>
     Outputs: <slice Outputs field verbatim>
     Types/Data Model: <slice Types field verbatim>
     Files touched: <slice Files touched field verbatim>
   Change classification: <NEW module | narrow-edit | replacement | config>
   Pattern References from design: <paths from ## Pattern References that name this slice>
   Integration anchors: <slice Integration anchors verbatim>

   Return paste-ready snippets that match BOTH the shape and the contract."
   ```

   Wait for ALL pattern-finder calls to return before entering the topological loop. Cache results keyed by slice name. The synthesis loop consumes from this cache — do NOT re-dispatch pattern-finder per slice.

**For each slice in topological order:**

### 2a. Per-phase spot-checks, conditional dispatches, synthesize

- **Spot-check anchors**: Re-read every `file:line` in this slice's `Integration anchors` and `Files touched` (the artifact-level reverification ran once in Step 1.4; this catches drift introduced by an earlier slice's MODIFY in this same plan run). If a cited symbol moved, Edit the design artifact to correct the line range. If gone, STOP — return to /skill:design2 Step 5 for this slice.
- **Read prior phases' synthesized code from the artifact**: For each slice in this slice's `depends_on`, read its `## Phase N` section in the in-progress plan. Imports and types come from the actually-emitted code, not the contract abstraction.
- **Conditional dispatches** (run in parallel as `subagent(...)` blocks in one assistant message; only those that apply):
  - Any `Files touched` entry is MODIFY → dispatch **integration-scanner** for that file/symbol. Task: "Map current callsites and wiring for [symbol] at [file]. List inbound references that must be preserved or updated, outbound dependencies the new code will inherit, and any config / event registration the symbol participates in."
  - Change classification is replacement (closure / function rewrite > 20 lines) → dispatch **precedent-locator**. Task: "Find prior commits in this repository that performed similar [closure / function] rewrites at comparable size. Return commit SHAs, file paths, and any follow-up fix commits."
  - An Integration anchor's surrounding code shape isn't obvious from the contract → dispatch **codebase-analyzer** (max 1) for that anchor.
  - Pattern-finder cache returned no patterns AND Pattern References are empty → dispatch **web-search-researcher** for external documentation.
- Wait for all dispatched agents to return before synthesizing.

**MODIFY test-cascade.** When integration-scanner reports inbound references inside test files (`*.test.ts`, `*.spec.ts`) for any symbol this slice modifies, those test files become additional MODIFY entries in this slice's `### Changes Required:`. Synthesize updated test code that matches the slice's new signatures so existing test imports do not break. These cascaded test entries are independent of the slice's Verification hooks (which produce NEW test files) — these are pre-existing tests whose imports / type expectations would otherwise break under the modification.

After agents return, **synthesize contract-fulfilling code in the orchestrator** for this single slice:
- Use pattern-finder cache snippets as templates
- Apply this slice's contract Inputs/Outputs/Types/Integration anchors as the spec
- Honor architectural Q/A guardrails from `## Decisions` and per-slice Q/A constraints from the slice's `#### Q/A`
- Resolve imports against prior slices' actually-emitted exports (read from the artifact), not contract prose
- For MODIFY slices, preserve every callsite and wiring relationship reported by integration-scanner
- For replacement-class slices, reference precedent-locator findings as the structural template
- The code MUST fulfill the contract; the orchestrator must NOT invent new design decisions

**Tests as first-class entries.** Every test name in this slice's `Verification hooks` becomes a `#### N. <test-name>` entry under `### Changes Required:` with a real Vitest code block that satisfies the copy-pasteable contract (Step 2b). Co-locate `*.test.ts` next to the production source. Grep-pattern hooks → `expect(...)` matchers; observable-behavior hooks → assertions on `render(width)` / return shapes / factory-driver outcomes. If the test cannot be synthesized from the contract alone, STOP and return to /skill:design2 Step 5 — never emit a placeholder.

### 2b. Self-verify slice

Cross-check this slice's synthesized code and produce a structured summary:

```
Self-verify Slice N: [name]
- Contract fulfillment: [OK / VIOLATION: contract field X not satisfied]
- Q/A guardrails: [OK / VIOLATION: architectural decision Y violated]
- Cross-slice: [OK / CONFLICT: imports from Slice M reference symbols not emitted]
- Research: [OK / WARNING: Verification Note Z not satisfied]
- Copy-pasteable: [OK / VIOLATION: code block <file> not paste-ready]
- Decision traceability: [OK / VIOLATION: Decision <D-id> "<title>" has no matching code at <plan-file>:<line-range>]
```

**Decision traceability** (mechanical map, not prose). For each entry under the design's `## Decisions` section that this slice is responsible for implementing (a Decision is owned by a slice when its specifics are encoded in any of that slice's contract fields), identify the synthesized lines that implement the Decision's specifics. Record the mapping inline in the self-verify summary as `<D-id>: <plan-file>:<line-range>`. If any owned Decision has no matching code in this slice, the synthesis violated the design — re-synthesize. The point is to grep design Decisions against synthesized output, not to restate them in prose.

**Enumerated-set fidelity**. When a slice's contract enumerates a closed set (discriminated-union kinds, mode names, action types, key-binding names, error codes), the synthesized code emits exactly that set. Count the design's enumeration; count the plan's emission; mismatch in either direction is a violation. If synthesis discovers the set is insufficient, STOP and return to /skill:design2 Step 5 — do not silently expand it.

**Copy-pasteable contract** (happy-path enforcement). You are writing real implementation, not a sketch. Every code block MUST:

- Be paste-into-editor ready — `npm run check` (Biome + `tsc --noEmit`) passes against it. Every value concrete, every signature fully typed, every import resolves to a real export, every literal fully populated (no `{ ... }`, no `[ ... ]`).
- Stand alone per file — a reader needs nothing beyond the code block and its imports.
- Include the entire body of any function / method / closure the contract says is replaced — emit the whole thing, never a description.
- Have function bodies that compute the value their name and contract describe. Hardcoded returns (`return false`, `return constant`, `return param.length`) are stubs unless the contract says the function is a constant.
- Resolve every identifier to a declaration that precedes it in execution order. No TDZ, no forward-reference of `let` / `const` from inside an arrow that runs at construction time.
- Contain no deferred-work comment: `// TODO`, `// FIXME`, `// would need`, `// handled at <X>`, `// see <Y>`, `// for now`, `// later`, `// reset method needed`. If you catch yourself writing such a comment, the synthesis is incomplete — STOP and surface the gap.
- For any block whose contract says a function, closure, switch, or method is replaced, the AFTER state is the executable body itself, not a comment outline of it. Diff narration (`// BEFORE: ... // AFTER: ...`) may precede the block but never substitutes for it. Cases, branches, and statements the contract enumerates appear as real `case` / `if` / statements, not commented placeholders.
- A symbol marked `// REMOVED: <name>` must not appear in any AFTER body in the same phase. Grep the phase for `<name>`; any surviving reference falsifies the REMOVED claim.

If a contract's scope can't fit a single complete code block, the slice was under-decomposed — STOP and return to /skill:design2 Step 5.

**Self-heal on violation**: If any line above reports VIOLATION / CONFLICT / WARNING, re-synthesize the affected file once and re-run self-verify. If the second self-verify still reports a violation, STOP and surface the specific violation to the developer with the slice name, file, and the failing check — request guidance before proceeding.

### 2c. Write to artifact

**One phase, one cycle.** Steps 2a → 2b → 2c are a single transaction for ONE phase. Complete this phase's 2c artifact write before starting phase N+1's 2a. Never:
- Use the `Write` tool on the artifact (only `Edit`)
- Batch edits across multiple phase sections in one tool call
- Synthesize multiple phases' code in memory and then write them together
- Rewrite the entire artifact "for consistency" — the skeleton is already consistent

Each `Edit` call targets exactly one `## Phase N` section. If a single phase needs multiple Edits (one per file in `### Changes Required:`), issue them sequentially to disjoint regions of that phase's section.

On clean self-verify (all OK), Edit the artifact in place:
1. For each file in this phase, replace the phase's `### Changes Required:` placeholders with the synthesized code blocks.
2. Append to `## Plan History`: `- Phase N: [name] — synthesized`.
3. Decrement frontmatter `unresolved_phase_count` by 1.
4. Proceed to the next phase in topological order.

**Use this template structure** (the artifact's final shape; phases are written into the skeleton at Step 2.1 and progressively filled by 2c):

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
slice_count: [S, copied from design frontmatter — informational]
phase_count: [P, equal to slice_count]
unresolved_phase_count: [decrements as each phase synthesizes in Step 2; 0 means synthesis complete]
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
[What this phase accomplishes — fulfills slice [S]; parallelism note from `depends_on`]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]
**Fulfills**: Slice [S] contract Inputs/Outputs/Anchors

```[language]
// Synthesized from Slice [S] contract; pattern source: <pattern-finder file:line>
```

#### 2. [Test name from slice's Verification hooks]
**File**: `path/to/file.test.ext`
**Fulfills**: Slice [S] Verification hook: `<hook test name>`

```[language]
// Synthesized from Slice [S] Verification hook; pattern source: <existing *.test.ext file:line>
```

(One Changes Required entry per Verification hook test name.)

### Success Criteria:

#### Automated Verification:
- [ ] `npm run check` passes
- [ ] `npm test` passes

#### Manual Verification:
- [ ] [From design's Verification Notes — observable behaviors not expressible as tests]

---

## Phase 2: [Descriptive Name]

[Similar structure...]

---

## Plan History

- Phase 1: [name] — synthesized
- Phase 2: [name] — synthesized

## Performance Considerations

[Copied from design artifact.]

## Migration Notes

[Copied from design artifact, or empty if N/A.]

## References

- Design: `thoughts/shared/designs/[file].md`
- Research: `thoughts/shared/research/[file].md`
- Original ticket (if any): `thoughts/me/tickets/[file].md`
```

## Step 3: Cross-Phase Integration Verify

After all phases are synthesized (`unresolved_phase_count == 0`), verify consistency across the synthesized phases via `claim-verifier`. The orchestrator builds an explicit claim list mechanically from design + skeleton; the agent grounds each claim against the in-progress plan and emits Verified / Weakened / Falsified per row.

1. **Build the claim list.** Walk the design + the in-progress plan artifact. For each phase N (which corresponds 1:1 with design slice N), emit one claim row per expected invariant. Use a stable ID scheme: `<phase-id>-<check-id>-<seq>` (e.g., `P3-EXPORT-1`, `P5-IMPORT-2`). Claim categories:

   - **EXPORT**: each symbol named in the slice's `Outputs` / `Types/Data Model` is exported from the phase's synthesized code at `<plan-file>:<line>`.
   - **IMPORT**: each `depends_on` reference resolves to a real export of the prior phase (cite the import line in this phase and the export line in the prior phase).
   - **FILE-MAP**: each entry in the design's `## File Map` has a synthesized code block in exactly one phase.
   - **TEST-ENTRY**: each test name in the slice's `Verification hooks` has a `#### N. <test-name>` Changes Required entry under that phase.
   - **DECISION-SPEC**: for each Decision owned by this slice, claim its specifics — what symbol does what at which line. Example: "D<N> (<title>) → case `<action>` sets `<flag-A> = true` (NOT a similarly named `<flag-B>`) at `<line>`."
   - **SET-CARDINALITY**: for each closed set the design enumerates, claim the plan emits the same members at the same count. Format: "Slice <N> enumerates {a, b, c} (count=3); plan emits {a, b, c} at `<line>` (count=3)." Extra, missing, or renamed members → Falsified.
   - **MODIFY-BODY**: for each MODIFY entry, claim the AFTER block contains executable statements at `<line>` (real declarations / cases / branches), not commented narration. A block whose AFTER body is `//` lines only → Falsified.
   - **REMOVED-SURVIVOR**: for each `// REMOVED: <name>` annotation, claim `<name>` does not appear in any AFTER body across all phases. Any surviving reference → Falsified.
   - **VERIFICATION-NOTE**: each item in the design's `## Verification Notes` is satisfied by some synthesized code or test (cite the satisfying location).
   - **METHOD-USAGE**: each public method / setter / factory-output member declared on a class or object in any phase has at least one call site in a downstream phase OR is documented as intentionally unused.
   - **COMMENT-REF**: each comment referencing work performed elsewhere ("handled at integration layer", "managed by Slice X", "see Y", "reset in caller") cites a location that actually performs that work.
   - **SEMANTIC-CLAIM**: for each behavior-prescribing `#### Q/A` clause (verb-led: cancels / sets / rebuilds / activates — not noun-led: is / has), claim what the code does at a specific line. Examples:
     - "Slice <N> Q/A '<verb-led behavior clause>' → handler `<name>` performs `<observable mutation>` at `<line>`."
     - "Slice <N> Outputs '<derivation rule citing a domain field>' → mapper uses the domain field (NOT iteration-index `i`) at `<line>`."
   - **ANCHOR**: each `file:line` cited in any slice's `Integration anchors` still matches the symbol it's claimed to anchor in the source repository.

2. **Dispatch `claim-verifier`** with the claim list:

   ```
   subagent({
     agent: "claim-verifier",
     task: "Verify each claim below against <plan artifact path> and <design artifact path>. Ground non-ANCHOR claims in the plan artifact's '## Phase N' code blocks; ANCHOR claims in the cited source file. Emit one row per claim:

     FINDING <id> | <Verified|Weakened|Falsified> | <one-line justification with file:line>

     Claims:
     <id-1> | <category> | <claim text with cited <file:line> evidence the orchestrator expects to see>
     <id-2> | <category> | ...
     ...",
     context: "fresh",
     artifacts: false
   })
   ```

3. **Present integration summary** (under 15 lines):
   ```
   Integration: [feature name] — [P] phases synthesized
   Phases: [brief list of phase names and file counts]
   Claims verified: [N] | Weakened: [W] | Falsified: [F]
   ```

4. **On any Falsified or Weakened row**: parse the phase from the claim ID, return to Step 2 for that phase, re-synthesize once, then rebuild the claim list and re-dispatch `claim-verifier`. If any row is still Falsified/Weakened after one auto-resynthesis cycle, STOP and surface those rows to the developer for guidance.

5. **On all Verified**: proceed directly to finalize.

6. **Finalize**: Set frontmatter `status: ready`, `unresolved_phase_count: 0`. Present:

   ```
   Implementation plan written to: thoughts/shared/plans/[filename].md
   [P] phases synthesized, [F] total file changes.
   Run `/skill:implement thoughts/shared/plans/[filename].md Phase 1` when ready.
   ```

7. **Iterate on feedback**: adjust Success Criteria, return to Step 2 for a wrong phase, or return to /skill:design2 Step 5 for an under-specified contract.

## Guidelines

- **No routine developer touchpoint**: synthesis runs end-to-end. Stop and surface only on real failure signals — self-verify still violating after one auto-retry, Step 3 finding still present after one auto-resynthesis, an anchor whose cited symbol is gone, or a contract proven under-specified during synthesis.
- **Trust the design**: Slice Contracts and Decisions are fixed. If a contract is wrong or under-specified, return to /skill:design2 Step 5 — do not silently change the approach.
- **No open questions in the final plan**: Step 1's two-pass STOP gate already filtered them. If new questions surface during synthesis, the contract is under-specified — STOP and return to design2.

## Success Criteria Conversion

Each phase's `### Success Criteria:` always splits into Automated and Manual.

**Format example:**
```markdown
### Success Criteria:

#### Automated Verification:
- [ ] All unit tests pass: `npm test`
- [ ] No linting errors: `npm run check`
- [ ] Grep pattern from Slice 1 Verification hook: `grep -r "newApiCall" packages/ | wc -l` returns >= 3
- [ ] API endpoint returns 200: `curl localhost:8080/api/new-endpoint`

#### Manual Verification:
- [ ] New feature appears correctly in the UI
- [ ] Performance is acceptable with 1000+ items
- [ ] Error messages are user-friendly
- [ ] Feature works correctly on mobile devices
```

**Convert design's Verification Notes AND each slice's Verification hooks to success criteria:**
- Slice Verification hook test names → automated `npm test` matchers
- Slice Verification hook grep patterns → `grep -r "..." | wc -l` automated checks
- Slice Verification hook observable behaviors → manual verification steps
- Artifact-level Verification Notes (precedents/warnings) → cross-phase manual verification
- Prose warnings → specific automated commands or manual steps

## Important Notes

- NEVER edit source files — this skill produces a plan document, not implementation.
- **Never write the artifact whole**: after Step 1's skeleton, only `Edit` operations touch the artifact, and each `Edit` is scoped to a single `## Phase N` section. Batched cross-phase Edits and full-file rewrites are forbidden — they cause overlap errors and break the per-phase transaction.
- **One slice per phase**: each design slice maps to exactly one plan phase, in topological order from `depends_on`. No grouping at synthesis time, no packaging step.
- **Read prior phases' emitted code, not their contracts**: when synthesizing a phase whose slice has `depends_on`, import against the actually-emitted exports in prior `## Phase N` sections, not the abstract contract.
- **Agents fulfill contracts, never invent decisions** — pattern-finder (Step 2.0 templates), integration-scanner (Step 2a MODIFY), precedent-locator (Step 2a replacement), codebase-analyzer (Step 2a anchor ambiguity), web-search-researcher (Step 2a novel work), and claim-verifier (Step 3 cross-phase verification) return templates, analysis, or row-tagged findings; the orchestrator synthesizes.
- **Frontmatter consistency**: snake_case for multi-word field names.
- **Pre-restructure design refusal**: if the design lacks the `slices:` frontmatter array, STOP and instruct the developer to re-run /skill:design2.
