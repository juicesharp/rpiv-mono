# Model configuration

How to give Pi a model provider, and how `@juicesharp/rpiv-pi` routes individual
agents, skills, and workflow stages to different models and reasoning levels.

## Part 1 — giving Pi a provider

This is Pi Agent's own configuration, not rpiv-pi's. If `/login` already works or
`~/.pi/agent/models.json` is set up, skip to Part 2. Pick one:

**Subscription login** — start Pi and run `/login` to authenticate with Anthropic
Claude Pro/Max, ChatGPT Plus/Pro, or GitHub Copilot. `/login` also accepts plain API
keys for other providers, including Google Gemini.

**BYOK (API key)** — edit `~/.pi/agent/models.json` and add a provider entry with
`baseUrl`, `api`, `apiKey`, and `models[]`. Example, using the z.ai GLM coding plan:

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

With no provider configured, `/rpiv-models` cannot offer you anything and reports
`No models available (no API keys configured?).`

## Part 2 — rpiv-pi's `models.json`

### Where it lives

`<config dir>/rpiv-pi/models.json`, where the config dir is `$XDG_CONFIG_HOME` when
that is set to an absolute path (or a `~` / `~/…` path, which is tilde-expanded
first), and `~/.config` otherwise.

| Environment | Path |
| --- | --- |
| default | `~/.config/rpiv-pi/models.json` |
| `XDG_CONFIG_HOME=/x` | `/x/rpiv-pi/models.json` |

An `XDG_CONFIG_HOME` that is unset, empty, whitespace-only, relative, or in `~user`
form is ignored and `~/.config` is used.

**Reads fall back, writes do not.** If the XDG path does not exist, rpiv-pi still reads
`~/.config/rpiv-pi/models.json`. If the XDG path *does* exist, it wins even when its
JSON is malformed — corruption is warned about, never masked by the legacy file.
`/rpiv-models` always writes the XDG path.

The file is written with mode `0600`. The `chmod` is best-effort and never gates
success, so filesystems that ignore permission bits (tmpfs, some network mounts,
Windows) still save correctly.

Missing or malformed JSON degrades to no overrides at all. The parsed config is cached
for the session and re-read after a successful `/rpiv-models` save or a
`/rpiv-update-agents` run.

### Schema

| Key | Type | Applies to |
| --- | --- | --- |
| `defaults` | entry | Everything below that does not override it |
| `agents` | `{ [agentName]: entry }` | Bundled subagents, keyed by filename without `.md` |
| `stages` | `{ [stageName]: entry }` | A workflow stage, in every workflow that has it |
| `skills` | `{ [skillName]: entry }` | A skill, both as a `/wf` stage and as a typed `/skill:<name>` |
| `presets` | `{ [workflowName]: { stages: { [stage]: entry } } }` | One stage of one workflow |

An **entry** is either a bare string `"provider/modelId"` or an object
`{ "model": "provider/modelId", "thinking": "<level>" }`. No other keys are accepted at
any level — a `presets.<name>.defaults` block, for example, is rejected by the schema.

### Cascade

Most specific wins:

1. `presets[workflow].stages[stage]`
2. `stages[stage]`
3. `skills[skill]`
4. `defaults`

Each layer is composed field-by-field against `defaults` when the file loads, so an
entry that sets only `thinking` still inherits the default model. Two *configured*
layers do not merge with each other — the most specific one replaces the others whole.

**The standalone `/skill:` exception.** A user-typed `/skill:<name>` picks up an
override only from an explicit `skills[<name>]` entry. `defaults` does not arm it, so
your current session model stays sovereign for anything you invoke by hand.

### Reasoning levels

Six values are accepted in `thinking`: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`. Omitting the field and setting it to `off` are different: omitting inherits the
session baseline, `off` explicitly disables reasoning. Anything else is warned about:

```
[rpiv-pi] models.json: unknown thinking level "<v>" — valid values: off, minimal, low, medium, high, xhigh
```

### Model key form

Canonical is `provider/modelId` with a slash. The legacy `provider:modelId` colon form
still parses on read for back-compatibility; new saves emit the slash form.

### Typo detection

A session-start check reports record keys that pass schema validation but would silently
never apply — `skills.committ`, `agents.codebase-analzyer`, `presets.shipp`,
`presets.ship.stages.plann`. It warns once per process with the dotted path. The
`agents` and `skills` axes are always checked; `stages` and `presets` are checked only
when the workflow runner can supply the universe of names, so you never get a false
warning from a workflow it could not see.

## Worked examples

**Cheap models for cheap turns**

```json
{
  "defaults": "anthropic/claude-opus-4-7",
  "skills": {
    "commit": "zai/glm-4-7",
    "changelog": "zai/glm-4-7",
    "research": { "model": "openai/gpt-5.5", "thinking": "high" }
  }
}
```

Your default is Opus. `/skill:commit` and `/skill:changelog` use the cheaper GLM;
`/skill:research` uses GPT-5.5 at high effort. Workflow-dispatched runs of the same
skills inherit the same overrides through the cascade's skill rung.

**Per-workflow stage overrides**

```json
{
  "defaults": "anthropic/claude-opus-4-7",
  "presets": {
    "ship": {
      "stages": {
        "plan": "openai/gpt-5.5",
        "design": { "model": "openai/gpt-5.5", "thinking": "high" }
      }
    },
    "polish": {
      "stages": {
        "plan": "zai/glm-4-7"
      }
    }
  }
}
```

`/wf ship`'s plan and design stages use GPT-5.5, `/wf polish`'s plan stage uses GLM, and
everything else falls through to Opus.

**A subagent on a cheaper model**

```json
{
  "agents": {
    "codebase-locator": "zai/glm-4-7",
    "web-search-researcher": { "model": "zai/glm-4-7", "thinking": "off" }
  }
}
```

Agent overrides are injected into the agent's frontmatter on disk, so they take effect
the next time the file is synced. Run `/rpiv-update-agents` to apply them mid-session.

## The `/rpiv-models` picker

`/rpiv-models` walks scope → key → model → effort → save. `esc` steps back one level;
`esc` at the scope step exits. It requires interactive mode.

- Every scope, including `defaults`, offers **Reset to default** to drop an override.
- A **reset all overrides** scope clears the file, behind a confirmation dialog.
- Non-reasoning models skip the effort step and commit immediately.
- The effort step lists `inherit (no override)` and `off (disable reasoning)` as
  separate choices — picking `inherit` persists no `thinking` field at all.
- On save it notifies `Saved <scope>/<key> → <model> (<effort>)`; removing an override
  notifies `Removed <label>.`
