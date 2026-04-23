---
name: outline-test-cases
description: Discover testable features via Frontend-First Discovery and create a folder outline under .rpiv/test-cases/ with per-feature metadata. Incremental runs use existing outlines as context for smarter discovery and diff-based checkpoints. Use before write-test-cases to map project scope.
argument-hint: [target-directory]
allowed-tools: subagent, Read, Write, Edit, Glob, Grep
---

# Outline Test Cases

You are tasked with discovering all testable features in a project and creating a folder outline under `.rpiv/test-cases/`. Each feature gets its own folder with a `_meta.md` file containing discovered routes, endpoints, scope decisions, and domain context. A root `README.md` summarizes the full project outline. No test case content is generated — use `write-test-cases` per feature to fill the folders.

Two modes: **Fresh** (no existing outline — full discovery and checkpoint) and **Incremental** (existing outline found — discovery with prior context, diff-based checkpoint). Discovery always runs in both modes.

## Initial Setup

When this command is invoked, respond with:
```
I'll discover all testable features in this project and create a folder outline
under .rpiv/test-cases/. Let me check for existing outlines and analyze the codebase.
```

Use the current working directory as the target project by default. If the user provides a specific directory path as an argument, use that instead.

## Steps

### Step 1: Read files & detect mode

- If the user mentions specific files (existing test cases, architecture docs, READMEs), read them FULLY first
- **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
- **CRITICAL**: Read these files yourself in the main context before invoking any agents

#### Mode Detection

Check for existing outline data:

1. **Glob** for `**/_meta.md` with path set to `.rpiv/test-cases/` in the target directory (dot-prefixed directories must be targeted directly)
2. If no `_meta.md` files found → **Fresh mode**. Proceed to Step 2.
3. If `_meta.md` files found → **Incremental mode**. Read them ALL and extract:
   - Existing feature list (names, slugs, modules, routes, endpoints)
   - Scope exclusions from `## Scope Decisions` sections
   - Previous checkpoint Q&A from `## Checkpoint History` sections
   - Generated date from frontmatter

Report detected mode:
```
[Fresh]: No existing outline found. Will run full discovery.
[Incremental]: Found [N] existing feature outlines from [generated date]. Will re-discover with prior context and highlight changes.
```

### Step 2: Discover features

First, detect the project's technology stack by checking for framework indicators (see Framework Detection Reference below).

Spawn parallel discovery agents using the subagent tool:
- Use the **codebase-locator** agent to find all registered routes, navigation menus, and page entry points
- Use the **codebase-locator** agent to find all frontend HTTP API call sites — report each call-site `file:line` and the literal URL template string found at the call site (e.g., ``${base}/users/${id}``). Frontend-to-backend URL correlation happens orchestrator-side in Step 3's Cross-Reference synthesis (`skills/outline-test-cases/SKILL.md:71-79`) using the backend-controller findings from the next agent.
- Use the **codebase-locator** agent to find all backend API controllers and route handlers
- Use the **test-case-locator** agent to find existing test cases in `.rpiv/test-cases/` to avoid duplicates

Include in your prompts for the three codebase-locator agents:
- Target directory and detected framework
- In **Incremental mode**: summary of previously discovered features (names, routes, endpoints) from existing `_meta.md` files — ask agents to flag new items and note any that no longer exist
- If **scope exclusions** were loaded in Step 1: list them and instruct agents to exclude matching results

While agents run, read `.gitignore` yourself to understand exclusion rules.

### Step 3: Determine feature targets

**IMPORTANT**: Wait for ALL agents from Step 2 to complete before proceeding.

#### Cross-Reference (both modes)

Cross-reference findings from all 4 agents:

**Feature identification** — Build the feature list from frontend evidence:
1. Start with frontend routes (Route Discovery) — each top-level route group is a candidate feature
2. Validate with navigation menus — features in the sidebar/nav are confirmed active
3. Enrich with API call mapping (API Mapping) — link each feature's frontend services to backend endpoints
4. Cross-reference against backend controllers (Backend Discovery) — identify which backend controllers serve each frontend feature

**Phantom detection** — Flag backend controllers NOT referenced by any frontend route or API call:
- Platform/public API controllers serving external consumers
- Webhook controllers triggered by external services
- Deprecated endpoints with code still present
- Sub-services used within other features
- Present these as "Backend-only endpoints (no frontend exposure)" in the confirmation

