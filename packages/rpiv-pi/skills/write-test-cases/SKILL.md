---
name: write-test-cases
description: Generate manual test case specifications for a single feature by analyzing code in parallel. Consumes outline-test-cases _meta.md when available for warm-start. Produces flow-based test cases with regression suite and project-wide coverage map. Outputs to .rpiv/test-cases/{feature}/ in the target project.
argument-hint: "[feature name, component path, feature slug, or _meta.md path] [additional instructions]"
---

# Write Test Cases

You are tasked with generating manual test case specifications for a single feature by analyzing code in parallel and producing flow-based test case documents for QA teams.

## Initial Setup

When this command is invoked, respond with:
```
I'll generate test cases for this feature. Let me discover the relevant code and analyze it.
```

Then proceed to Step 1.

## Steps

### Step 1: Determine Feature Scope

Parse the user's input to determine the feature under test. Handle these input forms:

1. **_meta.md path** (e.g., `.rpiv/test-cases/users/_meta.md`):
   - Read the file. Extract `feature` from frontmatter. Mark as **has _meta.md**.

2. **Feature folder or slug** (e.g., `.rpiv/test-cases/order-management/` or `order-management`):
   - Check if `.rpiv/test-cases/{input}/_meta.md` exists
   - If yes: read it, extract `feature`, mark as **has _meta.md**
   - If no: treat as feature name

3. **Source code path** (e.g., `src/orders/` or `src/api/controllers/OrdersController.ts`):
   - Use the path directly as the starting point for analysis

4. **Feature name with optional instructions** (e.g., `Order Management focus on refund edge cases`):
   - Parse as `{feature identifier} [additional instructions]`
   - Check if `.rpiv/test-cases/{slugified-name}/_meta.md` exists — if yes, read it and mark as **has _meta.md**
   - Store additional instructions as supplemental context for agent prompts and checkpoint

5. **No arguments provided**:
   ```
   I'll help you generate test cases. Please provide either:
   1. A feature name: `/skill:write-test-cases Order Management`
   2. A component path: `/skill:write-test-cases src/orders/`
   3. A feature slug: `/skill:write-test-cases order-management`
   4. A _meta.md path: `/skill:write-test-cases .rpiv/test-cases/orders/_meta.md`

   Add instructions after the feature: `/skill:write-test-cases Order Management focus on refund edge cases`
   ```
   Then wait for input.

#### Warm-Start from _meta.md

When `_meta.md` is available, read it FULLY and extract:
- **Identity**: `feature`, `module`, `portal`, `slug` from frontmatter
- **Routes**: from `## Routes` section — route paths and component names
- **Endpoints**: from `## Endpoints` section — HTTP methods and paths
- **Scope decisions**: from `## Scope Decisions` section — in/out of scope items
- **Domain context**: from `## Domain Context` section — business rules and intentional behaviors
- **Checkpoint history**: from `## Checkpoint History` section — prior Q&A pairs

Report:
```
[Warm-start]: Found _meta.md for "{feature}" ({module}, {portal}). {N} routes, {M} endpoints.
```

When no _meta.md, detect the project's technology stack before spawning agents: check `package.json` for framework indicators (see Framework Detection Reference at end of document). If no `package.json`, check for `.csproj`/`.sln` (.NET), `pyproject.toml`/`requirements.txt` (Python). Use the detected framework to adapt Agent A's prompt in Step 2.

### Step 2: Discover Feature Code (parallel agents)

Spawn the following agents in parallel using the Agent tool. Wait for ALL agents to complete before proceeding.

**Agent A — Web Layer Discovery:**
- subagent_type: `codebase-locator`
- When _meta.md is available: "Validate these known Web Layer entry points for {feature name}: {routes and endpoints from _meta.md}. Check if they still exist and find any NEW entry points not in this list. Report: confirmed (still exists), removed (no longer found), new (not in the list)."
- When no _meta.md: "Find all Web Layer entry points for the {feature name} feature{framework_hint}. Look for: controllers, route definitions, page components, form handlers, API endpoints. Search across all web layers (API, Admin, Customer Portal, Host, etc.). Also find frontend service files, HTTP clients, or API call sites that reference these endpoints — report which frontend pages call which backend URLs. For each entry point found, report: file path, HTTP method/route or page path, and a one-line description of what it does. Group by web layer."

{framework_hint} is " in this {Framework} project" when a framework is detected (e.g., " in this Angular project"), or empty string if none detected. See Framework Detection Reference at end of document.

