# rpiv-voice / command

## Responsibility
Top-level orchestrator wiring the `/voice` Pi command to the audio pipeline, state machine, and TUI view. **Splash** is the preflight UI shown while the Whisper model downloads/extracts and STT engine + mic boot; **pipeline** is the long-running mic→STT→state event loop.

## Dependencies
- **`audio/`**: `createMic`, `DecibriLike`, `createSttEngine`, `ensureModelDownloaded`, `assertModelIntact`, `ModelInstallError`, `bufferToFloat32`, `computeRmsInt16/Float32`, `isHallucination`, `appendErrorLog`
- **`state/`**: `VoiceSession`, `VoiceResult`, `getActiveLocale`, `t`
- **`view/`**: `SplashView`, `SplashPhase`, `SPLASH_FRAMES`, `STATUS_BAR_PULSE_FRAME_INTERVAL_MS`
- **`config/`**: `loadVoiceConfig`, `isHallucinationFilterEnabled`
- **`@earendil-works/pi-coding-agent`** (types only): `ExtensionAPI`, `ExtensionCommandContext`. `pi-tui` reached transitively via `ctx.ui.custom(tui, theme, kb, done)`.

## Inbound / Outbound
- **Inbound**: `index.ts` calls `registerVoiceCommand(pi)` from the package default-export
- **Outbound**: `pi.registerCommand("voice", …)`, `ctx.ui.custom(...)`, `ctx.ui.notify(...)`, `ctx.ui.pasteToEditor(...)`

## Module Structure
```
voice-command.ts     — Registers /voice; preflight + paste glue + PreflightStage→i18n-key table + whisperLanguageForLocale
pipeline-runner.ts   — Event-driven mic→STT loop with single-flight partial decode and segment cap
splash-runner.ts     — Reusable inline ctx.ui.custom render that drives SplashView while async work runs
```

## Command Registration

```ts
export function registerVoiceCommand(pi: ExtensionAPI): void {
    pi.registerCommand(VOICE_COMMAND_NAME, {
        description: t("command.description", "Dictate text with your voice — local STT, no cloud"),
        handler: (_args, ctx) => handleVoiceCommand(ctx),  // ctx.hasUI guard inside
    });
}
```

## Pipeline (event-driven, not a loop)
The pipeline is **event-driven** — mic events drive both state-dispatch (for the VU meter) and a speech buffer that flushes on silence or a soft segment cap. Key invariants:
- **Finals serialize** via a single `recognizing` promise chain; **partials run outside** that chain so a stale partial cannot paint after a commit
- **RMS gate + hallucination filter** sit at the segment boundary; thresholds and the filter toggle are tuning, not contract
- **Termination is deterministic** — either mic-end/error or signal-abort drains the buffer and resolves the final-transcript promise; no race with in-flight recognitions
- **Pipeline never reads state directly** — decisions arrive via setter deps (`setPaused`, `setHallucinationFilterEnabled`) wired through `VoiceSession`

## Splash (sequential before pipeline)
The splash is an **inline replacement** for the editor (not a bottom overlay) shown via `ctx.ui.custom`. It drives `SplashView` while async preflight work runs, then closes. Errors during preflight are captured and rethrown only **after** the splash unmounts, so the failure UI replaces the splash cleanly instead of overlapping it.

## Dispatched Actions
The pipeline → state surface is intentionally narrow: a frame-level chunk action, a rolling-partial setter, and a committed-segment appender. No other audio-layer concerns leak into the reducer.

## Cancellation
One `AbortController` per `/voice` invocation owns the lifecycle: abort flows through to mic-stop, recognizer cleanup, and view tear-down — no orphan timers or in-flight recognitions survive command exit.
