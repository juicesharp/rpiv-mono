# rpiv-pi

<picture>
  <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-pi/docs/vertical-cover.png" alt="rpiv-pi vertical-cover" width="160">
</picture>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-pi.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Pi compatibility** — `rpiv-pi` `0.14.x` tracks `@mariozechner/pi-coding-agent` `0.70.x` and `@tintinweb/pi-subagents` `0.6.x`. If you see peer-dep resolution issues after a Pi upgrade, open an issue.

> **⚠️ Upgrading from `0.13.x`** — `1.0.0` swaps the subagent provider from `npm:pi-subagents` (nicobailon fork) back to `npm:@tintinweb/pi-subagents` (resumed maintenance). On first launch after upgrade you'll see *"rpiv-pi requires 1 sibling extension(s): @tintinweb/pi-subagents"* — **run `/rpiv-setup` once and restart Pi**. The setup dialog previews both changes (install `@tintinweb/pi-subagents`, remove `npm:pi-subagents` from `~/.pi/agent/settings.json`) and applies them only after you confirm. After restart, run `/rpiv-update-agents` to refresh the 12 bundled specialist frontmatters. Customised `<cwd>/.pi/agents/*.md` files are not touched. The tool name reverts from `subagent` → `Agent` (param `subagent_type`/`description`/`prompt`) — only your own custom skills/agents need editing; the bundled rpiv-pi specialists are migrated in this release.