**Agent B — Existing Test Cases:**
- subagent_type: `test-case-locator`
- Prompt: "Search for existing test cases related to {feature name} in .rpiv/test-cases/. Report any existing TCs with their IDs, titles, and priorities so we can avoid duplicates."

Wait for both agents to complete before proceeding.

### Step 3: Analyze Feature Code (parallel agents)

Using the entry points discovered in Step 2 (validated against _meta.md when available), spawn analysis agents in parallel. When _meta.md is available, enrich prompts: append scope exclusions from `## Scope Decisions` as {scope_context}, domain rules from `## Domain Context` as {domain_context}, and endpoint list as {endpoint_scope}. When no _meta.md, omit these.

**Agent C — Code Analysis:**
- subagent_type: `codebase-analyzer`
- Prompt: "Analyze the {feature name} feature implementation in detail. Read the controllers/route handlers at {discovered paths}. For each endpoint/action, determine: 1) What user input is accepted (request body, query params, form fields)? 2) What validation rules exist — report specific limits (max lengths, regex patterns, required vs optional)? 3) What business logic is executed? 4) What are the success/error responses? 5) What authorization/permissions are required? Focus on understanding USER FLOWS — sequences of actions a user would perform to accomplish a goal. ALSO read the frontend page components and templates at {discovered frontend paths}. Extract what a QA tester would actually see: exact button labels, form field labels/placeholders, navigation items, table column headers, success/error messages, and conditional UI (role- or state-dependent elements). Resolve any i18n translation keys to displayed text. Report UI elements per page/route alongside the backend analysis.{scope_context}{domain_context}"

**Agent D — Postcondition Discovery:**
- subagent_type: `integration-scanner`
- Prompt: "Find all side effects triggered by {feature name} actions{endpoint_scope}. Look for: domain events published, message handlers invoked, email/notification triggers, external API calls, database cascades, cache invalidations, audit log entries, webhook dispatches. For each side effect, report: what triggers it (which action/endpoint) and where the handler code lives (file:line). Do NOT describe what the handler does — only locate it. These locations become postconditions in test cases.{scope_context}"

Wait for ALL agents to complete before proceeding.

### Step 4: Synthesize Findings

Compile all agent results into a feature analysis:

1. **Map user flows** — Group the discovered endpoints/pages into logical user journeys:
   - Identify the natural sequence of actions (e.g., browse -> select -> configure -> checkout -> confirm)
   - Each flow should represent a complete user goal, not isolated actions
   - A feature typically produces 3-8 flows depending on complexity
   - **When to separate**: If view and edit serve different user goals, keep them as separate flows. If a sub-operation (e.g., replace, export, bulk action) has its own trigger and confirmation, it deserves its own flow. If different user roles interact with the same entity differently, split by role.
   - **Use real UI element names** from Agent C's frontend analysis — actual button labels, form field names, navigation text, displayed messages. Do not infer UI element names from backend action semantics.

2. **Enrich with postconditions** — For each flow, attach the side effects discovered by the integration-scanner:
   - Map domain events to specific flow steps
   - Include cross-system effects (emails, webhooks, inventory changes)

3. **Check for duplicates** — Cross-reference synthesized flows against existing TCs from test-case-locator:
   - If an existing TC covers a flow, note it and skip that flow
   - If partial overlap, note the gap to fill

4. **Assign priorities**:
   - **high**: Core happy path, payment/money flows, data integrity, security-critical
   - **medium**: Alternative paths, common edge cases, permission boundaries
   - **low**: Rare edge cases, cosmetic validation, error message wording

5. **Determine test case IDs**:
   - Module abbreviation: from _meta.md `module` field, or derive from feature name (e.g., Order Management -> ORD)
   - Numbering: start at 001, or continue from highest existing TC ID if duplicates found
   - Format: `TC-{MODULE}-{NNN}`

**Do NOT write test cases yet** — proceed to the developer checkpoint first.

### Step 5: Developer Checkpoint

Present a flow summary, then ask grounded questions one at a time.

**Flow summary** (under 20 lines):
```
## Feature: [Feature Name]

Entry points: [N] endpoints across [M] web layers
Postconditions: [K] side effects discovered
Existing TCs: [X] found (will skip duplicates)

### Proposed Test Cases:
1. TC-{MOD}-001: {Flow title} (priority: high)
   Steps: {brief flow summary — e.g., "browse -> add to cart -> checkout -> payment -> confirm"}
2. TC-{MOD}-002: {Flow title} (priority: medium)
   Steps: {brief flow summary}
[etc.]

Flows skipped (already covered): [list or "none"]
```

