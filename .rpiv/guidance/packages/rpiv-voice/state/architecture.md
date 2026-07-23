# rpiv-voice / state

## Responsibility
Canonical state for the voice extension: `VoiceState` shape, pure `reduce(state, action, ctx) → { state, Effect[] }`, key-router (keystroke → action), the `VoiceSession` imperative shell that runs effects against real IO, plus the i18n bridge. Overlay-scoped — no replay/reconstruction layer.

## Dependencies
- **`../config/voice-config.js`** (`VoiceConfig`, `isHallucinationFilterEnabled`, `isEqualizerEnabled`, `saveVoiceConfig`)
- **`@juicesharp/rpiv-i18n`** (optional, dynamic-imported in `i18n-bridge.ts`)
- **`@earendil-works/pi-tui`** (`Key`, `matchesKey`, `getKeybindings`)
- **`@earendil-works/pi-coding-agent`** (`Theme`, `DynamicBorder`)
- **Consumers**: `../command/voice-command.ts` instantiates `VoiceSession`; `../view/*` reads via bindings; `./selectors/projections.ts` projects state to view props

## Module Structure
```
# core state machine
state.ts             — VoiceState shape, RecordingStatus, ScreenKind, SettingsDraft, SETTINGS_FIELD_ORDER, initialVoiceState
state-reducer.ts     — Effect union, reduce(), HANDLERS table, configFromDraft / draftFromConfig
key-router.ts        — VoiceAction union + routeKey(data, state, runtime) (pure key→action map)
# intent metadata tables
status-intent.ts     — STATUS_META: { glyph, glyphColorKey, label, gatesSttPipeline } per RecordingStatus
screen-intent.ts     — SCREEN_META: { label, footerHints: FooterHintKey[] } per ScreenKind
# shell + sub-layers
i18n-bridge.ts       — t(), getActiveLocale(), I18N_NAMESPACE (locales registered from index.ts, NOT here)
voice-session.ts     — Imperative shell: holds state, dispatch/dispatchAction, runs effects, owns view tree
selectors/           — Pure projections sub-layer (see .rpiv/guidance/packages/rpiv-voice/state/selectors/architecture.md)
```

## State Shape
```ts
interface VoiceState {
    currentScreen: "dictation" | "settings";
    status: "recording" | "paused";
    transcript: string;          // committed final-decode text
    partialTranscript: string;   // rolling re-decode of active utterance; replaced wholesale; cleared on final
    audioLevel: number;          // VU meter
    settingsDraft: { hallucinationFilterEnabled: boolean; equalizerEnabled: boolean };
    settingsFocus: "hallucination" | "equalizer";
}
```
No model field — the Whisper model is owned by `audio/`. No conversation/turn shape, no audio buffer state (raw PCM lives in audio/).

## Reducer Contract
```ts
type Effect =
    | { kind: "request_render" } | { kind: "paste_to_editor"; text: string }
    | { kind: "notify"; level: "error" | "info"; message: string }
    | { kind: "abort_session" } | { kind: "stop_mic" } | { kind: "set_pipeline_paused"; paused: boolean }
    | { kind: "set_hallucination_filter"; enabled: boolean }
    | { kind: "save_config"; config: VoiceConfig; successMessage?: string }
    | { kind: "done"; result: VoiceResult };

// ApplyContext = { persistedConfig: VoiceConfig }; ApplyResult = { state; effects }.
export function reduce(state: VoiceState, action: VoiceAction, ctx: ApplyContext): ApplyResult;
```

## HANDLERS Table (compiler-enforced exhaustive)
```ts
type Handler<K extends VoiceAction["kind"]> = (state: VoiceState, a: Extract<VoiceAction, { kind: K }>, ctx: ApplyContext) => ApplyResult;

const HANDLERS: { [K in VoiceAction["kind"]]: Handler<K> } = { /* one entry per VoiceAction kind */ };
```
The mapped type forces the table to cover **every** action variant — adding a kind without a handler fails the build. The `VoiceAction` union itself lives in `key-router.ts` and is the single source of truth for inputs into state.

## Status / Screen Intents (metadata, not actions)
Intent tables are the single source of truth for per-enum behavior — replaces scattered switch statements. `STATUS_META.gatesSttPipeline` is the only behavior flag (consumed by reducer to emit `set_pipeline_paused`); `SCREEN_META.footerHints` drives footer-hint rendering.

## i18n Bridge
Translation lookup is **soft-dependency**: the bridge dynamic-imports the i18n SDK at module init; if the SDK is absent, `t(key, fallback)` returns the fallback verbatim. Locale registration is **never** done from this layer — only the namespace constant is exported. `registerLocalesFromDir` lives at the extension entry so the bridge stays free of side effects.

## VoiceSession Shell
Owns the state cell, exposes `dispatch(data)` (keystroke) / `dispatchAction(action)` / `tickPulse()` / `component` (bound view tree). On each dispatch: route → reduce → run effects against injected `VoiceSessionDeps` (`pasteToEditor`, `notify`, `abort`, `stopMic`, `setPipelinePaused`, `setHallucinationFilterEnabled`); `save_config` calls `saveVoiceConfig` imported directly, and `done` is a separate `VoiceSessionConfig` callback. One session per `/voice` invocation; **no module singleton**, **no `__resetState`** (instance-scoped).

## Differences vs Sibling State Layers
- **rpiv-todo/state**: persistent — `replay.ts`, `invariants.ts`, `store.ts` singleton; designed for post-compaction reconstruction
- **rpiv-ask-user-question/state**: overlay-scoped like voice; key-router + row-intent + selectors but no replay
- **voice-specific**: dual `transcript`/`partialTranscript` (rolling-decode model), `audioLevel: number` for VU meter, `SettingsDraft` with auto-persist on `close_settings`, `gatesSttPipeline` flag wired through `set_pipeline_paused`
