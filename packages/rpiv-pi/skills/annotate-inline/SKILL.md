---
name: annotate-inline
description: Generate CLAUDE.md files across a project by analyzing architecture and patterns in parallel. Auto-detects architecture, proposes locations, and batch-writes compact documentation. Use for onboarding or improving AI assistant context.
argument-hint: [target-directory]
allowed-tools: subagent, Read, Write, Glob, Grep
---

# Annotate Project

You are tasked with generating CLAUDE.md files across a brownfield project. You will map the project structure, auto-detect its architecture, analyze each architectural layer, and batch-write compact CLAUDE.md files at the root and relevant subdirectories.

## Initial Setup:

Use the current working directory as the target project by default. If the user provides a specific directory path as an argument, use that instead.

## Steps to follow:

1. **Read any directly mentioned files first:**
   - If the user mentions specific files (existing CLAUDE.md, architecture docs, READMEs), read them FULLY first
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
   - **CRITICAL**: Read these files yourself in the main context before invoking any skills
   - This ensures you have full context before decomposing the work

2. **Pass 1 — Map the project (parallel agents):**
   - Spawn the following agents in parallel using the subagent tool:

   **Agent A — Project tree mapping:**
   - agent: `codebase-locator`
   - Prompt: "Map the full project tree structure for [target directory]. List all directories and their contents, respecting .gitignore. Focus on source code directories, configuration files, and build artifacts. Return a complete tree view."

   **Agent B — Architecture and conventions:**
   - agent: `codebase-locator`
   - Prompt: "Identify the architectural layout of [target directory] from path shape and manifest files — NO content analysis. Detect: (1) Architecture pattern inferred from folder shape — clean-arch via Domain/Application/Infrastructure dirs; MVC via Controllers/Models/Views; monorepo via packages/* + workspaces; microservices via services/* with individual manifests; hexagonal via ports/adapters. (2) Main layers/modules — top-level source directories + their names. (3) Frameworks and languages from manifest files (package.json dependencies, *.csproj TargetFramework, pyproject.toml, go.mod, Cargo.toml) and file extensions. (4) Build system from build-config filenames (vite/webpack/tsup/esbuild configs, Makefile, nx.json, turbo.json, dotnet .sln). For each main layer/module, check sub-directory composition. If sub-directories with distinct names/roles exist, flag each as a CLAUDE.md target candidate with: (a) path, (b) role inferred from folder name (controllers/, services/, entities/, components/, stores/, etc.), (c) file count via ls, (d) how its sub-directory composition differs from sibling layers. Use grep/find/ls only. Do not read file contents. Pass 2 runs codebase-analyzer + codebase-pattern-finder per target folder for deep analysis."

   - While agents run, read .gitignore yourself to understand exclusion rules

3. **Wait for Pass 1 and determine CLAUDE.md targets:**
   - IMPORTANT: Wait for ALL agents from Pass 1 to complete before proceeding
   - Synthesize the tree structure and architecture findings
   - Auto-detect the architecture pattern (clean architecture, MVC, monorepo, microservices, etc.)
   - Determine CLAUDE.md targets using a two-pass process:

     **Initial pass — identify top-level targets:**
     - Apply the CLAUDE.md Depth Rules (see below) to top-level architectural layers
     - This produces the initial target list (one per distinct layer/project)

     **Decomposition pass — expand composite targets (ADD, never REPLACE):**
     - For EACH initial target, review Agent B's sub-layer candidates
     - If Agent B flagged sub-layers with distinct roles and file counts >10, ADD them as separate CLAUDE.md targets alongside the parent — the parent stays in the list as an overview, sub-layers are added beneath it
     - NEVER remove the parent when promoting sub-layers — decomposition expands the target list, it does not substitute entries
     - Do NOT apply a blanket "sub-folders same as parent" skip — evaluate each sub-layer Agent B flagged individually against the Depth Rules
     - Common decompositions: Angular/React/Vue apps → components/, services/, shared/; monorepo packages → per-package; large shared libraries → per-concern

   - Present the proposed CLAUDE.md locations to the user:
     ```
     ## Proposed CLAUDE.md Locations

     Architecture detected: [pattern name]

     ### Will create CLAUDE.md in:
     - `/` (root) — Project overview (compact)
     - `/src/core/` — Core domain layer
     - `/src/services/` — Service layer
     - [etc.]

     ### Will skip:
     - `/src/core/entities/` — Entity grouping, same pattern as parent
     - [etc.]

     Does this look right? Should I add or remove any locations?
     ```
   - Use the `ask_user_question` tool with the following question: "[N] CLAUDE.md targets across [M] layers. Proceed with analysis?". Options: "Proceed (Recommended)" (Analyze all proposed folders and write CLAUDE.md files); "Add folders" (I want to add more folders to the target list); "Remove folders" (Some proposed folders should be skipped).
   - Adjust the target list based on user feedback

