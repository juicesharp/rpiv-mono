---
name: architecture-review
description: Conduct a top-down, layer-by-layer architecture review of a software module by reading every file in scope, running a uniform 10-dimension checklist per layer, and triaging each candidate finding through a structured developer checkpoint. Produces a phased polish plan in .rpiv/artifacts/architecture-reviews/ that blueprint can consume per phase. Language-agnostic — works on TypeScript, Java, .NET, Rust, Python, Go, or any other typed module. Use before a 1.0 release, after a major refactor, or when a module has grown enough to warrant a structural audit.
argument-hint: "[target path: file, directory, or module]"
shell-timeout: 10
contract:
  produces:
    kind: produces
    meta:
      artifactKind: architecture-review
    data:
      type: object
      required: [phases]
      properties:
        status:
          enum: [in-progress, ready]
        layer_count:
          type: integer
          minimum: 1
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
              depends_on:
                type: array
                items: { type: integer, minimum: 1 }
              blast_radius:
                enum: [internal, public-API, on-disk, cross-module]
              effort:
                enum: [S, M, L]
  consumes:
    meta:
      world: target-path
---

# Architecture Review

You are tasked with conducting a layer-by-layer architecture review of a target module, producing a single living artifact that captures every triaged finding plus a phased polish plan downstream skills can consume.

## Input

`$ARGUMENTS` — target path (file, directory, or module). Empty input triggers a developer checkpoint to identify the target.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim — do not reformat the timezone offset.

## Flow

1. Identify target → 2. Plan layer structure → 3. Layer-split checkpoint → 4. Skeleton artifact → 5. Per-layer review (loop) → 6. Capture emergent principles → 7. Synthesize cross-cutting themes → 8. Phased polish plan → 9. Present and chain → 10. Follow-ups

The final artifact is blueprint-consumable per phase.

## Steps

### Step 1: Identify the Target

1. **Argument is empty:** use the `ask_user_question` tool with the following question: "What are we reviewing?". Header: "Target". Options: "Single module" (one package / project / crate / namespace directory); "Single subdirectory" (a subtree inside a module); "Single file" (deep review of one large file); "Other" (developer specifies path).

2. **Validate the target exists**. Use `ls` via the Bash tool on the resolved path. If missing, ask for a corrected path.

3. **Capture target context** into main context:
   - Read the target's manifest file if one exists (`package.json`, `pom.xml`, `*.csproj`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `build.gradle[.kts]`, `mix.exs`). The manifest names public exports, dependencies, and ecosystem.
   - Read any `README.md` or architecture doc at the target root.
   - For a single file: read it FULLY (no limit/offset).
   - Enumerate all source files in scope via `ls -R` or `find`, filtering by the extensions visible at the target root. Record total file count and LOC ballpark.

### Step 2: Plan Layer Structure

Layers mirror dependency direction. Higher layers consume lower-layer vocabulary, so the review walks from the public surface inward.

1. **Categorize each in-scope file by responsibility**. Typical role buckets:
   - Public surface / facade / entry point (the file users import)
   - Type vocabulary / shared types
   - Authoring DSL / public API
   - Command / dispatch / UI surface
   - Configuration / loaders
   - Validation
   - Orchestration / runtime
   - Sessions / I/O lifecycle
   - Persistence / on-disk format
   - Cross-cutting utilities

2. **For complex targets, dispatch parallel agents** to accelerate categorization:

   **Agent — codebase-locator:** "Map every source file in {target path} to one responsibility from the standard role buckets (facade, vocabulary, DSL, command, loaders, validation, orchestration, sessions, persistence, utilities). Return a file → responsibility table."

   **Agent — codebase-analyzer:** "For {target path}, identify the import / use-graph dependency direction. Which files are leaves? Which are hubs? Return a topo-ordered list from leaves to hubs."

   Wait for ALL agents to complete before proceeding.

3. **Synthesize a layer proposal:**
   - Group by responsibility, not file count. A layer is 1 file (a barrel) or 100+ files (an enterprise DAL); both are valid.
   - Top-down by review direction: entry point at Layer 0, deepest concern at Layer N. Entry point = library barrel / MVC controller / `lib.rs` / `__init__.py` / whatever the request hits first.
   - **Layers >~10 files: propose sub-layers** (3.1, 3.2, ...) grouped by file-name cohesion. Example .NET DAL: 3.1 `DbContext` + migrations; 3.2 entities + value objects; 3.3 entity configurations; 3.4 repositories; 3.5 specifications.
   - Aim for 3–10 top-level layers; sub-layers reviewable in one Step 5 pass.
   - Flag uncategorisable files as cross-cutting utility candidates.