When _meta.md is available, prepend:
```
### Prior Scope Decisions (from outline):
- {decision 1}
- {decision 2}
These are carried forward. I'll only ask about new findings.
```

Then ask grounded questions — **one at a time**. Use a **❓ Question:** prefix so the developer knows their input is needed. Each question must reference real findings with file:line evidence and pull NEW information from the developer. Focus on:

- Missing flows the code analysis couldn't detect (e.g., "I found create/update/delete flows but no bulk import — is that a feature?")
- Postconditions the integration-scanner might have missed (e.g., "No webhook found for order status changes — is there an external notification I'm not seeing?")
- Priority overrides (e.g., "I marked refund flow as medium — should it be high given payment implications?")
- User roles and permissions that affect test preconditions
- Test data requirements not obvious from code

When _meta.md is available: skip questions already answered in `## Checkpoint History`. Only ask about new findings not covered by prior decisions.

**CRITICAL**: Ask ONE question at a time. Wait for the answer before asking the next. Lead with your most significant finding.

**Choosing question format:**

- **`ask_user_question` tool** — when your question has 2-4 concrete options from code analysis (pattern conflicts, integration choices, scope boundaries, priority overrides). The user can always pick "Other" for free-text. Example: Use the `ask_user_question` tool with the question "Found 2 mapping approaches — which should new code follow?". Options: "Manual mapping (Recommended)" (Used in OrderService (src/services/OrderService.ts:45) — 8 occurrences); "AutoMapper" (Used in UserService (src/services/UserService.ts:12) — 2 occurrences).

- **Free-text with ❓ Question: prefix** — when the question is open-ended and options can't be predicted (discovery, "what am I missing?", corrections). Example:
  "❓ Question: Integration scanner found no background job registration for this area. Is that expected, or is there async processing I'm not seeing?"

