# rpiv-core Extension

## Monorepo Context
Lives inside `packages/rpiv-pi/`. Sibling tool source is at `../../../rpiv-<name>/`; this extension never statically value-imports them from the entry graph — `siblings.ts` regex-detects them in `~/.pi/agent/settings.json`. Adding a new sibling requires a `siblings.ts` entry plus a `peerDependencies` line in `rpiv-pi/package.json` pinned to `"*"`. Version changes flow through `node scripts/release.mjs` at monorepo root.

## Responsibility
Pi runtime orchestrator and detached-execution launcher/observer host. Owns zero tools. Wires session lifecycle hooks (guidance injection, git-context injection, pipeline-stage index, bundled-agent sync) and registers the rpiv-* slash commands plus the non-prefixed `/lanes`. Every `/wf` stage runs in an isolated child session spawned via the Pi SDK (`sdk-workflow-host.ts`, bounded parallel fan-out); the interactive session stays a launcher/observer with an always-on lane dock, lane browser/console, and a question-lifecycle → Warp bridge. Also hosts the model-management layer (`models.json` validation, `/rpiv-models` picker, `/skill:` override bracket) and contributes the four built-in `/wf` workflows (build / vet / polish / ship) + skill contracts into the `@juicesharp/rpiv-workflow` sibling via guarded dynamic imports. Pipeline-stage skills carry `disable-model-invocation` — gated to explicit `/skill:<name>` or workflow dispatch, with a compact stage index injected at session start (`pipeline-pointer.ts`). All tool surfaces live in sibling plugins listed in `siblings.ts`; all workflow intelligence lives in `skills/`.

## Dependencies
- **`@earendil-works/pi-coding-agent`**: `ExtensionAPI`, event-type guards, Pi SDK session machinery (`createAgentSession` — `sdk-workflow-host.ts` only). **`@earendil-works/pi-tui`**: static in the lane-*/picker UI modules. **`@earendil-works/pi-ai`** (peer): `Model` types + value imports (`getSupportedThinkingLevels` in `rpiv-models/items.ts`).
- **`@juicesharp/rpiv-config`** (dependency): static value imports — `configPath` + `loadJsonConfigWithLegacyFallback` + `validateConfig` in `models-config.ts`; `parseModelKey` in `session-capture.ts` + `sdk-workflow-host.ts`; `loadJsonConfigWithLegacyFallback` + `modelKey` + `saveJsonConfig` in `rpiv-models/`.
- **`typebox`** (dependency `^1.1.24`): `Type`/`Static` schema for `models.json` in `models-config.ts`.
- **`@juicesharp/rpiv-workflow`** (peer): guarded dynamic `import(...)` of `/startup` in `register-built-in-workflows.ts`, `workflow-execution-host.ts`, `lane-progress.ts`, `outcome-derivation.ts`, `skill-contracts-source.ts`; of `/registration` in `models-config-sources.ts`; of `/runner` in `lane-switcher.ts` (rerun-failed-run callback). Degrades silently when absent (isModuleNotFound guard). Off-entry-graph modules statically value-import the peer — `built-in-workflows.ts` (`/registration`), `built-ins/shared.ts` (`/registration` + `/runner`), `artifact-collector.ts` (`/registration`) — safe only because they are reached solely via those guarded dynamic imports; `skill-contracts-source.ts` sits on the entry graph and imports `/registration` types only.
- **`@juicesharp/rpiv-warp`** (opt-in — in neither `SIBLINGS` nor `peerDependencies`): guarded dynamic import in `workflow-question-warp-bridge.ts` for the per-run Blocked badge.
- Node built-ins: `node:fs`, `node:path`, `node:url`, `node:os`, `node:child_process`.
- External processes: `git` (via `pi.exec`), `pi` CLI (via `spawn` for the installer).

Sibling *presence detection* stays filesystem-based (regex over settings); two siblings load at runtime — `rpiv-workflow` and the opt-in `rpiv-warp` — always through guarded optional dynamic import. `sibling-import-graph.test.ts` enforces that no file statically reachable from `index.ts` value-imports a sibling.

