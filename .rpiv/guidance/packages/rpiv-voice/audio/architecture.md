# rpiv-voice / audio

## Responsibility
The only ML/native-binding layer in the monorepo: owns mic capture, Int16↔Float32 PCM conversion, the Whisper recognizer wrapper, tarball-based model provisioning under `~/.pi/models/`, post-hoc hallucination filtering, and an append-only error sink.

## Dependencies
- **`sherpa-onnx-node@1.13.0`** (CJS, no upstream `.d.ts`): synchronous `OfflineRecognizer`. CamelCase TS keys; binding translates to C-struct snake_case
- **`decibri`** (CJS): Node `EventEmitter`-shaped object; emits `data` (Int16 LE `Buffer`), `speech`/`silence`/`end`/`error`/`close`; built-in Silero VAD
- **Node stdlib**: `node:fetch` + `node:stream/promises.pipeline` for download, `execFile("tar", …)` for extraction (no JS tar dep)

## Inbound / Outbound
- **Outbound**: `decibri`, `sherpa-onnx-node`, `node:*`, `../state/i18n-bridge.js` (only in `model-download.ts`, for splash strings)
- **Inbound**: `command/voice-command.ts` and `command/pipeline-runner.ts` (+ tests). No reach-in from view/, state/, agents, or web packages.

## Module Structure
```
# capture + DSP
mic-source.ts          — Mic factory; produces the Whisper-interop PCM stream with built-in VAD
pcm.ts                 — Pure PCM math (Int16↔Float32, RMS); no side effects, no native calls
resampler.ts           — Int16LinearResampler (streaming linear-interp); used by mic-source ResamplingRmsAdapter
# recognition + provisioning
stt-engine.ts          — Recognizer wrapper exposing `{ recognize, release }`; one stream per utterance
model-download.ts      — Sentinel-based installer; any install failure recursively wipes the model dir
hallucination-filter.ts — Normalized phrase set + repetition-loop detector
# infra
error-log.ts           — Append-only file sink; never throws (stderr would corrupt the TUI)
sherpa-onnx-node.d.ts  — Ambient module decl (upstream ships no `.d.ts`)
```

## Mic Source Contract (push-based, no backpressure)
PCM output is **16 kHz mono Int16** — the Whisper input interop contract; any deviation breaks recognition. Mic is event-driven (`data` / `speech` / `silence` / `end` / `error`); the audio layer never polls. `stop()` is the only teardown, emits `"end"` once.

## STT Engine Lifecycle (one stream per utterance)
Recognition is per-utterance: a fresh stream is opened, samples are decoded, the stream is released. The native handle has no destructor — `release()` is a stable-contract no-op kept so callers can write symmetric setup/teardown. Sample-rate must match the mic-source contract.

## Model-Download Caching
Install completion is **sentinel-file gated**, not size- or hash-based, so a partial extraction surfaces as not-installed on the next launch. Re-verification on every cold start catches manual deletes; failures are tagged with a `ModelInstallError.stage` discriminant so the splash UI can localize. Any failure during install recursively wipes the model directory — the install is all-or-nothing.

## Hallucination Filter
A three-stage post-decode gate (normalize-empty drop → curated-phrase set → repetition-loop scan) sits between the recognizer and the transcript. Filter rules are data, not architecture: phrase set and repetition thresholds are tuned implementation. The architectural rule is: **filtering happens at the boundary between `recognize()` and the transcript**, never inside the recognizer or the view.

## Error-Log Sink (TUI-safe)
Every audio-layer error path is funnelled through an append-only file sink. The sink **never throws** — `stderr` writes would corrupt the TUI render, so failure of the sink itself is silently swallowed.

## Native Binding Caveats
- **CJS-via-ESM**: native bindings are dynamic-imported with `.default`/namespace fallback so the package builds identically under ESM and CJS resolution
- **Hand-written `.d.ts`**: upstream ships no types, so the binding's TS shape is owned in this layer and must be kept in sync when sherpa-onnx-node updates
- **No native destructor**: the recognizer's `release()` is a stable-contract no-op (kept so callers can write symmetric setup/teardown)
- **Decoder padding** is the only Whisper knob this layer exposes — it mitigates EOS miss on short clips; specific value is tuned implementation
