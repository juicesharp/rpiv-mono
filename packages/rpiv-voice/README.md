# rpiv-voice

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-voice">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-voice/docs/cover.png" alt="rpiv-voice cover" width="50%">
    </picture>
  </a>
</div>

Talk to [Pi Agent](https://github.com/badlogic/pi-mono) instead of typing. `rpiv-voice` adds the `/voice` slash command — open the overlay, speak, hit `Enter`, and your transcript drops straight into Pi's editor. Speech-to-text runs **entirely on your machine** via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Whisper (base multilingual int8). No cloud, no API keys, no telemetry.

![Voice dictation overlay above the Pi editor](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-voice/docs/overlay.jpg)

## Features

- **100% on-device** — audio never leaves your laptop. No accounts, no API keys, no network calls after the first model download.
- **~99 languages, autodetected** — Whisper base multilingual handles the full Whisper language set with per-utterance autodetection. Switch languages mid-session without changing settings.
- **Live transcript** — committed lines render as you finish phrases, with a dim rolling partial showing the still-active utterance in real time. What you see is what gets pasted (no waiting for a "proper" final).
- **VAD-driven chunking** — Silero voice-activity detection breaks long monologues at natural pauses, so latency stays bounded even on a 5-minute rant.
- **Settings screen built-in** — `Tab` flips to a settings panel showing your active mic, detected language, and a hallucination filter toggle. `Ctrl-S` to save, `Esc` or `Tab` to return to dictation.
- **Whisper hallucination filter** — strips spurious "Thanks for watching", "[Music]", and repeating-token loops that Whisper sometimes emits on silence. Toggle off if you're dictating short single words.
- **Pause / resume** — hit `Space` to mute the mic without closing the overlay; great for stepping aside mid-thought.
- **Localized UI** — overlay, status bar, and settings render in German, English, Spanish, French, Portuguese (European + Brazilian), Russian, and Ukrainian when [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) is installed. Falls back to English when it isn't.
- **Honest first-run UX** — the splash overlay shows download progress (percent + bytes), then `Extracting…`, `Verifying…`, `Loading engine…`, `Initializing mic…` before the dictation overlay opens. Half-loaded states never reach you.
- **Configurable cancel keybinding** — bind cancel to whatever your fingers prefer; no longer hardcoded to `Esc`.
- **Errors persisted, not swallowed** — recognition failures land in `~/.config/rpiv-voice/errors.log` so you can see why a phrase didn't transcribe.

## Install

`rpiv-voice` is **opt-in** — it's not part of `/rpiv-setup` because the native deps (sherpa-onnx, decibri) are heavyweight. Install it directly:

```sh
pi install npm:@juicesharp/rpiv-voice
```

Then restart your Pi session.

### Optional: localized UI

Install `@juicesharp/rpiv-i18n` alongside it to flip the overlay, status bar, and settings strings to your active locale:

```sh
pi install npm:@juicesharp/rpiv-i18n
```

`/languages` switches the locale live — no restart.

## Usage

Type `/voice` in Pi's input — the overlay opens with a recording glyph, a session timer, and `Listening…`.

| Key | Action |
|---|---|
| *(speak)* | Equalizer animates; transcript fills in live as Whisper decodes |
| `Enter` | Close overlay, paste transcript into the Pi editor |
| `Esc` | Close overlay, paste nothing (configurable — see below) |
| `Space` | Pause / resume the mic |
| `Tab` | Flip between dictation and settings screens |
| `Ctrl-S` *(in Settings)* | Save settings to disk |

The dim trailing text after the committed transcript is the rolling partial — it's already part of what will paste, so you can hit `Enter` the moment you're done.

### First run

The first time you run `/voice`, the splash overlay downloads the Whisper base multilingual model (~198 MB compressed, ~157 MB on disk) into `~/.pi/models/whisper-base/`. Subsequent runs load directly from disk in under a second. If a previous download was interrupted, the stale model directory is detected and re-downloaded automatically.

## Configuration

`rpiv-voice` works without any config file. To customize, drop a JSON file at `~/.config/rpiv-voice/voice.json`:

```json
{
  "hallucinationFilterEnabled": false
}
```

| Field | Default | Effect |
|---|---|---|
| `hallucinationFilterEnabled` | `true` | When `false`, keeps Whisper's "Thanks for watching" / "[Music]" / repeating-token loops. Useful when dictating short single words that the filter might mistake for noise. |

You can also flip the toggle interactively from the **Settings** screen (`Tab` from dictation, `Ctrl-S` to save).

The microphone is the OS default input — `rpiv-voice` does not expose device selection. The bundled Whisper base multilingual model is loaded from `~/.pi/models/whisper-base/`; alternative models aren't supported today.

## Privacy

- **No cloud STT.** Audio is decoded on your CPU via sherpa-onnx; nothing leaves the machine.
- **No telemetry.** No usage events, no crash reports, no install pings. Errors are written to a local log only.
- **No API keys.** Nothing to provision, nothing to revoke.
- **Network only on first run** — to download the model. After that, `/voice` works offline.

## Requirements

- [Pi Agent CLI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- A working microphone reachable by [`decibri`](https://www.npmjs.com/package/decibri) (mic permission granted to your terminal on macOS)
- ~200 MB free disk under `~/.pi/models/whisper-base/`
- Network access on first run only

## Troubleshooting

- **"Microphone init failed"** on the splash — grant your terminal app microphone access (System Settings → Privacy & Security → Microphone on macOS), then re-run `/voice`.
- **Transcript looks like "Thanks for watching"** — Whisper hallucinated on near-silence; either speak louder/closer, or leave the hallucination filter on (the default).
- **`/voice` not found** — restart your Pi session after install. If it's still missing, confirm the entry exists in `~/.pi/agent/settings.json`.
- **Recognition errors** — check `~/.config/rpiv-voice/errors.log` for the underlying sherpa-onnx error.

## Related packages

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) — localizes the `/voice` overlay UI.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — umbrella + `/rpiv-setup` for the rest of the `rpiv-*` family.

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-voice.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-voice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT — see [LICENSE](./LICENSE).
