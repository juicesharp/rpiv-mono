# rpiv-pi

Pi CLI plugin package: extends the Pi coding agent with TypeScript runtime infrastructure, slash commands, and Markdown-based AI workflow skills.

## Monorepo Context
Umbrella package in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family. All releases cut from monorepo root via `node scripts/release.mjs` — never `npm version` here individually. Sibling source lives at `../<name>/`; their tools are wired in via `extensions/rpiv-core/siblings.ts` (regex-based filesystem detection — no runtime imports).

# Architecture

```
rpiv-pi/
├── extensions/rpiv-core/   — Pi runtime extension (TypeScript): session hooks, /rpiv-* commands, sibling registry, guidance + git-context injection, model-management subsystem, built-in `/wf` workflows, detached `/wf` execution (SDK workflow host, lane dock/browser, question lifecycle). The sole TS surface in this package.
├── scripts/                — Internal post-install user utilities (currently a guidance-format migration CLI). Distinct from monorepo-root scripts/.
├── agents/                 — Named subagent profile library (Markdown). Read-only specialists dispatched by skills via the Agent tool.
└── skills/                 — User-invocable workflow definitions (Markdown). Each non-underscore subfolder is one skill (SKILL.md + optional support dirs like templates/ or _helpers/); `_shared/` holds cross-skill `.mjs` helper scripts.
```

Pi discovers extensions via `pi.extensions` and skills via `pi.skills` in `package.json`. **rpiv-pi registers zero tools** — every tool surface lives in a sibling plugin. Install missing siblings via `/rpiv-setup`.

# Commands

| Command | Description |
|---|---|
| `pi` | Start a Pi session with rpiv-pi loaded |
| `/skill:<name>` | Invoke a skill (e.g. `/skill:commit`, `/skill:discover`) |
| `/rpiv-update-agents` | Sync bundled agents into `~/.pi/agent/agents/`; clean up legacy per-cwd agent dirs |
| `/lanes` | Open the lane browser for detached `/wf` runs (equivalents: `^Q`, `↓` on an empty prompt) |
| `/rpiv-setup` | Install missing sibling plugins; prune `LEGACY_SIBLINGS` from `~/.pi/agent/settings.json` |
| `/rpiv-models` | Model/effort cascade picker — set per-skill/preset overrides written to `models.json` |

Sibling-plugin commands are registered by the siblings themselves once installed.

# Business Context

rpiv-pi augments Pi with a research → design → implement skill pipeline plus the runtime infrastructure those skills depend on (guidance injection, git-context injection, scaffolding, bundled-agent sync). rpiv-core also contributes five built-in `/wf` workflows (ship/build/arch/vet/polish) to the `@juicesharp/rpiv-workflow` sibling via `registerBuiltInWorkflows`, and a model-management subsystem (`/rpiv-models`, per-skill/preset model + effort overrides, `models.json`). `/wf` stages run in detached child sessions with bounded parallel fan-out (`sdk-workflow-host.ts` — the sole module importing Pi SDK session machinery; the interactive session stays a launcher/observer), monitored via an always-on lane dock below the editor and the `/lanes` browser, with per-lane question parking and an optional Warp question-lifecycle bridge (`workflow-question-warp-bridge.ts`). Tool surfaces live in sibling plugins.

<important if="you are adding a new end-to-end feature (skill + agent)">
## Adding a Feature End-to-End
1. Skill workflow → see `.rpiv/guidance/packages/rpiv-pi/skills/architecture.md`
2. Named subagent (if the skill needs a new specialist) → see `.rpiv/guidance/packages/rpiv-pi/agents/architecture.md`
3. Runtime infrastructure (session hooks, commands) → see `.rpiv/guidance/packages/rpiv-pi/extensions/rpiv-core/architecture.md`

New tools belong in sibling plugins, not here — `rpiv-pi` is pure infrastructure.
</important>

<important if="you are modifying guidance injection behavior">
## Guidance Injection Contract
Single delivery path inside `extensions/rpiv-core/`. On `tool_call` for read/edit/write, resolves per-depth at most one of `AGENTS.md > CLAUDE.md > .rpiv/guidance/<sub>/architecture.md` (depth 0 skips AGENTS/CLAUDE — Pi's own resource-loader handles `<cwd>` already). Each new file injected via `pi.sendMessage` with `display: !!pi.getFlag(FLAG_DEBUG)` (hidden unless the `rpiv-debug` flag is set); an in-process `Set` dedups across the session; cleared on `session_start`/`session_compact`/`session_shutdown`.
</important>

<important if="you are sunsetting an old sibling and replacing it with a new one">
## Deprecating a Sibling
1. Add the deprecated package's regex to `LEGACY_SIBLINGS` in `siblings.ts` with a one-line `reason`
2. The next `/rpiv-setup` invocation prunes the entry from `~/.pi/agent/settings.json` (only `matches` is consumed — the notify message lists the raw pruned `packages[]` entries)
3. Delete the deprecated entry from `SIBLINGS` and the `peerDependencies` block in `package.json`
4. Add a CHANGELOG note under `[Unreleased]` flagging the deprecation
</important>