#### Incremental: Diff Against Existing Outline

In Incremental mode, compare the fresh discovery results against existing `_meta.md` data and classify each feature:

| Category | Condition |
|---|---|
| **Unchanged** | Feature exists in both existing outline and fresh discovery, routes/endpoints match |
| **New** | Found by agents but not in any existing `_meta.md` |
| **Removed** | In existing `_meta.md` but not found by agents |
| **Changed** | Feature exists in both but routes or endpoints differ |

#### Common Processing (both modes)

**Feature grouping** — Group confirmed features by portal/application:
- Detected from route structure (e.g., Admin, Public, Partner, Host)

**Decomposition rules:**
- Large features (>10 endpoints or >3 sub-routes) — note sub-features in metadata, keep as single folder
- Small features (<5 endpoints, no dedicated route) — fold into parent feature
- Sub-services without own routes — fold into the feature that uses them

**Slug and module assignment:**
- Feature slug: kebab-case from feature name (e.g., `user-management` → `users`, `report-builder`)
- Module abbreviation: short uppercase code derived from feature name (e.g., USR, AUTH, DASH, RPT)

**Duplicate check** — Cross-reference against existing TCs (TC Locator):
- Features with existing TC folders → mark status as "partial" (has outline, TCs may exist)
- Features with no TCs → mark status as "pending"

### Step 4: Developer checkpoint

#### Fresh Mode — Full Checkpoint

Ask grounded questions one at a time before presenting the feature list. Use a **❓ Question:** prefix so the user knows their input is needed. Each question must reference real findings and pull NEW information — not confirm what you already found. Ask several questions targeting what the code analysis could not detect.

**Question focus areas** (business/product language first, technical fallback only when necessary):

- **Phantom features**: "There's a bulk-import capability in the code but no screen for it in the admin panel — is this tested separately or internal-only?"
- **Missing coverage**: "The navigation menu shows a Reports section but I can't find an actual page behind it — is this under development or was it removed?"
- **Hidden features**: "I see three separate user management areas but only one is visible in the menu — are the others internal tools or deprecated?"
- **Feature boundaries**: "User management and role assignment share the same backend — should they be one test area or two?"
- **Environment-specific**: "Some features seem to be behind feature flags and only active in staging — should these be included in the test outline?"

**CRITICAL**: Ask ONE question at a time. Wait for the answer before asking the next. Lead with your most significant finding.

**Choosing question format:**

- **`ask_user_question` tool** — when your question has 2-4 concrete options from code analysis (pattern conflicts, integration choices, scope boundaries, priority overrides). The user can always pick "Other" for free-text. Example: Use the `ask_user_question` tool with the question "Found 2 mapping approaches — which should new code follow?". Options: "Manual mapping (Recommended)" (Used in OrderService (src/services/OrderService.ts:45) — 8 occurrences); "AutoMapper" (Used in UserService (src/services/UserService.ts:12) — 2 occurrences).

- **Free-text with ❓ Question: prefix** — when the question is open-ended and options can't be predicted (discovery, "what am I missing?", corrections). Example:
  "❓ Question: Integration scanner found no background job registration for this area. Is that expected, or is there async processing I'm not seeing?"

