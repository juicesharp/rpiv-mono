# Model install and platform support

What the first `/voice` downloads, where it puts it, what your machine needs for that to
work, and how a broken install recovers.

## First run

The first time you run `/voice`, a splash overlay walks through the install before the
dictation screen opens:

| Phase | What you see |
| --- | --- |
| Download | `Downloading Whisper… 43% (85.2 MB / 198.1 MB)` — percent and byte counter, or a bare byte counter if the server sends no `Content-Length` |
| Extract | `Extracting model files…` |
| Verify | `Verifying model files…` |
| Load | `Loading speech model…` |
| Microphone | `Initializing microphone…` |

Every later run skips straight to `Loading speech model…`.

## What gets downloaded

One archive, from the sherpa-onnx project's GitHub release assets:

```
https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2
```

This is the only outbound request the package makes. There is no telemetry, no analytics,
and no other network call anywhere in the code. After the model is on disk, `/voice`
works fully offline.

## Where it lands

```
~/.pi/models/whisper-base/
├── base-encoder.int8.onnx
├── base-decoder.int8.onnx
├── base-tokens.txt
└── .download-complete
```

That path is hardcoded. `XDG_CONFIG_HOME` and `PI_CODING_AGENT_DIR` do not move it.

The upstream archive ships fp32 and int8 weights side by side. `/voice` runs int8 on the
CPU, so `base-encoder.onnx` and `base-decoder.onnx` are deleted right after extraction.
The archive itself is deleted too.

| Measurement | Size |
| --- | --- |
| Archive on the wire | ~198 MB |
| On disk after pruning | ~157 MB |

Peak transient usage is far higher than the final figure. The archive is deleted only
after extraction finishes, and the fp32 weights are pruned only after that — so at the
peak the archive (~198 MB), the fp32 pair (~290 MB) and the int8 pair (~155 MB) all sit
in the directory at once. Budget ~650 MB of free space for the first run.

`.download-complete` is the sentinel: its presence is what makes later runs skip the
download entirely.

## Recovery from a broken install

The download, extract and verify stages report distinct failures rather than collapsing
into one message:

| Failure | Message |
| --- | --- |
| Fetch or HTTP error | `Failed to download STT model. Check your internet connection.` |
| `tar` failed | `Downloaded STT model archive is corrupt. Please retry.` |
| A required file is missing after extract | `STT model files are incomplete after download. Please retry.` |
| A required file disappeared after a previously good install | `STT model files were removed or corrupted. They will be redownloaded on next launch.` |
| The recognizer refused to load | `Failed to load STT model.` |

Any install failure wipes `~/.pi/models/whisper-base/` before surfacing, so a retry always
starts from a clean slate rather than resuming a half-extracted directory.

The sentinel only proves a *past* run finished. Before loading the engine, `/voice`
re-checks that the three required files still exist — if something deleted one of them,
the directory is wiped and the next launch redownloads, instead of crashing inside the
native recognizer.

## System requirements

**`tar` with bzip2 support.** Extraction shells out to
`tar -xjf <archive> -C <dir> --strip-components=1`. You need a `tar` on `PATH` that
supports `-j` and GNU-style `--strip-components`. There is no JavaScript fallback. The
system `tar` on macOS, mainstream Linux distributions and Windows 10+ qualifies.

**A microphone the OS will hand to your terminal.** On macOS that means granting your
terminal application microphone access under System Settings → Privacy & Security →
Microphone. Without it, preflight stops at
`Microphone unavailable. Check that an input device is connected and that Pi has
microphone permission.`

**An interactive Pi session.** `/voice` draws a TUI overlay; in a non-interactive context
it reports `/voice requires interactive mode` and exits.

## Platforms

Both native dependencies ship prebuilt binaries. The intersection is what actually runs:

| Platform | `sherpa-onnx-node` | `decibri` | `/voice` |
| --- | --- | --- | --- |
| macOS Apple Silicon (arm64) | yes | yes | yes |
| macOS Intel (x64) | yes | **no** | no |
| Linux x64, glibc | yes | yes | yes |
| Linux arm64, glibc | yes | yes | yes |
| Linux musl (Alpine) | no | no | no |
| Windows x64 | yes | yes | yes |
| Windows ia32 | yes | no | no |

The gap that catches people is Intel Macs: `decibri` publishes no `darwin-x64` binary, so
microphone capture has nothing to load there even though the speech engine would run.

Linux builds link against glibc — there is no musl variant, so Alpine-based images are
out.

`decibri` requires Node 18 or newer.

## Microphone capture strategies

Capture is negotiated at startup, and which strategy won is recorded in
`~/.config/rpiv-voice/errors.log` under the `mic.path` scope:

1. **`silero-passthrough@16000Hz`** — 16 kHz capture with decibri's bundled Silero VAD.
   Preferred: Silero's ML-based voice detection handles noisy rooms considerably better
   than an energy threshold. Works on USB headsets, AirPods and most external mics.
2. **`resample-rms@<rate>Hz`** — if the device refuses 16 kHz (macOS built-in
   microphones commonly do), capture reopens at the device's native rate — 48 kHz,
   then 44.1 kHz, then 96 kHz — resamples to 16 kHz in JavaScript, and substitutes an
   RMS-energy gate for Silero, which only accepts 8 or 16 kHz input.

Both strategies use a 500 ms hangover before declaring silence, which covers a natural
breath pause without flushing mid-clause. Segments are additionally force-flushed at a
12-second cap; the cut point is the lowest-energy chunk in the trailing 800 ms, so long
monologues split mid-breath rather than mid-syllable.
