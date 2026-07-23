# @juicesharp/rpiv-voice

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-voice.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-voice)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-voice">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-voice/docs/cover.png" alt="rpiv-voice cover: a mocked /voice overlay showing a live transcript, an equalizer strip, and the status row" width="50%">
    </picture>
  </a>
</div>

Dictate long prompts to [Pi Agent](https://github.com/badlogic/pi-mono) instead of typing
them. `rpiv-voice` adds a `/voice` command: an overlay opens, you speak, you press
`Enter`, and the transcript drops into Pi's editor. Speech-to-text runs on your own CPU
through sherpa-onnx Whisper (base multilingual int8) — no cloud, no API key, no account.

## Install

```sh
pi install npm:@juicesharp/rpiv-voice
```

Restart your Pi session.

## Quick start

Type `/voice`. The first run downloads the Whisper model (~198 MB, ~157 MB on disk) into
`~/.pi/models/whisper-base/` with a progress splash; later runs open in about a second.

Then talk. Committed text appears as you finish phrases, with a dim trailing partial for
the sentence you are still speaking.

![The /voice overlay above the Pi prompt: a committed transcript line, a teal divider, and the status row reading 0:14 with the Enter, Space, Tab and Esc hints](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-voice/docs/overlay.jpg)

| Key | Action |
| --- | --- |
| `Enter` | Close the overlay and paste the transcript — committed text plus the dim partial |
| `Esc` | Close the overlay and paste nothing |
| `Space` | Pause / resume |
| `Tab` | Open the settings screen |

If you have remapped Pi's confirm/cancel keys, the overlay follows your remap.

## What you get

- **Audio never leaves your machine** — the only network call in the package is the
  one-time model download from GitHub Releases. Decoding runs locally on the CPU. No API
  key, no account, no telemetry.
- **You see the words before you commit them** — the still-open utterance is re-decoded
  about once a second and rendered dim after the committed text, and `Enter` pastes both.
  You never wait on a final decode.
- **Long monologues stay responsive** — pauses flush a segment, and a cap keeps a
  non-stop stretch from stalling the transcript.
- **Built-in microphones work, not just headsets** — capture falls back to the device's
  native sample rate when 16 kHz is refused.
- **Whisper's silence hallucinations get filtered** — a curated phrase set
  ("thanks for watching", "music", "applause", and non-English equivalents), a
  repetition-loop detector, and an input-side energy floor. Toggle it off when you are
  dictating single words.
- **Localized UI in nine languages** — `de`, `en`, `es`, `fr`, `pt`, `pt-BR`, `ru`, `uk`,
  `zh`. With [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  installed, `/languages` flips the overlay strings without a restart; without it the
  extension still loads, English-only.

## Configuration

`/voice` needs no config file. Both settings are editable on the settings screen (`Tab`
from dictation, `Ctrl-S` to save, `Esc` to save silently and go back) and persist to
`~/.config/rpiv-voice/voice.json`:

| Key | Default | Effect |
| --- | --- | --- |
| `hallucinationFilterEnabled` | `true` | Drops Whisper's silence artifacts and repetition loops |
| `equalizerEnabled` | `false` | Renders the live audio waveform under the transcript |

The file is written with mode `0600`.

The microphone is the OS default input and the model is fixed — neither is selectable.

## Reference

- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-voice/docs/configuration.md) — every key, the XDG path rules, file permissions, the diagnostic log, and how the recognition language is chosen.
- [Keys and screens](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-voice/docs/keybindings.md) — the full key table for both screens, the remappable bindings, and exactly what `Enter` pastes and `Space` pauses.
- [Model install and platform support](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-voice/docs/model.md) — the first-run pipeline, the files on disk, failure recovery, and the prebuilt-binary matrix.

## Requirements

- **Apple Silicon macOS, glibc Linux (x64 / arm64), or Windows x64.** Intel Macs are not
  supported: the `decibri` capture library publishes no `darwin-x64` binary. Alpine/musl
  is out for the same reason.
- **A microphone Pi is allowed to use.** On macOS, grant your terminal microphone access
  under System Settings → Privacy & Security → Microphone.
- **`tar` with bzip2 support on `PATH`** — model extraction shells out to `tar -xjf`.
- **~650 MB free** during the first run — the archive and the unused fp32 weights are
  only deleted after extraction finishes. Settles at ~157 MB.
- **Network access on the first run only.** After that, `/voice` is fully offline.

## Troubleshooting

- **`Microphone unavailable…` error notification** — the OS refused the input device.
  Grant your terminal microphone permission, confirm an input device is connected, then
  re-run `/voice`.
- **`/voice requires interactive mode`** — the command draws a TUI overlay and does
  nothing in a non-interactive session. Run `/voice` from an interactive Pi session.
- **The transcript says "Thanks for watching"** — Whisper hallucinated on near-silence.
  Speak closer to the microphone, and leave `hallucinationFilterEnabled` on.
- **A phrase silently failed to transcribe** — recognition errors are appended to
  `~/.config/rpiv-voice/errors.log` rather than printed, because stderr would corrupt the
  live overlay. Check there for the underlying sherpa-onnx error.
- **`/voice` is not found** — restart your Pi session after installing.
- **`STT model files were removed or corrupted…`** — the install directory was damaged
  after a good download. It is wiped automatically; run `/voice` again to redownload.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) —
  optional. Install it with `pi install npm:@juicesharp/rpiv-i18n` to localize the
  overlay and enable `/languages`.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — the
  umbrella package and `/rpiv-setup`. It does not install `rpiv-voice`; this package is
  opt-in and installed explicitly.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-voice/LICENSE).
