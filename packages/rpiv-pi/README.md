# rpiv-pi

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-pi.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠ **Pi compatibility** — `rpiv-pi` `0.11.x` supports **`@mariozechner/pi-coding-agent` ≤ 0.67.67**. Newer Pi releases introduce breaking changes and are unsupported on this line. Pin Pi to `0.67.67` (`npm i -g @mariozechner/pi-coding-agent@0.67.67`) or wait for the next `rpiv-pi` major.

Skill-based development workflow for [Pi Agent](https://github.com/badlogic/pi-mono) — discover, research, design, plan, implement, and validate. rpiv-pi extends Pi Agent with a pipeline of chained AI skills, named subagents for parallel analysis, and session lifecycle hooks for automatic context injection.

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
| `claim-verifier` | Grounds reconciled code-review findings at cited `file:line`; tags Verified / Weakened / Falsified |
| `codebase-analyzer` | Analyzes implementation details for specific components |
| `codebase-locator` | Locates files and components relevant to a task |
| `codebase-pattern-finder` | Finds similar implementations and usage patterns |
| `diff-auditor` | Row-only patch auditor; walks a patch against a caller-supplied surface-list and emits `file:line \| verbatim \| surface-id \| note` rows |
| `integration-scanner` | Maps inbound references, outbound deps, and config wiring |
| `peer-comparator` | Pairwise peer-invariant comparator; tags each peer invariant Mirrored / Missing / Diverged / Intentionally-absent |
| `precedent-locator` | Finds similar past changes in git history |
| `test-case-locator` | Finds existing test cases and reports coverage stats |
| `thoughts-analyzer` | Deep-dive analysis on research topics |
| `thoughts-locator` | Discovers relevant documents in the `thoughts/` directory |
| `web-search-researcher` | Researches web-based information and documentation |

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
- **Agent concurrency** — `@tintinweb/pi-subagents` defaults to 4 concurrent agents; raise via `/agents → Settings → Max concurrency → 48` if skills stall on wide fan-outs
- **Agent profiles** — editable at `<cwd>/.pi/agents/`; sync from bundled defaults with `/rpiv-update-agents` (overwrites rpiv-managed files, preserves your custom agents)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Warning about missing siblings on session start | Sibling plugins not installed | Run `/rpiv-setup` |
| `/rpiv-setup` fails on a package | Network or registry issue | Check connection, retry with `pi install npm:<pkg>`, re-run `/rpiv-setup` |
| `/rpiv-setup` says "requires interactive mode" | Running in headless mode | Install manually: `pi install npm:<pkg>` for each sibling |
| `web_search` or `web_fetch` errors | Brave API key not configured | Run `/web-search-config` or set `BRAVE_SEARCH_API_KEY` |
| `advisor` tool not available after upgrade | Advisor model selection lost | Run `/advisor` to re-select a model |
| Skills hang or serialize agent calls | Agent concurrency too low | Raise via `/agents → Settings → Max concurrency → 48` |

## License

MIT
