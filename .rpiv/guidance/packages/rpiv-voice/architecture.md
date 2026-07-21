# rpiv-voice

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family. **Opt-in sibling** — installed explicitly, absent from the registry (not in `siblings.ts`, not peer-pinned by `rpiv-pi`). Only package in the monorepo that owns native bindings (sherpa-onnx-node) + mic capture.

## Responsibility
Registers a single `/voice` slash command: captures mic audio via `decibri`, runs local Whisper STT via `sherpa-onnx-node`, renders a live transcript/equalizer overlay, and pastes the committed text into the editor. Local-only; no cloud.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`, `ExtensionCommandContext` (`ctx.ui.custom`, `ctx.ui.notify`, `ctx.ui.pasteToEditor`, `ctx.hasUI`)
- **`@earendil-works/pi-tui`** (peer): `Container`, width-correct helpers, key matching
- **`@juicesharp/rpiv-i18n`** (optional peer): dynamic-imported in `index.ts` + `state/i18n-bridge.ts`; package runs standalone if absent
- **`@juicesharp/rpiv-config`** (runtime): `configPath`, `loadJsonConfigWithLegacyFallback`, `saveJsonConfig` — sole importer is `config/voice-config.ts`
- **`sherpa-onnx-node`** (runtime): Whisper int8 ONNX recognizer; no upstream `.d.ts` (`audio/sherpa-onnx-node.d.ts` is an ambient mirror)
- **`decibri`** (runtime): EventEmitter-shaped mic with built-in Silero VAD

## Module Structure
```
.                  — Pi entry (index.ts): top-level await registers locales from dir, default export wires registerVoiceCommand(pi)
audio/             — Mic capture + STT + model installer + hallucination filter + error log (only native/ML layer)
command/           — /voice orchestrator: voice-command (preflight→pipeline→paste), splash-runner, pipeline-runner (mic→STT loop)
config/            — Persisted user-config (0600, XDG read + one-way legacy fallback); no cache — every load re-reads disk; `__resetState` test hook
state/             — Canonical VoiceState + pure reducer + key-router + voice-session shell + i18n-bridge. selectors/ is a sub-layer
view/              — Overlay chrome + StatefulView<P> contract + props-adapter + screen-content-strategy. components/ is a sub-layer
locales/           — JSON translation maps loaded once at module init
```

## Pi Extension Entry (`index.ts`)

```ts
// Top-level await: locale registration MUST happen before default export runs.
// `/loader` subpath avoids pulling i18n-ui + pi-tui into the load graph.
try {
    const sdk = await import("@juicesharp/rpiv-i18n/loader");
    sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-voice" });
} catch { /* SDK absent — t(key, fallback) returns English fallback */ }

export default function (pi: ExtensionAPI): void {
    registerVoiceCommand(pi);  // single registration; no tools, no session hooks
}
```
`registerLocalesFromDir` iterates the SDK's `SUPPORTED_LOCALES` — there is no `registerStrings` call and no `loadLocale` helper; adding a locale needs no edit here.

## Command Flow (`/voice` → paste)

1. `pi.registerCommand("voice", { handler: (_args, ctx) => handleVoiceCommand(ctx) })`
2. `runPreflight` → `runWithSplash` mounts `SplashView` while downloading the model, booting STT engine, opening mic
3. `runDictationSession` opens `ctx.ui.custom`, constructs `VoiceSession` (owns state + reducer), and starts `startDictationPipeline`
4. Mic events (`data`/`silence`/`end`/`error`) → `session.dispatchAction({ kind: "audio_chunk" | "audio_partial_transcript_set" | "audio_transcript_appended" })`
5. On commit: `done(VoiceResult)` resolves; caller checks `result.intent === "commit"` and `ctx.ui.pasteToEditor(text)`

## Module-Level State
`config/voice-config.ts` declares a `globalThis[Symbol.for("rpiv-voice")]` key with an exported `__resetState` wired into `test/setup.ts` `beforeEach` — but nothing ever writes to that cell; it is reset scaffolding, **not a config cache**. There is no cache at all: `loadVoiceConfig()` re-reads disk on every call. `VoiceSession` is **not** a module singleton — one per `/voice` invocation; the only real module-level state is the i18n-bridge's scope impl (intentionally not reset — no test relevance). Reads go through `loadJsonConfigWithLegacyFallback("rpiv-voice", "voice.json")` — `XDG_CONFIG_HOME` preferred, the legacy location read only when the XDG file is absent; writes are XDG-only via `configPath` (`config/voice-config.ts:44-49`).

## Architectural Boundaries
- **`audio/` never reads canonical state** — pipeline-runner pushes deps in via `setPaused`/`setHallucinationFilterEnabled` setters
- **i18n at render time, never module top-level** — `t(key, fallback)` is invoked inside `description`/render paths (`i18n-bridge.ts:17-19`)
- **All SDK imports are soft** — every cross-package consumer wraps `await import("@juicesharp/rpiv-…")` in try/catch
- **PreflightStage tagging** — `PreflightError` throws carry a `PreflightStage` string-literal union; user-facing messages branch on stage, with a generic fallback for non-`PreflightError` throws
- **No invariants.ts / replay.ts** — voice is overlay-scoped, not persisted; no post-compaction reconstruction

<important if="you are adding a new voice command or screen">
## Adding a Command / Screen
1. **New command**: add `command/<name>-command.ts` exporting `register<Name>Command(pi)`; call it from `index.ts`'s default export
2. **New screen**: add `view/components/<name>-view.ts` implementing `StatefulView<P>` (`setProps`, `render(w)`, `invalidate`/`handleInput` no-ops are fine)
3. Add a projection in `state/selectors/projections.ts` (see `.rpiv/guidance/packages/rpiv-voice/state/selectors/architecture.md`)
4. Register a `globalBinding({ component, select, predicate? })` in the screen wiring — never call `setProps` outside the adapter
5. Add a `ScreenKind` entry in `state/state.ts` + a `SCREEN_META` row in `state/screen-intent.ts` (footer hints) and route via `view/screen-content-strategy.ts` + `state/key-router.ts`
6. **New locale**: drop `locales/<code>.json` mirroring `en.json` keys — no `index.ts` edit needed (`registerLocalesFromDir` iterates the SDK's `SUPPORTED_LOCALES`)
</important>