4. **Pass 2 — Analyze each layer (parallel analyzer agents):**
   - For each confirmed target folder, spawn agents in parallel:

   **For each target folder, spawn TWO agents:**

   **Analyzer agent:**
   - agent: `codebase-analyzer`
   - Prompt: "Analyze [folder path] in detail. Determine: 1) What is this layer's responsibility? 2) What are its dependencies (what does it import/use)? 3) Who consumes it (what imports/uses it)? 4) What are the key architectural boundaries and constraints? 5) What is the module structure — list DIRECTORIES with their roles, base types, and naming conventions. Use architectural annotations (e.g., 'one repo per entity', 'one controller per resource') instead of listing individual filenames. The structure should remain valid when non-architectural files are added. 6) What naming conventions are used (prefixes, suffixes, base classes)?"

   **Pattern finder agent:**
   - agent: `codebase-pattern-finder`
   - Prompt: "Find all distinct code patterns used in [folder path]. For each pattern found: 1) Name the pattern with a descriptive heading (e.g., 'Repository Boundary (CRITICAL: Plain Types, NOT Result<T>)'). 2) Provide an IDIOMATIC code example — a generalized, representative version that shows the pattern's essential shape (constructor, key method signatures, return types, error handling). Do NOT copy-paste a single file verbatim; instead synthesize the typical usage across the layer. 3) Add inline comments highlighting important conventions (e.g., '// DB int → boolean', '// throws on error — service wraps in Result'). 4) If the pattern involves a boundary between layers, show both sides. 5) Identify any repeatable workflows for adding new elements to this layer — backend entities (repositories, services, controllers) AND frontend elements (components, services, pages/routes, directives). For example: creating a new repository requires extending BaseRepository + registering in factory; adding a new Angular component requires extending BaseComponent + adding to routes + creating the template. Return these as step-by-step checklists. Return patterns with full code block examples."

   - Spawn 1 analyzer + 1 pattern finder per folder, all in parallel
   - For the root CLAUDE.md, use findings from ALL folders to create the overview

5. **Wait for Pass 2 and synthesize:**
   - IMPORTANT: Wait for ALL agents from Pass 2 to complete before proceeding
   - Compile all agent findings per folder
   - **Do NOT draft CLAUDE.md content yet** — proceed to developer checkpoint first (Step 6)