## Consumers
- **Pi extension host**: loads via `package.json` `"pi": { "extensions": ["./extensions"] }`; calls `default export(pi: ExtensionAPI)` at session start — and again inside every detached child session, which is why registration must be root-gated + idempotent

## Module Structure
```
index.ts                — Composer; no inline handlers, but encodes ordering invariants: session-capture before skill-bracket; rpiv-workflow-dependent registrars chained strictly in sequence inside an async IIFE (jiti half-initialized-barrel race); provider/bridge hooks wired to the root launcher's session_start, not called directly.
session-hooks.ts        — Lifecycle wiring + guidance.ts / git-context.ts / agents.ts / pipeline-pointer.ts engines; compaction only marks the exact SessionManager and defers one merged context block to its next before_agent_start (never sendMessage inside session_compact).
sdk-workflow-host.ts    — Sole Pi-SDK importer: child AgentSession per stage/fanout unit, bounded parallel, deferring lane-relay UI.
run-lane-registry.ts    — Process-global in-memory run/lane/question state; seeds pending fan-out unit lanes at fanout onLoopStart (seedPendingUnits).
session-capture.ts      — session_start capture of modelRegistry/uiContext/model, borrowed for per-child model resolution (replaced model-override's global pi.setModel flip).
lane-*.ts (14 modules)  — Lane UI: belowEditor dock (+dock-editor), /lanes switcher, self-windowing console, transcript replay live + disk-jsonl (lane-transcript*, lane-tool-defs renderer cache), progress/usage/streaming/failure, shared lane-list renderer, deferring relay-ui.
question-lifecycle.ts   — workflow-question lifecycle events from the registry via a Symbol.for global slot; workflow-question-warp-bridge.ts consumes them.
*-command.ts / models-* / skill-* — Registrars: setup, update-agents, models-config(+validate,+sources), models-picker, skill-bracket, skill-contracts-source (+outcome-derivation, artifact-collector), register-built-in-workflows (+built-in-workflows).
rpiv-models/            — Nested subdir for the /rpiv-models cascade picker: command.ts, index.ts, items.ts, overrides.ts.
built-ins/              — Extracted built-in-workflows helper clusters (markdown-fence.ts fence-scan, shared.ts structure-verdict + /runner StagePreflightError); barrel index.ts re-imported by built-in-workflows.ts.
*.ts (utilities)        — Primitive helpers: siblings, package-checks, paths, pi-installer, prune-legacy-siblings, bash-timeout, banner, constants, frontmatter, utils.
```
Pattern: each capability is a source module + co-located `<feature>.test.ts`.

## Detached Execution (launcher/observer)
`workflow-execution-host.ts` installs the executor provider on the ROOT launcher's `session_start` — gate: `if (!ctx.hasUI || isLaneRelayUiContext(ctx.ui)) return;` (workflow-execution-host.ts, `registerWorkflowExecutionHostProviderHook`) — so a detached child re-loading rpiv-core can never overwrite the process-global provider box. Per-unit models are resolved through the captured registry and applied at child-session creation, never via a global `pi.setModel()` flip. Each child's `ask_user_question` binds the deferring lane-relay UI: questions queue + badge in the lane dock, and the switcher replays them on switch-in. Child bash commands run under a watchdog (`bash-timeout.ts`): 3-minute default, overridable via `RPIV_BASH_TIMEOUT_MS`, clamped to 5 s–30 min. The watchdog now also exposes a recovery twin on the workflow-execution host port: `resetToolTimeout` (beside `toolTimeout`) calls `watchdog.reset()` so a resumed turn's new bash call re-arms a fresh timer on the same handle, and `readSessionBranch` (backed by `SessionManager.open(file).getBranch()`, fail-soft) feeds `rpiv-workflow`'s death-scene artifact writer the failed session's transcript without a live re-query. Cross-module state lives on `globalThis[Symbol.for("@juicesharp/rpiv-pi:…")]` slots, never module-level variables — `session-capture.ts` and `lane-tool-defs.ts` are the two documented exemptions (deliberately plain module-level state).