**Batching**: When you have 2-4 independent questions (answers don't depend on each other), you MAY batch them in a single `ask_user_question` call. Keep dependent questions sequential.

**Classify each response:**

**Corrections** (e.g., "that flow doesn't exist", "wrong priority"):
- Update flow list. Record in notes.

**Missing flows** (e.g., "you missed the bulk export feature"):
- Spawn targeted **codebase-analyzer** (max 1 agent) to analyze the missing area.
- Add the flow to the list.

**Scope adjustments** (e.g., "skip admin flows, focus on customer portal"):
- Remove out-of-scope flows. Record the adjustment.

**Confirmations** (e.g., "looks good", "yes proceed"):
- Proceed to Step 6.

### Step 6: Generate Test Case Documents

Read the templates before writing:
- Read the full test case template at `templates/test-case.md`
- Read the full regression suite template at `templates/regression-suite.md`

See `examples/order-placement-flow.md` (e-commerce order flow), `examples/customer-auth-flow.md` (authentication flow), and `examples/team-management-flow.md` (SaaS team management flow) for well-formed test case examples.

What makes these examples good:
- **Steps are user-centric** — "Navigate to...", "Click...", "Enter..." — not technical ("POST to /api/orders")
- **Expected results are observable** — what the user SEES, not internal state changes
- **Postconditions verify side effects** — email sent, inventory updated, audit logged
- **Edge cases are separate bullets** — not crammed into steps
- **Preconditions are specific** — exact user role, required test data, system state

See `examples/order-management-suite.md` and `examples/team-management-suite.md` for well-formed regression suite examples.

What makes these examples good:
- **Smoke subset is minimal** — 2-4 high-priority TCs covering critical paths
- **Priority ordering** — high -> medium -> low within the full regression table
- **Coverage map** cross-references TCs against feature sub-areas
- **Gaps section** flags known uncovered areas for future work

**For each confirmed flow**, generate a test case document:
- Follow the test-case.md template exactly
- Write user-facing actions in Steps (what they click/type/navigate), not API calls
- Use actual UI element names discovered by Agent C (button labels, form fields, navigation items, messages) — do NOT fabricate element names from backend semantics. If Agent C didn't find a specific label, describe the element generically (e.g., "submit button" not "Click 'Save Changes'")
- Expected results describe what the user observes (success message, redirect, updated list)
- Postconditions describe system-level side effects (from integration-scanner findings)
- Edge cases list variant scenarios worth separate testing
- Include preconditions: user role, required test data, system state
- Include `generated_at_commit` in frontmatter with current git commit hash

**After all TCs**, generate the regression suite document:
- Follow the regression-suite.md template
- List all TCs with priority ordering (high -> medium -> low)
- Mark smoke test subset (TCs that cover critical paths in minimal time)
- Include coverage map cross-referencing TCs to feature sub-areas
- Calculate total estimated execution time
- Include `git_commit` in overview with current commit hash

### Step 7: Write Files & Update Artifacts

1. **Determine output directory**:
   - Target: `.rpiv/test-cases/{feature-slug}/` in the current working directory
   - Feature slug: from _meta.md (when available) or kebab-case from feature name
   - Create the directory if it doesn't exist

2. **Write all files at once** using the Write tool:
   - Individual TC files: `TC-{MOD}-{NNN}_{flow-slug}.md`
   - Regression suite: `_regression-suite.md` (underscore prefix sorts it first)
   - Do NOT ask for confirmation before each file — batch mode

3. **Update _meta.md** (when it exists):
   - Set `tc_count` to the number of TCs written
   - Set `status` to `generated`
   - Update `generated` date to current date
   - Append new checkpoint Q&A pairs to `## Checkpoint History` under a new date header — only if new Q&A occurred during Step 5

4. **Rebuild root coverage map** at `.rpiv/test-cases/_coverage-map.md`:
   - Read the coverage map template at `templates/coverage-map.md`
   - Glob for all `_regression-suite.md` files across `.rpiv/test-cases/*/`
   - Glob for all `_meta.md` files across `.rpiv/test-cases/*/`
   - Read each file's key data (frontmatter, summary stats, coverage map, smoke subset)
   - Aggregate into the coverage map template
   - Write the file (if only one feature exists, the map shows just that feature — it grows over time)

5. **Present summary**:
   ```
   ## Test Cases Written

   | File | Priority | Flow |
   |------|----------|------|
   | TC-ORD-001_place-order.md | high | Place and confirm order |
   | TC-ORD-002_cancel-order.md | medium | Cancel order before fulfillment |
   | _regression-suite.md | — | Feature summary (N TCs, ~Xm execution) |
   | _coverage-map.md | — | Project-wide coverage (N features, M TCs) |

   Output: `.rpiv/test-cases/{feature-slug}/`
   Total: [N] test cases + 1 regression suite + 1 coverage map

   Review the generated test cases and let me know if you'd like adjustments.
   ```

### Step 8: Handle Follow-ups

- **Add missing flows**: Spawn targeted codebase-analyzer, generate new TCs, regenerate regression suite and coverage map
- **Adjust priorities**: Edit TC frontmatter, regenerate regression suite and coverage map
- **Modify steps**: Edit specific TC files directly
- **Delete TCs**: Remove the file, regenerate regression suite and coverage map
- **Re-run for different feature**: User invokes the skill again with a new feature name

On any TC change: always regenerate `_regression-suite.md` and `_coverage-map.md` to keep them in sync.

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
| None found | Backend-only | Fallback — omit framework hint |

## Important Notes

- **Manual test cases for QA teams** — NOT automated test code. Write in natural language from the user's perspective.
- **Flow-level granularity** — each TC covers a complete user journey, not a single endpoint.
- **Postconditions are critical** — side effects from domain events are what distinguish a thorough TC from a superficial one.
- **Never skip the developer checkpoint** — QA domain knowledge (which flows matter most, what edge cases exist in production) is the highest-value signal.
- **_meta.md is warm start, not truth** — always validate against live code via Agent A, even with _meta.md available.
- **File reading**: Always read templates FULLY (no limit/offset) before generating test cases.
- **Critical ordering**: Follow the numbered steps exactly.
  - ALWAYS wait for discovery agents (Step 2) before spawning analysis agents (Step 3)
  - ALWAYS wait for ALL agents to complete before synthesizing (Step 4)
  - ALWAYS resolve all checkpoint questions (Step 5) before generating TCs (Step 6)
  - ALWAYS regenerate regression suite and coverage map after any TC writes (Step 7)
  - NEVER write test case files with placeholder values
- **Duplicate avoidance**: Always check existing TCs via test-case-locator before generating new ones.
- **ID continuity**: If existing TCs exist for this module, continue numbering from the highest existing ID.
- CC auto-loads CLAUDE.md files when agents read files in a directory — no need to scan for them explicitly.
