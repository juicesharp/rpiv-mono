# Configuration

Every setting `rpiv-voice` persists, where the file lives, how it is written, and which
parts of the overlay are deliberately not configurable.

## The config file

`rpiv-voice` runs with no config file at all. When you change a setting, it writes
`voice.json` under an XDG-aware config directory:

| `XDG_CONFIG_HOME` | Config file |
| --- | --- |
| unset, empty, or whitespace-only | `~/.config/rpiv-voice/voice.json` |
| an absolute path | `$XDG_CONFIG_HOME/rpiv-voice/voice.json` |
| `~` or `~/…` | tilde-expanded, then used as above |
| a relative path, or `~user/…` | ignored — falls back to `~/.config/rpiv-voice/voice.json` |

Reads have a one-way legacy fallback: if the XDG-resolved file does not exist, the loader
also looks at `~/.config/rpiv-voice/voice.json` regardless of `XDG_CONFIG_HOME`, so a
config written before you set the variable is still picked up. If the XDG file *does*
exist but is malformed, that result wins and there is no fallback — corruption is
surfaced, not masked.

Writes only ever go to the XDG-resolved path.

`XDG_CONFIG_HOME` is the only environment variable this package reads. It relocates
`voice.json` and nothing else — not the error log, not the model directory.

## Keys

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `hallucinationFilterEnabled` | boolean | `true` | Drops Whisper's silence artifacts and repetition loops. Turn it off when you are dictating single words the filter might mistake for noise |
| `equalizerEnabled` | boolean | `false` | Renders the live audio waveform lattice under the transcript |

There are no other keys. A hand-written file looks like this:

```json
{
  "hallucinationFilterEnabled": false,
  "equalizerEnabled": true
}
```

Only non-default values are persisted — the filter key lands on disk only when it is
`false`, the equalizer key only when it is `true`. A default-settings install therefore
writes `{}`, and an absent key always means "the default", never "unset".

## The settings screen

`Tab` from dictation opens a four-row panel:

| Row | Kind | Value |
| --- | --- | --- |
| Microphone | read-only | `System default input` |
| Language | read-only | the endonym of your active locale (`Deutsch`, `Русский`, `中文`, …) or `Auto-detect`. Hint: `Run /languages to change.` |
| Filter Whisper noise | toggle | `[ on ]` / `[ off ]` — writes `hallucinationFilterEnabled` |
| Equalizer | toggle | `[ on ]` / `[ off ]` — writes `equalizerEnabled` |

Only the two toggles take focus. `Ctrl-S` saves and confirms; `Esc` and `Tab` save
silently on the way out. See [keybindings.md](./keybindings.md) for the full key table.

The filter toggle takes effect immediately in the running session. The equalizer toggle
is view-only and appears under the transcript as soon as you flip back.

## File handling

The config file is written with mode `0600` — readable and writable by you only. The
`chmod` is best-effort: filesystems that ignore permissions (tmpfs, network mounts,
Windows) do not fail the save. Parent directories are created as needed.

Loading is crash-resistant. A missing file, malformed JSON, or JSON that is not a plain
object (an array, a number, a string, `null`) all resolve to defaults. Malformed JSON
additionally prints a one-line warning naming the path.

Saving is not silently optimistic: if the write fails, the overlay tells you
`Failed to save voice settings — change not persisted` instead of claiming success.

## Diagnostic log

Recognition failures and microphone-path breadcrumbs append to:

```
~/.config/rpiv-voice/errors.log
```

That path is hardcoded — unlike `voice.json`, it does **not** move when you set
`XDG_CONFIG_HOME`. One line per event, ISO timestamp first:

```
2026-03-04T09:12:44.118Z [stt.recognize] Error: <sherpa-onnx message>
2026-03-04T09:12:40.902Z [mic.path] resample-rms@48000Hz
```

| Scope | Meaning |
| --- | --- |
| `stt.recognize` | A final segment failed to decode. The transcript skips it |
| `stt.recognize.partial` | A rolling partial decode failed. Harmless — the next one retries |
| `mic.path` | Which capture strategy won at startup, and why the first one was refused |

Writes to this log are best-effort and never throw. The dictation pipeline cannot write
to stderr without corrupting the live TUI render, so the file is the only breadcrumb
trail — check it first when a phrase silently fails to transcribe.

## What is not configurable

- **Microphone.** `/voice` uses the OS default input device. There is no device picker
  and no config key for one.
- **Model.** The bundled Whisper base multilingual int8 model is the only option; the
  file names are fixed. See [model.md](./model.md).
- **Recognition language.** It is derived from your active i18n locale at the moment
  `/voice` starts, and is fixed for that session — see below.
- **Command flags.** `/voice` ignores any arguments you type after it.

## How the recognition language is chosen

When `@juicesharp/rpiv-i18n` is installed and your active locale's base code is one of
`de`, `en`, `es`, `fr`, `it`, `ja`, `pt`, `ru`, `uk`, `zh`, the engine is built with that
language as a fixed hint. This is more accurate than auto-detection and skips the
first-utterance detection delay, but it also means the language is baked in for the
session: switching locale mid-session does not re-target recognition. Exit the overlay
and run `/voice` again.

With no locale active, or a locale outside that list, the engine falls back to Whisper's
built-in per-utterance auto-detect across the full multilingual model.