### Step 3: Layer-Split Checkpoint

1. **Surface the proposal.** Use the `ask_user_question` tool with the following question: "Proposed split: {N} top-level layers, {file count} files. L0 — {names or count}; L1 — ...; {sub-layers if any: L3.1, L3.2, ...}. Approve?". Header: "Layers". Options: "Approve (Recommended)"; "Adjust split" (reorder / merge / split — describe); "Reduce scope" (drop layers — useful for monolith reviewed one bounded context at a time); "Specify manually".

2. **Loop until approved.** Adjustments re-enter Step 2.3 then return here.

### Step 4: Create Skeleton Artifact

1. **Read the template** at `${SKILL_DIR}/templates/architecture-review.md` FULLY (no limit/offset).

2. **Determine metadata** from the Metadata block above: filename `.rpiv/artifacts/architecture-reviews/<slug>_<topic>.md` (use `<slug>` from line 1; `<topic>` is a brief kebab-case description); `repository:` from `repo:`; `branch:` / `commit:` from matching labels; `author:` ← matching label (fallback: `unknown`); `date:` / `last_updated:` ← `<iso>` from line 1 (copy the offset verbatim).

3. **Write the skeleton** using the Write tool with `status: in-progress` in frontmatter. Sections:
   - **Frontmatter:** date, author, commit, branch, repository, target, target_kind, layer_count, `phases` (derived from the `### Phase N — name` headings — see Step 6), unresolved_finding_count, status, tags, last_updated, last_updated_by.
   - **Conventions:** finding shape (ID, Evidence, Current state, Desired state, Proposed improvement, Severity, Effort, Blast radius, Class, Status, Depends on, Cross-cut tag).
   - **Methodology principles:** empty placeholder (`_principles emerge during Step 5 triage and are captured at Step 6_`).
   - **Layers:** one `## Layer N — {name}` heading per layer from Step 3, each empty.
   - **Cross-cutting themes:** placeholder (`_written last, after all layers have been seen_`).
   - **Consolidated polish plan:** placeholder (`_phases assembled after Step 7 cross-cut synthesis_`).

4. **All subsequent writes use the Edit tool.** Never re-Write the whole file — the artifact is the durable checkpoint between sessions.

### Step 5: Per-Layer Review (Loop)

**For each layer (and sub-layer, if any) in order (L0, L0.1, L0.2, L1, L1.1, ...)**, run the five sub-steps below. The `## Layer N` section fills progressively; the tally at the end of each layer is the visible progress marker.

#### 5.1. Read Files

1. **Batch (large layer only).** When the layer wasn't pre-decomposed into sub-layers at Step 3 and holds >~10 files, propose batches by file-name cohesion (e.g., all `*Repository.cs`; all `*Configuration.cs`; `DbContext.cs` + migrations; entities). Confirm via the `ask_user_question` tool: "Layer {N}: {count} files. Batches: {B1 — count}; {B2 — count}; .... Approve?". Header: "Layer {N} batches". Options: "Approve"; "Adjust batches"; "Promote to sub-layers" (each batch becomes L{N}.{x} with its own tally).

2. **Read files FULLY** (no limit/offset) — the entire layer for unbatched, the current batch for batched.

3. **Resolve non-obvious call graphs.** For any file whose internal structure isn't clear from a single read, dispatch a parallel **codebase-analyzer** agent: "For {file path}: enumerate public-visible symbols, functions/methods, call sites. Report the call graph; highlight outsized functions."

4. **Verify external consumers** via the ecosystem's reference-finding pattern (`rg "from \"<module>\""`, `grep -r "import <pkg>"`, `grep -r "using <namespace>"`, `rg "use <crate>::"`). Hold counts in main context — feeds the wise-decision lens at triage.

5. **Iterate (batched layers only).** After 5.2–5.5 close for the current batch, return to step 2 for the next batch.

#### 5.2. Dimension Sweep

