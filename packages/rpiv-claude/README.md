# @juicesharp/rpiv-claude

Run rpiv-workflow pipelines (`/wf` in Pi) on Claude Code, headless, through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). No Pi process.

Same catalog as Pi's `/wf`: rpiv-pi's built-ins (`build`, `ship`, `vet`,
`polish`, `meta`) plus your user and project overlays (`.rpiv/workflows/`).
Same run state too: runs land in `.rpiv/workflows/runs/`, so a run started here
lists and resumes from Pi and vice versa.

`private: true`, like rpiv-telemetry: it runs from a checkout of this repo.

## Use

```sh
npm install                                   # at the repo root
npm run export:hosts                          # once: renders the rpiv Claude plugin

node packages/rpiv-claude/bin/rpiv-wf.mjs list
node packages/rpiv-claude/bin/rpiv-wf.mjs run ship "add a --json flag to the export command"
node packages/rpiv-claude/bin/rpiv-wf.mjs resume <run-id|name>
```

| Flag | Default | |
| --- | --- | --- |
| `--name <name>` | workflow name | name the run; resume it by name |
| `--model <id>` | Claude Code's | model for every stage (`claude-opus-5-5`, `sonnet`, `anthropic/…`) |
| `--concurrency <n>` | `4` | parallel fan-out units |
| `--permission-mode <mode>` | `auto` | Claude Code permission mode for each stage |
| `--plugin-dir <dir>` | `rpiv-pi/hosts/claude` | the rpiv Claude plugin |
| `--cwd <dir>` | current directory | project to run in |

Exit codes: `0` completed, `1` failed, `2` usage error, `130` interrupted (Ctrl-C
stops the run at the current stage; resume picks it up).

Authentication is Claude Code's own: whatever `claude` uses on the machine.

## How it maps

rpiv-workflow's runner is host-agnostic: every stage goes through one port,
`WorkflowHostContext.spawnChild`. rpiv-pi implements it over Pi's
`AgentSession`; this package implements it over the Agent SDK.

| Runner asks for | Claude Code does |
| --- | --- |
| a fresh stage session | a new session, first turn `query({ prompt })` |
| a re-prompt (validation retry) | `query({ resume: <session id> })` |
| reattach (resume a failed stage) | `resume` the stage's persisted session in place |
| fork (`sessionPolicy: "continue"`) | `forkSession()` into a new id that inherits the transcript |
| the stage's transcript | main-thread assistant frames; the SDK `result` sets the stop reason |
| `/skill:<name>` | `/rpiv:<name>` for rpiv's skills, `/<name>` for project/user skills |
| skill-registration preflight | the plugin's skills plus `.claude/skills` and `~/.claude/skills` |

At startup it registers what rpiv-pi registers inside Pi: the built-in
workflows, skill contracts from `contract:` frontmatter, and the outcome deriver
(`rpiv-support.ts`). Those modules are Pi-free.

## Differences from Pi

- **Headless only.** `AskUserQuestion` is unavailable to SDK runs, the same as
  Pi's headless mode removing `ask_user_question`. Skills that ask for
  confirmation decide without it, or stop and ask in chat. The `commit` skill
  asks before committing, so an unattended commit stage can end without a
  commit; `gitCommitOutcome` records that as `noOp: true`, not as a failure.
- **Anthropic models only.** A Pi model key for another provider fails that
  stage rather than silently running a different model. `models.json` per-stage
  routing is not read.
- **No lane console.** Progress prints to stderr.
- **Launched from inside Claude Code** (an agent's Bash tool, a cloud session),
  the launcher's `CLAUDE_CODE_SESSION_ID` is stripped from each stage's
  environment. Inherited, it made every stage resume the launcher's own session.