**Batching**: When you have 2-4 independent questions (answers don't depend on each other), you MAY batch them in a single `ask_user_question` call. Keep dependent questions sequential.

**Classify each response and track for persistence:**

**Confirmations** ("looks good", "yes proceed"):
- Record. Proceed to the next question, or to the feature list if all questions answered.

**Corrections** ("that's deprecated", "wrong grouping"):
- Update the feature list directly. Record as scope decision for the affected feature.

**Additions** ("you missed the refund flow", "add platform API"):
- Add to the feature list. Assign slug/module. Record as scope decision.

**Scope adjustments** ("skip admin features", "split settings into two"):
- Adjust the target list. Record as scope decision for affected features.

After all questions are answered, present the proposed feature list:

```
## Proposed Feature Outline

Framework detected: [framework name]
Applications found: [N] ([app names])
Total backend endpoints: ~[N] across [M] controllers

---
### [Portal Name] ([N] features)

1. [Feature Name] — [N] routes, [M] API endpoints
   Slug: [feature-slug] | Module: [MOD]
   Sub-features: [list if decomposed, or "none"]
2. [Feature Name] — [N] routes, [M] API endpoints
   Slug: [feature-slug] | Module: [MOD]
[etc.]

### Already Covered (will skip):
- [Feature] — [N] existing TCs in .rpiv/test-cases/[slug]/

### Backend-Only Endpoints (no frontend exposure):
- [Controller/endpoint group] — [reason: platform API / webhook / deprecated]

---
Create outline for [total] features?
```

Use the `ask_user_question` tool with the following question: "Create outline for [total] features across [N] portals?". Options: "Create outline (Recommended)" (Write _meta.md files and folder structure for all features above); "Add or remove features" (Adjust the feature list before creating); "Reclassify" (Move backend-only endpoints into the main feature list or vice versa).

Handle any final additions, removals, reclassifications, or slug/module overrides.

#### Incremental Mode — Diff-Based Checkpoint

Present the diff results from Step 3 with previous decisions:

```
## Outline Update ([N] features, last run [generated date])

Unchanged ([N]):
- [Feature Name] — [slug] | [MOD]
[etc.]

New ([N]):
- [Feature Name] — [N] routes, [M] API endpoints (not in previous outline)
[etc.]

Removed ([N]):
- [Feature Name] — was [slug] | [MOD] (no longer found in codebase)
[etc.]

Changed ([N]):
- [Feature Name] — [what changed: "3 new endpoints", "route path changed", etc.]
[etc.]

Previous decisions:
- [Q&A pair 1 rephrased as single-line decision statement]
- [Q&A pair 2 rephrased as single-line decision statement]

```

Use the `ask_user_question` tool with the following question: "[N] unchanged, [M] new, [K] removed features. Apply updates?". Options: "Apply updates (Recommended)" (Update _meta.md files and create new feature folders); "Adjust changes" (Modify the proposed new/removed/changed features); "Re-run discovery" (Something looks wrong — re-scan the codebase).

Rephrase each Q&A pair into a concise decision statement (e.g., `**Q:** "Is the bulk-import capability tested separately?" **A:** "No, internal only"` becomes `"Bulk-import — internal only, excluded from scope"`).

**If no changes detected** (all features unchanged):
- Present the unchanged list and previous decisions
- Use the `ask_user_question` tool with the following question: "No changes detected since [date]. Still accurate?". Options: "Confirmed" (Outline is still accurate — no updates needed); "Force re-scan" (Re-run discovery anyway to verify).

**For new/changed/removed features**, ask grounded questions ONE at a time (same approach as Fresh mode) targeting only the differences. Unchanged features need only batch confirmation.

**Classify each response and track for persistence** (same as Fresh mode: Confirmations, Corrections, Additions, Scope adjustments).

After all questions are answered, present the full feature list summary (same format as Fresh mode) and wait for user confirmation before proceeding to Step 5.

### Step 5: Write folder outline

#### Fresh Mode — creating new files

1. **Create directories** — for each confirmed feature, create `.rpiv/test-cases/{feature-slug}/`

2. **Write `_meta.md` per feature** — one file per folder:

   Read the full feature metadata template at `templates/feature-meta.md`. Follow the template exactly, populating fields from agent findings and checkpoint answers:
   - `## Routes` — route paths and component names from Route Discovery (no file:line references)
   - `## Endpoints` — HTTP methods and paths from Backend Discovery
   - `## Scope Decisions` — from checkpoint answers classified as Corrections, Additions, or Scope adjustments that affect this feature. Include cross-cutting decisions that apply. If no scope decisions surfaced, write a default entry: `- Full feature in scope (no exclusions identified)`
   - `## Domain Context` — from checkpoint answers that reveal business rules or intentional behaviors. Leave section with `- None identified` if nothing surfaced.
   - `## Test Data Requirements` — from checkpoint answers that mention data needs. Leave section with `- None identified` if nothing surfaced.
   - `## Checkpoint History` — all Q&A pairs from the checkpoint that affect this feature, under a date header (`### YYYY-MM-DD`)

3. **Write root `README.md`** at `.rpiv/test-cases/README.md`:

   Read the full outline README template at `templates/outline-readme.md`. Follow the template exactly, populating fields from the confirmed feature list.

4. **Present summary:**
   ```
   ## Test Case Outline Created

   | Folder | Module | Portal | Routes | Endpoints | Status |
   |--------|--------|--------|--------|-----------|--------|
   | users/ | USR | Admin | 5 | 20 | pending |
   | reports/ | RPT | Admin | 2 | 15 | pending |
   | [etc.] | | | | | |

   Output: `.rpiv/test-cases/`
   Total: [N] feature folders + [N] _meta.md files + 1 README.md
   Phantom features skipped: [list or "none"]

   Note: this outline is a starting point based on code analysis — re-run or add features manually as the project evolves.

   Generate test cases for a feature:
   `/skill:write-test-cases [feature-name]`
   ```

#### Incremental Mode — updating existing files

1. **Update existing `_meta.md` files** using the Edit tool:
   - Update `## Routes` and `## Endpoints` with fresh discovery data
   - Append new Q&A pairs to `## Checkpoint History` under a new date header (`### YYYY-MM-DD`)
   - Update `## Scope Decisions` if changed during checkpoint
   - Update `## Domain Context` if changed
   - Update frontmatter `generated` date to current date

2. **Add new feature folders** for newly discovered features:
   - Create directory + write new `_meta.md` from template (same as Fresh mode Step 5.2)

3. **Flag removed features** — do NOT delete folders (they may contain generated TCs):
   - Update `_meta.md` frontmatter `status` to `removed`
   - Append removal note to `## Checkpoint History`
   - Inform the user which folders were flagged so they can decide whether to delete

4. **Update root `README.md`** — update feature table and `Generated:` line using Edit

5. **Present summary:**
   ```
   ## Test Case Outline Updated

   Unchanged: [N] features
   Updated: [N] _meta.md files (routes/endpoints refreshed)
   Added: [N] new feature folders
   Removed: [N] features flagged (folders preserved)

   Changes:
   - [List of what changed: "Added payments feature", "Flagged legacy-reports as removed", "Updated scope for users", etc.]

   Output: `.rpiv/test-cases/`

   Note: this outline is a starting point based on code analysis — re-run or add features manually as the project evolves.

   Generate test cases for a feature:
   `/skill:write-test-cases [feature-name]`
   ```

### Step 6: Handle follow-ups

- **Add features**: Add folder + `_meta.md`, update `README.md`
- **Remove features**: Note that user can delete the folder; update `README.md` using Edit
- **Reclassify phantoms**: Create folder + `_meta.md` for the reclassified feature, update `README.md`
- **Re-run**: If codebase changed significantly, re-run — the skill will detect existing outlines and run incremental discovery
- **Adjust metadata**: Edit specific `_meta.md` files using the Edit tool
- On follow-up updates: update `_meta.md` frontmatter `generated` field and `README.md` `Generated:` line to reflect the current date

## Framework Detection Reference

| Indicator | Framework | Detection |
|-----------|-----------|-----------|
| `@angular/core` | Angular | `package.json` dependencies |
| `react-router-dom` / `react-router` / `@react-router` | React | `package.json` dependencies |
| `next` | Next.js | `package.json` dependencies |
| `vue-router` | Vue Router | `package.json` dependencies |
| `nuxt` | Nuxt | `package.json` dependencies |
| `.csproj` / `.sln` | .NET | File presence in project root |
| `pyproject.toml` / `requirements.txt` with Django/Flask/FastAPI | Python | File presence + dependency check |
| None found | Backend-only | Fallback to backend discovery |

## Important Notes

- This skill creates folders and `_meta.md` only — use `write-test-cases` per feature for actual TC content.
- Frontend routes define features; backend enriches them. No UI route → no folder (unless developer overrides).
- Never skip the developer checkpoint, even on incremental runs.
- `_meta.md` is the inter-skill contract — keep route/endpoint paths stable, no `file:line` references.
- **File reading**: Always read mentioned files FULLY (no limit/offset) before invoking agents.
- **Critical ordering**: Follow the numbered steps exactly.
  - ALWAYS detect mode first (Step 1) before spawning agents
  - ALWAYS read mentioned files first before invoking agents (Step 1)
  - ALWAYS wait for all agents to complete before determining targets (Step 3)
  - ALWAYS checkpoint with the user before presenting the feature list (Step 4)
  - ALWAYS get user confirmation before writing folders (Step 4 → Step 5)
  - NEVER write folders or metadata with placeholder values
- **Duplicate avoidance**: Always check existing TCs via test-case-locator before creating folders.
- **Idempotent re-runs**: If `.rpiv/test-cases/` already has folders with TCs, mark them accordingly — do not overwrite existing TC content. Only update `_meta.md` and `README.md`.