1. **Walk ten dimensions** across every file in the layer. Hold candidate findings in memory — do NOT triage yet.
   - **Boundary** — what does the layer own? Any leaks up or down?
   - **Public surface** — exported / public-visible names, types, ergonomics. Do siblings reach past the facade? Per-symbol consumer-count audit.
   - **Coherence / SRP** — does each file and each function/method do one thing?
   - **Granularity** — functions or methods too big or too small; god-parameter lists; over- or under-decomposed?
   - **Programming by intention** — does the file read top-down as a story? Named operations preferred over inline blocks? Helpers below entries?
   - **DRY** — duplicated patterns within the layer or across siblings?
   - **DDD / ubiquitous language** — domain vocabulary consistent? Any legacy names lingering?
   - **Naming** — file, type, function, constant names. Symmetric where the concept is symmetric?
   - **Error / fail-soft posture** — uniform across the layer? Multi-state returns use the language's idiomatic discriminated form?
   - **Module-graph hygiene** — no cycles. Type-only back-refs only where the language supports them.

2. **Produce a candidate findings list** (typically 6–14 per layer). Each candidate carries: ID (`L<layer>-<seq>`), Evidence (`file:line` + short quote), Current state, Desired state, Proposed improvement, Severity (Low / Med / High), Effort (S / M / L), Blast radius (internal / public-API / on-disk / cross-module), Class (polish vs redesign).

#### 5.3. Triage Each Candidate

1. **Present each candidate** as a structured triage question using the `ask_user_question` tool: "L{X}-{YY} — {headline}. Evidence: `file:line` ({short quote}). Current: {one sentence}. Desired: {one sentence}. Pick a triage outcome.". Header: "L{X}-{YY}". Options: "{Concrete option A — action}"; "{Concrete option B — action}"; "Defer" (post-release).

2. **Batch where independent.** 2–4 independent candidates per call when answers don't depend on each other; sequential when they do, or when blast-radius is `public-API` / `cross-module`.