Skill-based development workflow for [Pi Agent](https://github.com/badlogic/pi-mono) — discover, research, design, plan, implement, and validate. rpiv-pi extends Pi Agent with a pipeline of chained AI skills, named subagents for parallel analysis, and session lifecycle hooks for automatic context injection.

## What you get

- **A pipeline of chained AI skills** — discover → research → design → plan → implement → validate, each producing a reviewable artifact under `thoughts/shared/`.
- **Named subagents for parallel analysis** — `codebase-analyzer`, `codebase-locator`, `codebase-pattern-finder`, `claim-verifier`, and 8 more, dispatched automatically by skills.
- **Session lifecycle hooks** — agent profiles, guidance files, and pipeline directories scaffold themselves on first launch.

## Prerequisites

- **Node.js** — required by Pi Agent
- **[Pi Agent](https://github.com/badlogic/pi-mono)** — install globally so the `pi` command is available:

  ```bash
  npm install -g @mariozechner/pi-coding-agent
  ```

- **Model provider** *(first-time Pi Agent users only — skip if `/login` already works or `~/.pi/agent/models.json` is configured)*. Pick one:

  - **Subscription login** — start Pi Agent and run `/login` to authenticate with Anthropic Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, or Gemini.
  - **BYOK (API key)** — edit `~/.pi/agent/models.json` and add a provider entry with `baseUrl`, `api`, `apiKey`, and `models[]`. Example (z.ai GLM coding plan):

    ```json
    {
      "providers": {
        "zai": {
          "baseUrl": "https://api.z.ai/api/coding/paas/v4",
          "api": "openai-completions",
          "apiKey": "XXXXXXXXX",
          "compat": {
            "supportsDeveloperRole": false,
            "thinkingFormat": "zai"
          },
          "models": [
            {
              "id": "glm-5.1",
              "name": "glm-5.1 [coding plan]",
              "reasoning": true,
              "input": ["text"],
              "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
              "contextWindow": 204800,
              "maxTokens": 131072
            }
          ]
        }
      }
    }
    ```

- **git** *(recommended)* — rpiv-pi works without it, but branch and commit context won't be available to skills.

## Quick Start

1. Install rpiv-pi:

```bash
pi install npm:@juicesharp/rpiv-pi
```

2. Start a Pi Agent session and install sibling plugins:

```
/rpiv-setup
```

3. Restart your Pi Agent session.

4. *(Optional)* Configure web search:

```
/web-search-config
```

### First Session

On first Pi Agent session start, rpiv-pi automatically:
- Copies agent profiles to `<cwd>/.pi/agents/`
- Detects outdated or removed agents on subsequent starts
- Scaffolds `thoughts/shared/` directories for pipeline artifacts
- Shows a warning if any sibling plugins are missing

## Usage

### Typical Workflow

```
/skill:discover "how does X work"
/skill:research thoughts/shared/questions/<latest>.md
/skill:design thoughts/shared/research/<latest>.md
/skill:plan thoughts/shared/designs/<latest>.md
/skill:implement thoughts/shared/plans/<latest>.md Phase <N>
```

Each skill produces an artifact consumed by the next. Run them in order, or jump in at any stage if you already have the input artifact.

### Recipes

Skills compose. Pick the entry point that matches your intent:

- **Form context before a task** — `/skill:discover "[topic]"` → `/skill:research <questions artifact>`. Produces a high-signal subspace of the codebase relevant to your topic, ready to feed directly into the next prompt.
- **Compare approaches before designing** — `/skill:explore "[problem]"` → `/skill:design <solutions artifact>`. Use when multiple valid solutions exist; the solutions artifact is a first-class input to `design` alongside a `research` artifact.
- **One-shot plan from research** — `/skill:research <questions>` → `/skill:blueprint <research artifact>` → `/skill:implement`. Fuses `design` + `plan` into a single pass with the same slice-by-slice rigor, but spawns only `codebase-pattern-finder` upfront (vs `design`'s 4-agent fan-out) by trusting the research artifact's integration/precedent sections. Use for solo work or when no one else needs to review the design before implementation; pick `design` → `plan` when the design is itself a deliverable or when research is thin and you want the fuller verification sweep.
- **Full feature build** — `/skill:discover` → `research` → `design` → `plan` → `implement` → `validate` → (`code-review` ↔ `commit`). The default pipeline; jump in at any stage if you already have the input artifact. Review and commit are interchangeable in order — review `staged`/`working` before committing, or commit first and review the resulting branch (empty scope, first-parent vs default).
- **Investigate a bug** — `/skill:discover "why does X fail"` → `/skill:research <questions artifact>`. Fix from the research output without writing a plan when the change is small.
- **Adjust mid-implementation** — `/skill:revise <plan artifact>` → resume `/skill:implement`. Use when new constraints land after the plan is drafted.
- **Review before shipping** — `/skill:code-review` ↔ `/skill:commit`. Order is your call: review `staged`/`working` before committing to catch issues at the smallest blast radius, or commit first and review the resulting branch (empty scope defaults to feature-branch-vs-default-branch, first-parent). Produces a Quality/Security/Dependencies artifact under `thoughts/shared/reviews/` with claim-verifier-grounded findings and `status: approved | needs_changes`.
- **Audit a specific scope** — `/skill:code-review <commit|staged|working|hash|A..B|branch>`. Targeted lenses over a commit, range, staged/working tree, or PR branch; advisor adjudication applies when configured (`/advisor`).
- **Review-driven plan revision** — `/skill:code-review` → `/skill:revise <plan artifact>` → resume `/skill:implement`. When a mid-stream review surfaces structural findings that the existing plan can't absorb as spot fixes.
- **Scaffold manual UI test specs** — `/skill:outline-test-cases` → `/skill:write-test-cases <feature>`. Outline first via Frontend-First Discovery to map project scope and avoid duplicate coverage, then generate flow-based manual test cases (with a regression suite) under `.rpiv/test-cases/<feature>/`.
- **Hand off across sessions** — `/skill:create-handoff` → (new session) `/skill:resume-handoff <doc>`. Preserves context when stopping mid-task.
- **Onboard a fresh repo** — `/skill:annotate-guidance` once, then use the rest of the pipeline normally. Use `annotate-inline` instead if the project follows the `CLAUDE.md` convention.

### Skills

Invoke via `/skill:<name>` from inside a Pi Agent session.

#### Research & Design

| Skill | Input | Output | Description |
|---|---|---|---|
| `discover` | — | `thoughts/shared/questions/` | Generate research questions from codebase discovery |
| `research` | Questions artifact | `thoughts/shared/research/` | Answer questions via parallel analysis agents |
| `explore` | — | `thoughts/shared/solutions/` | Compare solution approaches with pros/cons |
| `design` | Research or solutions artifact | `thoughts/shared/designs/` | Design features via vertical-slice decomposition |

#### Implementation

| Skill | Input | Output | Description |
|---|---|---|---|
| `plan` | Design artifact | `thoughts/shared/plans/` | Create phased implementation plans |
| `blueprint` | Research or solutions artifact | `thoughts/shared/plans/` | Fused `design` + `plan`: vertical-slice decomposition with micro-checkpoints, emits implement-ready phased plan in one pass. Lighter on subagent fan-out than `design` — trusts the research artifact's integration/precedent sections instead of re-dispatching. Use when a separate design artifact isn't needed for review or handoff |
| `implement` | Plan artifact | Code changes | Execute plans phase by phase |
| `revise` | Plan artifact | Updated plan | Revise plans based on feedback |
| `validate` | Plan artifact | Validation report | Verify plan execution |

#### Testing

| Skill | Input | Output | Description |
|---|---|---|---|
| `outline-test-cases` | — | `.rpiv/test-cases/` | Discover testable features with per-feature metadata |
| `write-test-cases` | Outline metadata | Test case specs | Generate manual test specifications |

#### Annotation

| Skill | Input | Output | Description |
|---|---|---|---|
| `annotate-guidance` | — | `.rpiv/guidance/*.md` | Generate architecture guidance files |
| `annotate-inline` | — | `CLAUDE.md` files | Generate inline documentation |
| `migrate-to-guidance` | CLAUDE.md files | `.rpiv/guidance/` | Convert inline docs to guidance format |

#### Utilities

| Skill | Description |
|---|---|
| `code-review` | Comprehensive code reviews using specialist row-only agents (`diff-auditor`, `peer-comparator`, `claim-verifier`) at narrativisation-prone dispatch sites |
| `commit` | Structured git commits grouped by logical change |
| `create-handoff` | Context-preserving handoff documents for session transitions |
| `resume-handoff` | Resume work from a handoff document |

### Commands

| Command | Description |
|---|---|
| `/rpiv-setup` | Install all sibling plugins in one go |
| `/rpiv-update-agents` | Sync rpiv agent profiles: add new, update changed, remove stale |
| `/advisor` | Configure advisor model and reasoning effort |
| `/btw` | Ask a side question without polluting the main conversation |
| `/todos` | Show current todo list |
| `/web-search-config` | Set Brave Search API key |

### Agents

Agents are dispatched automatically by skills via the `Agent` tool — you don't invoke them directly.

| Agent | Purpose |
|---|---|
| `claim-verifier` | Grounds each supplied code-review claim against repository state and tags it Verified / Weakened / Falsified |
| `codebase-analyzer` | Analyzes implementation details for specific components |
| `codebase-locator` | Locates files, directories, and components relevant to a feature or task |
| `codebase-pattern-finder` | Finds similar implementations and usage examples with concrete code snippets |
| `diff-auditor` | Walks a patch against a caller-supplied surface-list and emits `file:line \| verbatim \| surface-id \| note` rows |
| `integration-scanner` | Maps inbound references, outbound dependencies, config registrations, and event subscriptions for a component |
| `peer-comparator` | Compares a new file against a peer sibling and tags each invariant Mirrored / Missing / Diverged / Intentionally-absent |
| `precedent-locator` | Finds similar past changes in git history — commits, blast radius, and follow-up fixes |
| `test-case-locator` | Catalogs existing manual test cases under `.rpiv/test-cases/` and reports coverage stats |
| `thoughts-analyzer` | Performs deep-dive analysis on a research topic in `thoughts/` |
| `thoughts-locator` | Discovers relevant documents in the `thoughts/` directory |
| `web-search-researcher` | Researches modern web-only information via deep search and fetch |

## Architecture

```
rpiv-pi/
├── extensions/rpiv-core/   — runtime extension: hooks, commands, guidance injection
├── skills/                 — AI workflow skills (research → design → plan → implement)
├── agents/                 — named subagent profiles dispatched by skills
└── thoughts/shared/        — pipeline artifact store
```

Pi Agent discovers extensions via `"extensions": ["./extensions"]` and skills via `"skills": ["./skills"]` in `package.json`.

## Configuration

- **Web search** — run `/web-search-config` to set the Brave Search API key, or set the `BRAVE_SEARCH_API_KEY` environment variable
- **Advisor** — run `/advisor` to select a reviewer model and reasoning effort
- **Side questions** — type `/btw <question>` anytime (even mid-stream) to ask the primary model a one-off question; answer appears in a borderless bottom overlay and never enters the main conversation
- **Agent concurrency** — open the `/agents` overlay and tune `Settings → Max concurrency` to match your provider's rate limits. `@tintinweb/pi-subagents` owns this setting; rpiv-pi does not seed it.
- **Agent profiles** — editable at `<cwd>/.pi/agents/`; sync from bundled defaults with `/rpiv-update-agents` (overwrites rpiv-managed files, preserves your custom agents)

## Uninstall

1. Remove rpiv-pi from Pi: `pi uninstall npm:@juicesharp/rpiv-pi`
2. Optional — uninstall the subagent runtime if no other plugin needs it: `pi uninstall npm:@tintinweb/pi-subagents`
3. Restart Pi.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Warning about missing siblings on session start | Sibling plugins not installed | Run `/rpiv-setup` |
| `/rpiv-setup` fails on a package | Network or registry issue | Check connection, retry with `pi install npm:<pkg>`, re-run `/rpiv-setup` |
| `/rpiv-setup` says "requires interactive mode" | Running in headless mode | Install manually: `pi install npm:<pkg>` for each sibling |
| `web_search` or `web_fetch` errors | Brave API key not configured | Run `/web-search-config` or set `BRAVE_SEARCH_API_KEY` |
| `advisor` tool not available after upgrade | Advisor model selection lost | Run `/advisor` to re-select a model |
| Skills hang or serialize agent calls | Agent concurrency too low | Open `/agents`, raise `Settings → Max concurrency` |

## License

MIT