6. **Developer checkpoint — validate findings before drafting:**

   Present a per-folder findings summary, then ask grounded questions. This pulls domain knowledge that agents can't discover from code alone — deprecated patterns, undocumented conventions, migration-in-progress situations, or cross-layer rules that only the developer knows.

   **Findings summary** — one block per target folder, 2-3 lines each:
   ```
   ## Findings Summary

   ### src/core/
   Patterns: Repository base class, Entity base with soft-delete, Value Objects
   Dependencies: Database layer (outbound), Services layer (inbound)
   Workflows detected: "Add new entity" (5 steps), "Add new value object" (2 steps)

   ### src/services/
   Patterns: Result<T> wrapping, Transaction scope per operation
   Dependencies: Core (outbound), Controllers (inbound)
   Workflows detected: "Add new service" (4 steps)

   [etc.]
   ```

   Then ask grounded questions — **one at a time**, waiting for the developer's answer before asking the next. Ask as many as the findings warrant — one per significant ambiguity or discovery gap. Use a **❓ Question:** prefix. Each question must reference real findings and pull NEW information from the developer — not confirm what you already found, and not ask about cosmetic issues (typos, formatting) or absences the developer can't add context to.

   Only ask questions whose answer would change what gets written in a CLAUDE.md file. Focus on:
   - Competing patterns that need a canonical vs. legacy designation (which style should new code follow?)
   - Cross-layer dependencies that look like violations but might be design decisions
   - Undocumented architectural constraints not visible in code (ordering, idempotency, invariants)

   Example grounded questions:
   - "Found two different mapping approaches in `src/services/`: manual mapping in `OrderService` and AutoMapper in `UserService`. Which is the current convention, or is there a migration in progress I should document?"
   - "The analyzer found no event/message patterns in `src/core/`. Is domain event publishing handled elsewhere, or is it not used in this project?"
   - "Detected 3 different error-handling styles across layers. Is there a canonical approach, or are these intentional per-layer differences?"

   **CRITICAL**: Ask ONE question at a time. Wait for the answer before asking the next. Lead with your most significant finding. The developer will redirect you if needed.

   **Choosing question format:**

   - **`ask_user_question` tool** — when your question has 2-4 concrete options from code analysis (pattern conflicts, integration choices, scope boundaries, priority overrides). The user can always pick "Other" for free-text. Example: Use the `ask_user_question` tool with the question "Found 2 mapping approaches — which should new code follow?". Options: "Manual mapping (Recommended)" (Used in OrderService (src/services/OrderService.ts:45) — 8 occurrences); "AutoMapper" (Used in UserService (src/services/UserService.ts:12) — 2 occurrences).

   - **Free-text with ❓ Question: prefix** — when the question is open-ended and options can't be predicted (discovery, "what am I missing?", corrections). Example:
     "❓ Question: Integration scanner found no background job registration for this area. Is that expected, or is there async processing I'm not seeing?"

   **Batching**: When you have 2-4 independent questions (answers don't depend on each other), you MAY batch them in a single `ask_user_question` call. Keep dependent questions sequential.

   **Incorporate developer input:**

   **Corrections** ("that pattern is deprecated", "wrong — we use X"):
   - Update synthesis. If the correction reveals a pattern that needs fresh analysis, re-prompt a targeted **codebase-analyzer** or **codebase-pattern-finder** (max 2 agents).

   **Missing conventions** ("you missed the soft-delete convention", "all handlers must be idempotent"):
   - Add directly to synthesis for the relevant folder.

   **Migration context** ("we're moving from X to Y", "old pattern in these files, new pattern in those"):
   - Record both old and new approaches in synthesis — CLAUDE.md should document the canonical (new) way with a note about the legacy approach still present in specific areas.

   **Scope adjustments** ("skip that layer, it's being rewritten", "add src/shared/"):
   - Update target list. For new targets, run a targeted Pass 2 (analyzer + pattern-finder, max 2 agents), then fold results into synthesis.

   **Confirmations** ("looks right", "yes that's correct"):
   - Proceed to drafting.

   After incorporating all input, proceed to Step 7.

7. **Draft CLAUDE.md content:**
   - Draft CLAUDE.md content in this order — **subfolder files first, root last**:
     - Subfolder: Use the **Subfolder CLAUDE.md Template** (detailed, max 100 lines)
     - Root folder (LAST): Use the **Root CLAUDE.md Template** (compact overview). Draft root only after all subfolder files are finalized — this ensures the deduplication rule can be applied and cross-layer checklists can accurately reference subfolder content
   - Enforce the 100-line limit on subfolder files — code examples are essential but keep them concise
   - If the pattern-finder identified repeatable "add new entity" workflows, include them as `<important if="you are adding a new [entity] to this layer">` conditional sections
   - If testing patterns were detected, include them as `<important if="you are writing or modifying tests for this layer">` conditional sections
   - Conditional sections are optional — only include when the pattern-finder found clear evidence of a repeatable workflow
   - Conditions must be narrow and action-specific (NOT "you are writing code" — too broad)
   - Do NOT include conventions enforceable by linters, formatters, or pre-commit hooks (e.g., naming conventions, import ordering, indentation) — these add noise without value
   - Do NOT include patterns easily discoverable from existing code — LLMs are in-context learners and will follow patterns after a few file reads. Only document conventions that are surprising, non-obvious, or span multiple layers
   - If a pattern section would contain only prose or comments with no code example, either expand it with a real idiomatic example or omit it and reference the source file (e.g., "see `BaseModalComponent` for the modal pattern")
   - Before writing, verify: no root conditional block duplicates content from a subfolder CLAUDE.md. If a layer has its own subfolder file, remove its summary from root
   - For cross-layer vertical-slice checklists in root, each step should reference the relevant subfolder CLAUDE.md ("see Data layer CLAUDE.md") rather than inlining the full procedure
   - If an existing root CLAUDE.md was found:
     - Review its content
     - Redistribute any detailed layer-specific content to the appropriate subfolder CLAUDE.md files
     - Rewrite the root as a compact overview

8. **Self-review pass — verify every drafted file before writing:**
   Walk through each drafted CLAUDE.md and check every item below. Fix violations in-place before proceeding to writing.

   **Dependencies** — for each listed dependency, ask: "does this library impose patterns, constraints, or conventions on the code?" If the answer is no (utility libraries like lodash, moment, xlsx, FontAwesome), remove it. Only frameworks and libraries that shape how you write code survive.

   **Module Structure** — count top-level entries. If more than 7, group related directories on one line (e.g., `guards/, interceptors/, pipes/ — cross-cutting plumbing`). Target 4-7 entries.

   **Pattern sections** — every pattern H2 must contain a fenced code block with an idiomatic example. If a section is prose-only or comment-only, either expand it with a real code example or replace the section with a one-line file reference (e.g., "see `TradeDeskMapping.cs` for the mapping pattern").

   **Root deduplication** — for each root conditional block, verify it is NOT summarizing a layer that has its own subfolder CLAUDE.md. If it is, remove the block. For cross-layer vertical-slice checklists, verify each step references the relevant subfolder file ("see X CLAUDE.md") rather than inlining the procedure.

   **Frontend/UI conditional coverage** — for each frontend/UI layer, list every repeatable workflow the pattern-finder reported (components, services, pages/routes, directives, pipes, hooks, stores — whatever was detected). Then compare that list against the drafted `<important if>` conditional sections. Any workflow on the list without a matching conditional is a gap — draft and add the missing section before proceeding.

   After fixing all violations, re-scan the corrected drafts to confirm every check passes. Only proceed to writing when all checks are clean. Present a brief summary of what was fixed:
   ```
   ## Self-review results
   - [file]: removed 2 utility deps (moment, xlsx-js-style)
   - [file]: grouped Module Structure from 11 → 6 entries
   - [file]: added "Adding a New Service" conditional
   - Root: no violations found
   ```

9. **Pass 3 — Write all CLAUDE.md files:**
   - Write ALL files at once using the Write tool
   - Do NOT ask for confirmation before each file — batch mode
   - After writing, present a summary:
     ```
     ## CLAUDE.md Files Created

     | File | Lines | Description |
     |------|-------|-------------|
     | CLAUDE.md | 45 | Root project overview |
     | src/core/CLAUDE.md | 78 | Core domain layer |
     | src/services/CLAUDE.md | 65 | Service layer |
     | [etc.] | | |

     Total: [N] files created/updated

     Please review the files and let me know if you'd like any adjustments.
     ```

10. **Handle follow-up adjustments:**
   - If the user requests changes to specific files, edit them directly using the Edit tool
   - If the user wants additional folders annotated, run a targeted Pass 2 (analyzer + pattern finder) for those folders, then write
   - If the user wants a file removed, note that they can delete it themselves

## Root CLAUDE.md Template (compact):

Read the full template at `templates/root-claude-md.md`.

Key principles:
- Bare sections (Overview, Architecture, Commands, Business Context) are foundational — always included
- Cross-cutting patterns go in `<important if>` blocks with narrow conditions
- Deduplication rule: if a layer has a subfolder CLAUDE.md, don't summarize it in root
- Root MAY include cross-layer vertical-slice checklists referencing subfolder files

### Root CLAUDE.md Reference Examples

See `examples/root-nodejs-monorepo.md` (Node.js monorepo) and `examples/root-dotnet-clean-arch.md` (.NET Clean Architecture) for well-formed root CLAUDE.md examples.

What makes these examples good:
- **Bare sections** (Overview, Project map, Commands) are relevant to nearly every task — no wrapper needed
- **Each `<important if>` has a narrow trigger** — "adding a new API endpoint" not "writing backend code"
- **No linter territory** — formatting rules left to tooling
- **No code snippets** — uses file path references since patterns are better shown in subfolder CLAUDE.md files
- **Same structure, different ecosystems** — the pattern works identically for Node.js and .NET

## Subfolder CLAUDE.md Template (max 100 lines):

Read the full template at `templates/subfolder-claude-md.md`.

Key principles:
- Each distinct pattern gets its own H2 section with a fenced code block
- Module Structure: aim for 4-7 top-level entries, use architectural annotations
- Conditional sections (`<important if>`) are optional — only for detected repeatable workflows
- Conditional sections do NOT count toward the 100-line budget

### Reference Examples

See the following for well-formed subfolder CLAUDE.md examples:
- `examples/subfolder-database-layer.md` — Database layer (~80 lines)
- `examples/subfolder-schemas-layer.md` — Schemas layer (~70 lines)
- `examples/subfolder-dotnet-application.md` — .NET Application layer (~65 lines)

### What makes these examples good:
- **Module Structure**: Compact, uses architectural annotations, groups related files on one line
- **Patterns as H2 sections**: Each pattern has a descriptive name, NOT a generic umbrella
- **Code examples are idiomatic**: Generalized to show the pattern's shape
- **Cross-boundary patterns**: Shows both sides of layer boundaries
- **Concise**: All fit well within 100 lines
- **Conditional blocks**: Wrap scenario-specific recipes with narrow conditions

## CLAUDE.md Depth Rules:

**CREATE CLAUDE.md when:**
- Folder represents a distinct **architectural layer** (core, services, database, redis, ipc)
- Folder contains **unique organizational logic** not captured by parent
- Subfolder has **different patterns/constraints** than parent (e.g., `database/repositories/` vs `database/`)
- Folder has **its own responsibility** (e.g., `database/migrations/`)
- Folder is a **composite application root** (e.g., SPA, monorepo package) whose children represent distinct sub-layers with different patterns — apply Depth Rules recursively to its children

**SKIP CLAUDE.md when:**
- Folder only groups entities/DTOs by domain boundary following the same pattern
- Folder content is fully described by parent CLAUDE.md
- Folder is a simple grouping without unique constraints

## Important notes:
- Always use parallel subagent tool calls to maximize efficiency and minimize context usage
- **File reading**: Always read mentioned files FULLY (no limit/offset) before invoking skills
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read mentioned files first before invoking skills (step 1)
  - ALWAYS wait for all skills in a pass to complete before proceeding to the next step
  - NEVER write CLAUDE.md files with placeholder values — all content must come from skill findings
  - NEVER proceed to Pass 2 without user confirmation of target locations
  - NEVER skip the developer checkpoint (step 6) — developer input is the highest-value signal for CLAUDE.md quality
  - NEVER draft CLAUDE.md content before completing the developer checkpoint
- **.gitignore compliance**: Skip directories excluded by .gitignore (node_modules, dist, build, .git, vendor, etc.)
- **Batch output mode**: Write all CLAUDE.md files at once in Pass 3, do not ask for per-file confirmation
- **Existing CLAUDE.md handling**: If a CLAUDE.md already exists at any target location, replace it entirely using the Write tool
- **Line budget**: Subfolder CLAUDE.md files must not exceed 100 lines — code examples in Key Patterns are mandatory, keep them idiomatic and concise
- **No frontmatter**: CLAUDE.md files are pure markdown, no YAML frontmatter
- Keep the main agent focused on synthesis, not deep file reading — delegate analysis to sub-agents