3. **Author options to force the right calls:**
   - **Deletion candidates with zero current consumers:** ALWAYS include a "Keep as composition primitive" or "Keep as type-narrowing idiom" option alongside the drop option. The developer judges abstraction value, not the skill.
   - **Multi-state return candidates** (property-presence discrimination, partially-tagged shapes, null-as-state, exception-as-state): include "Convert to {target-language's discriminated form}" as an option. TypeScript: `{ kind: "ok" } | { kind: "err" }`. Java 17+: sealed interface + records. .NET 9+: records + pattern matching. Rust: `enum`. Kotlin: sealed class. Python 3.10+: matched `Union`. Go: tagged-struct + type switch.
   - **File-size candidates** (>~200 LOC for TS/Rust/Go; >~300 for Python/Kotlin; >~400 for C#; >~500 for Java): include "Split into `<layer>/` directory with one concern per file" with the proposed decomposition inlined.

#### 5.4. Persist Each Triaged Finding

1. **Edit the `## Layer N` section** the instant the developer picks an outcome. Append the finding with its full per-finding block.

2. **Set Status verbatim** from the chosen option: `**accepted** — {summary}` / `**rejected** — {reason}` / `**deferred** — post-release` / `**accepted (absorbed into LX-YY)**` when the change rides another finding.

3. **Maintain the counter.** Increment `unresolved_finding_count` in frontmatter when filing a candidate from 5.2; decrement on each triage outcome. Should hit zero before Step 6.

#### 5.5. Tally

1. **Append a tally table** at the end of each layer pass (or each batch within a layer):

   ```markdown
   ### Layer N — tally

   | Status | Count |
   |---|---|
   | accepted | {A} |
   | rejected | {R} |
   | deferred | {D} |
   | withdrawn | {W} |

   Cross-cutting tags introduced: {list}. Reused: {list}.
   Dependency edges within Layer N: {bullets, e.g., "L1-04 depends on L1-02"}.
   ```

2. **Batched-layer roll-up.** Prefix per-batch tallies with the batch ID (`### Layer 3 — batch 3.2 (Repositories) — tally`); after all batches close, append a `### Layer 3 — roll-up` table summing counts.

### Step 6: Capture Emergent Methodology Principles

1. **Identify candidates.** A principle typically surfaces when the developer reverses an earlier finding's status with a generalizable reason; picks the same option type across multiple independent triages; or articulates a rule that informs future review work.

2. **Ask explicitly.** Use the `ask_user_question` tool with the following question: "Across {F} findings, did any methodology principle emerge during triage that should be named?". Header: "Methodology". Options: "No new principle" (Recommended if none was articulated — proceed to cross-cut synthesis); "Capture one principle" (developer describes; skill drafts an M{N} block); "Capture multiple" (loop one at a time).

3. **Format captured principles** into the artifact's Methodology Principles section:

   ```markdown
   ### M{N} — {principle name}

   **Origin:** {finding ID + one-sentence quote from the developer's reasoning, if available}.

   **Rule.** {One paragraph: what to do, why, when to apply.}

   **Apply to (keep):** {bullet list.}
   **Apply to (drop / change):** {bullet list.}
   ```

### Step 7: Synthesize Cross-Cutting Themes

1. **Group findings by cross-cut tag** across all layers. Each tag becomes a theme.

2. **Write a section per theme** into `## Cross-cutting themes`:

   ```markdown
   ### T{N} — {theme name} ({active | closed by L{X}-{YY}})

   **Findings:** {comma-separated finding IDs}.

   {One paragraph: what unifies these findings, what the theme thread delivers when implemented, what the closing finding is if any.}
   ```

3. **Confirm grouping** via the `ask_user_question` tool: "{N} cross-cutting themes: {T1 — name; T2 — name; ...}. Approve grouping or adjust?". Header: "Themes". Options: "Approve grouping (Recommended)"; "Merge themes" (developer names which); "Split a theme" (developer names which); "Other".

### Step 8: Consolidated Polish Plan

Phases are agent-driven: each one will be handed to `blueprint` → `implement`. Size by signals blueprint can act on (file count, finding count, blast-radius mix, coordination need) — not by human-day estimates.

1. **Topo-sort findings** by `Depends on` edges. Dependency-free findings land in early phases.

2. **Group by leverage:**
   - **Foundation** (no dependencies, low risk) — tiny renames, new utility files, doc fixes.
   - **Vocabulary** — type renames, file renames.
   - **Locality** — moves of strings / constants / types to proper homes (one phase per locality theme).
   - **Structural** — file splits, directory restructures (one phase per layer's directory split).
   - **Behavioural** — shape conversions, dispatcher introductions, pipeline redesigns.
   - **Public-API** — additive surface changes requiring downstream coordination.

3. **Describe each phase by agent-relevant signals**, not days:
   - **Findings:** count + ID list.
   - **Files touched:** count + repo-relative paths.
   - **Blast-radius mix:** breakdown across `internal` / `public-API` / `on-disk` / `cross-module`.
   - **Coordination:** `none` / `sibling-package PR required` / `downstream consumer release required`.
   - **Class mix:** ratio of `polish` to `redesign` findings.

4. **Risk-flag** phases that touch on-disk format, public-API shape, or require cross-module coordination (sibling packages, downstream Maven artifacts, NuGet versioning, dependent crates).

5. **Draw the dependency graph** (ASCII) at the end of the plan section:

   ```
   Phase 1 (Foundation)
      ↓
   Phase 2 (Vocabulary)
      ↓
      ├──► Phase 3 (Locality)
      └──► Phase 4 (Structural)
                 ↓
       Phase 5 (Behavioural)
                 ↓
       Phase 6 (Public-API)
   ```

6. **Confirm the plan + flip status.** Use the `ask_user_question` tool: "{N} phases ({F} findings across {Files} files). Approve or adjust?". Header: "Plan". Options: "Approve (Recommended)" (**rebuild the `phases:` frontmatter array from the `### Phase N — name` headings** — one `{ n, title, depends_on, blast_radius, effort }` entry per heading, in body order: `depends_on` from the dependency graph (Step 5, earlier phases only), `blast_radius` the phase's widest of `internal`/`public-API`/`on-disk`/`cross-module` (Step 3), `effort` `S`/`M`/`L`; e.g. `phases: [{ n: 1, title: Foundation, depends_on: [], blast_radius: internal, effort: S }, { n: 2, title: Vocabulary, depends_on: [1], blast_radius: internal, effort: M }]`; then Edit frontmatter `status: in-progress` → `status: ready`, proceed to Step 9); "Adjust phase boundaries" (describe); "Resequence phases" (describe); "Other".

### Step 9: Present and Chain

1. **Display the completion summary:**

   ```
   Architecture review written to:
   `.rpiv/artifacts/architecture-reviews/{filename}.md`

   {F} findings reviewed: {A} accepted, {R} rejected, {D} deferred, {W} withdrawn.
   {P} methodology principles captured, {T} cross-cutting themes, {N} phases across {Files} files.

   The artifact is blueprint-consumable per phase:

   **Next step (per-phase landing):**
   - `/skill:blueprint .rpiv/artifacts/architecture-reviews/{filename}.md` followed by free-text "Implement Phase 1: {phase name}" — blueprint treats the named phase as the feature scope.
   - Repeat for each phase.

   > 🆕 Tip: start a fresh session with `/new` before each blueprint invocation — chained skills work best with a clean context window.
   ```

### Step 10: Handle Follow-ups

1. **Append, never rewrite.** Append a `## Follow-up Review {ISO 8601 timestamp}` section. Prior content stays immutable.

2. **Bump frontmatter.** Update `last_updated` + `last_updated_by`; set `last_updated_note: "Updated <brief description>"`.

3. **When to re-invoke instead.** If the target has materially changed (new files, restructured layers), re-run `/skill:architecture-review` for a fresh artifact.

## Guidelines

1. **Be Structural**: Every checkpoint is `ask_user_question` with concrete options. Never prose "what do you think?". The developer answers; the skill captures.

2. **Be Grounded**: Every finding cites `file:line` + a short quote. Triage questions embed the evidence verbatim. If you can't ground a candidate in code, it's not a finding.

3. **Be Top-Down**: Walk facade / entry point first (Layer 0), persistence last. Higher layers depend on lower layers — fixing the public surface before the runtime would invert the dependency direction.

4. **Be Cumulative**: Each layer's tally + each finding's cross-cut tag feed Step 7's synthesis. The tally is the visible progress marker — never skip it.

5. **Be Linear**: Findings depend on each other. Topo-sort before phasing. A rename lands before a directory split that uses the new name.

6. **Be Patient with the Wise-Decision Lens**: When a candidate proposes dropping a symbol with no current consumers, the deletion option is ONE of the choices — never the only one. The developer judges abstraction value.

## Subagent Usage

| Context | Agents Spawned |
|---|---|
| Step 2 layer discovery (complex targets) | codebase-locator + codebase-analyzer in parallel |
| Step 5.1 deep-file analysis (any file whose call graph isn't obvious) | codebase-analyzer (one per file or one batched) |
| Step 5.1 external-consumer audit | inline grep / ripgrep via Bash (no agent needed) |
| Step 10 follow-up rescan (if scope expanded) | codebase-analyzer (max 1–2) |

Spawn multiple agents in parallel when they're searching for different things. Each agent runs in isolation — provide complete context in the prompt, including the target path.

## Important Notes

- **All checkpoints are `ask_user_question`** — no prose "ask the user". The tool always offers free-text via "Other"; don't author free-text prompts.
- **Read all in-scope files FULLY** in Step 5.1 — no limit/offset on the Read tool. Selective reads bias findings toward what you happened to load.
- **Edit the artifact progressively in Step 5.4** — never batch all findings into one final write. The artifact is the durable checkpoint between sessions.
- **Critical ordering:**
  - ALWAYS confirm the layer split at Step 3 BEFORE creating the skeleton artifact (Step 4).
  - ALWAYS read every file in a layer (Step 5.1) BEFORE producing the candidate findings list (Step 5.2).
  - ALWAYS triage via `ask_user_question` (Step 5.3) — never auto-accept a finding even when the answer seems obvious.
  - ALWAYS Edit the artifact immediately after each triage outcome (Step 5.4) — never queue accepted findings for a batch write at the end of the layer.
  - ALWAYS run Step 6 methodology capture BEFORE Step 7 cross-cut synthesis — a principle named at Step 6 informs theme labeling.
  - NEVER skip the per-layer tally at Step 5.5 — it's the visible progress marker.
  - NEVER edit source files during the review — the artifact is the product; implementation is blueprint's job (Step 9 hands off).
- **Methodology emerges from triage**, never from a pre-baked list. Step 6 is the dedicated capture point; principles named earlier (e.g., during Step 5 when the developer reverses a finding) are recorded inline at the time and reformatted into Methodology Principles at Step 6.
- **The artifact is blueprint-consumable per phase** — per-phase blueprint invocations are the supported chaining pattern, not whole-artifact blueprint invocations.
- **Frontmatter consistency**: Always include frontmatter; use snake_case for multi-word fields; keep tags relevant.
- **Status invariants**: `in-progress` during Steps 1–7; flips to `ready` at Step 8 confirmation.