## Architectural Boundaries
- **Editing `built-in-workflows.ts` requires the workflow-invariant check**: after any change to it, run `node packages/rpiv-pi/skills/elaborate/_helpers/validate-workflow-invariant.mjs` — it re-derives the live built-in workflows + skill contracts and surfaces `route-reads-unvalidated-data` (and other) validation issues before they ship. This is the project-specific invariant check the `elaborate`/`implement` self-check protocol asks the guidance to name.
- **NO business logic in the composer**: orchestration only — every capability owns its own registrar module
- **NO `ExtensionAPI` in pure-utility modules**: helpers (sibling registry, package checks, agent sync, installer, legacy pruner) take primitives only; the guidance engine takes `pi` explicitly
- **Sibling imports are guarded + optional only**: presence detection stays filesystem-based (regex over `~/.pi/agent/settings.json`). No file statically reachable from `index.ts` may value-import a sibling — enforced by `sibling-import-graph.test.ts`; runtime loads (`rpiv-workflow`, opt-in `rpiv-warp`) are guarded dynamic imports that degrade silently when absent
- **Hooks owning process-global state are root-gated + idempotent**: registered on the root launcher's `session_start`, skipped for detached children, safe under `/reload` — never in a module-load IIFE
- **NO tools registered here**: rpiv-core is a pure orchestrator — new tools belong in sibling plugins (registration pattern: `.rpiv/guidance/packages/rpiv-advisor/architecture.md`)

<important if="you are adding a new tool to this extension">
## Adding a New Tool
New tools do not belong in rpiv-core. Add the tool to a sibling plugin instead:
1. Add it to an existing sibling or create a new sibling plugin (see `.rpiv/guidance/architecture.md`)
2. Add one entry to `SIBLINGS` in `siblings.ts` — presence detection, missing-plugin warning, and `/rpiv-setup` all pick it up automatically
3. Pin the package in `rpiv-pi/package.json` `peerDependencies` as `"*"`
</important>

<important if="you are adding a new slash command to this extension">
## Adding a New Slash Command
1. Create a new registrar module exporting `registerMyCommand(pi: ExtensionAPI): void` — the composer is a thin wiring file with no inline handlers
2. Wire it from the composer with one call
3. Guard interactive operations: `if (!ctx.hasUI) { ctx.ui.notify("…", "error"); return; }`
4. User-facing strings live in the shared constants module or as named arrow-message helpers — no inline template literals in logic
5. Handler returns `void`; use `ctx.ui.notify` / `ctx.ui.input` / `ctx.ui.confirm` / `ctx.ui.custom<T>`
</important>

<important if="you are adding a new session lifecycle hook to this extension">
## Adding a Session Hook
1. Add the `pi.on("event_name", async (event, ctx) => { … })` line inside the owning registrar — `session-hooks.ts` for injection-style hooks, otherwise the feature's own module (seven registrars currently subscribe `session_start`)
2. Extract the handler body into a named helper in the same file — `pi.on` lines are pure wiring
3. Events used here: `session_start`, `session_compact`, `session_shutdown`, `tool_call`, `before_agent_start` (session-hooks); `input` + `agent_end` (skill-bracket). rpiv-core has no tool state to reconstruct, so branch-replay events are not subscribed
4. If the hook owns process-global state, root-gate it (`!ctx.hasUI || isLaneRelayUiContext(ctx.ui)` → return) and make it idempotent — every detached child re-loads rpiv-core
5. If the registrar dynamically imports `rpiv-workflow`, chain it after the others in the composer's sequential IIFE — concurrent imports race jiti's half-initialized barrel
6. `before_agent_start` can return `{ message: { customType, content, display: false } }` to inject a hidden LLM-only context message
7. `session_compact` MUST NOT call `pi.sendMessage`: auto-recovery treats those as queued steering items. Store only per-session identity state there, then merge any restored guidance/pointer/Git context into one `before_agent_start` return on the next real user turn
</important>

<important if="you are adding a new pure utility module to this extension">
## Adding a Utility Module
1. Create the module with no `ExtensionAPI` import
2. Every function returns a value or `void`; never throws — catch all errors and return a safe default
3. Resolve package paths via `import.meta.url` + `fileURLToPath` — never `__dirname`
4. Co-locate the test next to the source
</important>
