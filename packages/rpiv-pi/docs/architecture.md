# Architecture and internals

What `@juicesharp/rpiv-pi` registers into a Pi session, how it finds its siblings, and
how it injects context. Read this if you are debugging behavior you did not ask for, or
extending the package.

## The package tree

```
rpiv-pi/
├── extensions/rpiv-core/   the one extension: hooks, commands, lanes, guidance, model config
├── skills/                 27 contract-carrying skills, one directory each
├── agents/                 15 subagent profiles, copied to ~/.pi/agent/agents/ at runtime
└── scripts/                deterministic helpers skills shell out to (Node built-ins only)
```

The `pi` manifest in `package.json` is two lines:

```json
"pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
```

Extensions load as TypeScript through jiti — there is no build step. Agents are not in
the manifest; they are copied to disk instead (see [agents.md](./agents.md)).

## It registers zero tools

rpiv-pi calls `registerTool` nowhere. Every tool its skills use — `Agent`,
`ask_user_question`, `todo`, `advisor`, `web_search`, `web_fetch` — comes from a sibling
package. rpiv-pi contributes skills, agents, workflows, commands, and session behavior;
the siblings contribute capability.

## Session surfaces

| Surface | Registered by | Notes |
| --- | --- | --- |
| `/rpiv-setup` | always | Interactive only |
| `/rpiv-update-agents` | always | |
| `/rpiv-models` | always | Interactive only |
| `/lanes` | always | No-ops with a notice when nothing is running |
| `ctrl+q` | conditionally | Skipped entirely when `RPIV_LANES_HOTKEY` disables it |
| `/skill:<name>` × 27 | Pi, from the manifest | |
| `--rpiv-debug` flag | always | Reveals the hidden injected messages below |

Session events subscribed: `session_start`, `session_compact`, `session_shutdown`,
`tool_call`, `before_agent_start`, plus `input` and `agent_end` for the `/skill:` model
bracket.

Startup maintenance — per-directory cleanup, agent sync, and the sibling banner — runs
once per process load, not on every `session_start`.

## Guidance injection

On every `read`, `edit`, or `write` tool call, rpiv-pi walks from the project root down
to the touched file's directory. At each depth it picks **at most one** file, the first
that exists of:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.rpiv/guidance/<subpath>/architecture.md`

Depth 0 skips `AGENTS.md` and `CLAUDE.md` because Pi's own resource loader already
handles the working directory, but it still checks
`<cwd>/.rpiv/guidance/architecture.md`. Root guidance is additionally injected at
`session_start`.

Delivery is a hidden message with `customType: "rpiv-guidance"`. An in-process set
deduplicates it, cleared on `session_start`, `session_compact`, and `session_shutdown`.
Run `pi --rpiv-debug` to see the messages as they are sent.

## Git context injection

Branch, short commit, and user are injected at `session_start`, re-injected after
`session_compact`, and on `before_agent_start` only when they changed — a git-mutating
bash command invalidates the cache. `customType: "rpiv-git-context"`, also revealed by
`--rpiv-debug`.

Git is optional. If the `git` calls fail, the injection is skipped and nothing else
changes. When `git config user.name` is empty, `$USER` is used, then `unknown`.

## Pipeline pointer

18 of the 27 skills set `disable-model-invocation: true`, which hides them from the
model's skill list so it cannot wander into a design pass mid-conversation. To keep them
discoverable, a roughly 120-token stage index is injected at `session_start` — hidden
by default, visible under `--rpiv-debug`.

## Sibling coupling

Sibling **presence** is detected from the filesystem: a case-insensitive regex over the
`packages[]` array in the active Pi settings file (`<agent dir>/settings.json`, honoring
`PI_CODING_AGENT_DIR`). No sibling is statically imported from the entry graph; a test
enforces that.

`/rpiv-setup` installs eight packages:

| Package | Provides |
| --- | --- |
| `@tintinweb/pi-subagents` | `Agent`, `get_subagent_result`, `steer_subagent` tools |
| `@juicesharp/rpiv-ask-user-question` | `ask_user_question` tool |
| `@juicesharp/rpiv-todo` | `todo` tool, `/todos`, overlay widget |
| `@juicesharp/rpiv-advisor` | `advisor` tool and `/advisor` |
| `@juicesharp/rpiv-i18n` | `/languages`, `--locale`, the i18n SDK |
| `@juicesharp/rpiv-web-tools` | `web_search`, `web_fetch`, `/web-tools` |
| `@juicesharp/rpiv-args` | `$N` / `$ARGUMENTS` substitution in skill bodies |
| `@juicesharp/rpiv-workflow` | `/wf` and the workflow runner |

It installs them serially with a 120-second timeout each, previews every change in a
confirmation dialog, and applies nothing until you confirm. It also prunes the
superseded `pi-subagents` entry from `settings.json` when it finds one.

Only two siblings are ever imported at runtime, both behind guarded dynamic imports that
no-op silently when the module is absent: `@juicesharp/rpiv-workflow` (built-in
workflows, execution host, skill contracts, lane progress) and `@juicesharp/rpiv-warp`
(the Blocked badge on parked questions, entirely opt-in).

Registration order is load-bearing. The session hooks, `/rpiv-update-agents`, and
`/rpiv-setup` register unconditionally and first, so a clean install with no siblings
still shows the missing-siblings banner and can fix itself. The three
workflow-dependent registrars are chained strictly in sequence to avoid a
half-initialized barrel under jiti.

## Uninstall

```sh
pi uninstall npm:@juicesharp/rpiv-pi
```

Optionally `pi uninstall npm:@tintinweb/pi-subagents` if no other plugin needs it, then
restart Pi. Your `.rpiv/artifacts/` tree, `~/.config/rpiv-pi/models.json`, and
`~/.pi/agent/agents/` are left in place — delete them by hand if you want them gone.

## Releasing

Every `@juicesharp/rpiv-*` package ships in lockstep from the monorepo root via
`node scripts/release.mjs`. Never run `npm version` inside this package.
