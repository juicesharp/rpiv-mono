# agents/

## Monorepo Context
Lives inside `packages/rpiv-pi/`. The web-search-class agent's tools are provided by the rpiv-web-tools sibling. The `Agent` dispatch runtime comes from the third-party subagent extension that `rpiv-pi` declares as a wildcard (`"*"`) peer dependency.

## Responsibility
Named subagent profile library — isolated, single-purpose LLM workers dispatched by skills via the `Agent` tool. Each agent performs one narrow task (locate, analyze, connect, audit, or fetch externally) and returns structured text. Agents never write files, dispatch other agents, or modify state.

## Dependencies
- **Subagent dispatcher** (peer): provides `Agent` + `get_subagent_result` + `steer_subagent` and the per-agent isolation runtime
- **`@juicesharp/rpiv-web-tools`**: provides `web_search`/`web_fetch` to the External tier only

## Consumers
Skills only — agents are never user-invoked:

```typescript
Agent({ subagent_type: "codebase-analyzer", description: "analyze services", prompt: "Analyze src/services/ in detail. …" })
```

## Module Structure
```
<agent-name>.md                   — Flat folder. One file per agent; `name` frontmatter == filename stem
                                    == subagent_type value used by callers. Profiles are grouped by
                                    capability tier (see below), not by directory.
```

## Agent Definition Pattern

```markdown
---
name: codebase-locator         # matches filename stem exactly; used as subagent_type in Agent()
description: "What it finds. Call when [trigger]."
tools: grep, find, ls          # allowlist; add `read` for content; `bash` only for git
isolated: true                 # all but the External tier — hermetic tools: no extensions/skills/`ext:` selectors
---

You are a specialist at [ONE action + domain]. Your job is to [primary output], NOT to [adjacent activity outside this agent's scope].

## Core Responsibilities
1. **Verb Title**: 3-5 imperative bullets

## [Search/Analysis] Strategy
### Step 1: [Action]

## Output Format
[Fenced block with realistic filled-in example — NOT an abstract schema.
 Prefix with "CRITICAL: Use EXACTLY this format." if machine-parsed downstream.
 If the agent emits file:line citations, require repo-root-relative paths (see checklist step 6).]

## What NOT to Do
- Don't [adjacent activity outside scope] — describe the boundary directly, without naming another agent (the agent runs isolated and cannot dispatch siblings)

Remember: You're a [identity noun]. [One sentence on what success looks like for a caller].
```

## Capability Tiers (Tool Allowlist → Role)

```
grep, find, ls                              → Locator      (WHERE; no file content access)
+ read                                      → Analyzer     (HOW; use `ultrathink` in strategy)
+ bash (read-only git)                      → Git-analyzer
+ ext:rpiv-web-tools/web_search|web_fetch   → External     (declares `extensions: [rpiv-web-tools]`)
```

External-tier tools are namespaced `ext:<sibling>/<tool>` and the agent must declare the providing sibling in an `extensions:` frontmatter list (`web-search-researcher.md`: `extensions: [rpiv-web-tools]`). The External tier is the one exception to `isolated: true` — `web-search-researcher` declares no `isolated` field.

`general-purpose` is provided by the subagent dispatcher as a default agent (broad tool set, inherits project context). Skills that need a fallback dispatcher reference it by name without rpiv-pi shipping a profile file.

## Session Sync Lifecycle
At session start, the rpiv-core extension syncs bundled `.md` files into the global `~/.pi/agent/agents/` — new files are always copied, and a smart gate auto-updates/auto-removes managed files whose destination still matches the recorded hash; only user-edited files are held as pending. The manifest at `~/.pi/agent/agents/.rpiv-managed.json` tracks which files are managed so user-authored agents are never touched. Legacy per-cwd `<cwd>/.pi/agents/` installs are cleaned up at session start (`cleanupPerCwdAgents`). `/rpiv-update-agents` applies full sync: force add/update/remove, overwriting user edits.

## Architectural Boundaries
- **NO agent dispatches another agent** — `Agent` never appears in any allowlist
- **NO write or edit** — every agent is strictly read-only; `bash` is for git reads only
- **Locators have no `read`** — load-bearing distinction; locators report paths, analyzers read them
- **Specialists run isolated** — `isolated: true` is hermetic tool mode only: forces `extensions: false` + `skills: false` and drops `ext:` selectors. Empty history and a replaced system prompt come from the dispatcher defaults (`inherit_context: false`, `prompt_mode: replace`) and apply to every tier. Exception: the External tier (`web-search-researcher`) omits `isolated` so it can use sibling-provided `ext:` tools

<important if="you are adding a new agent to this layer">
## Adding a New Agent
1. Choose the capability tier — the tool allowlist flows from whether the agent locates, reads, uses git, or fetches from web
2. Name the file `kebab-case.md`; the `name` frontmatter must match the filename stem exactly
3. Frontmatter: `name`, `description`, `tools`, and `isolated: true` (omit `isolated` only for an External-tier agent, which instead declares `extensions: [<sibling>]` and uses `ext:<sibling>/<tool>` tool names). `description` addresses the caller ("Use when…"), not the agent itself
4. Opening sentence: "You are a specialist at X. Your job is to Y, NOT to Z." — Z is an adjacent activity outside this agent's scope, expressed without naming another agent (the agent runs isolated and cannot dispatch siblings)
5. Include `## What NOT to Do` and a closing `Remember:` sentence in every agent
6. Output Format: one fenced block with a realistic filled-in example; prefix with `CRITICAL: Use EXACTLY this format.` if downstream code parses the output. If the agent emits `file:line` citations, instruct it to use repo-root-relative paths — strip only the absolute prefix up to the repository root, never a package or subdirectory prefix (`packages/billing/src/invoice.ts:42`, not `src/invoice.ts:42`; see `integration-scanner.md:53`) — the workflow's deterministic citation floor verifies every citation against the tree: bare basenames and package-relative suffixes still back a citation when exactly one tree file matches, an ambiguous suffix fails as unresolved (with candidates), and only citations naming no real file or pointing past end-of-file are flagged as fabricated
7. If the agent depends on external state (e.g., git), add a `## Pre-flight` check with an explicit fallback output block
8. The file is auto-synced to the global `~/.pi/agent/agents/` at session start — no registration step needed
</important>
