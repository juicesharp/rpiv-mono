# @juicesharp/rpiv-config

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-config.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-config)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Shared JSON config I/O for the `@juicesharp/rpiv-*` packages — XDG-aware path resolution, loads
that return `{}` instead of throwing, saves that report failure and chmod to `0600`, and
TypeBox-driven defaults. It is an internal utility of the
[rpiv-mono](https://github.com/juicesharp/rpiv-mono) monorepo, published only so its sibling
packages can depend on it: there is no CLI, and it registers nothing with [Pi Agent](https://github.com/badlogic/pi-mono).

## Install

```sh
npm install @juicesharp/rpiv-config
```

ESM only. The package ships TypeScript source — `exports` points at `./index.ts`, with no
`main`, no `types`, and no compiled build — so you need a bundler or a TypeScript-aware runtime
(`tsx`, Bun). Plain `node` cannot load it, and `--experimental-strip-types` refuses `.ts` files under `node_modules`.

## Quick start

```ts
import { configPath, loadJsonConfig } from "@juicesharp/rpiv-config";

const path = configPath("rpiv-todo"); // ~/.config/rpiv-todo/config.json
const config = loadJsonConfig<{ theme?: string }>(path); // {} if the file is missing
```

## What it provides

Eleven exports, all stateless — no singletons, no caches, no import-time side effects.

| Export | What it does |
| --- | --- |
| `configPath(name, file?)` | Resolves `<config dir>/<name>/<file>`, defaulting to `~/.config/<name>/config.json`. An absolute `XDG_CONFIG_HOME` (or `~`/`~/…`) overrides the directory; anything else falls back. |
| `loadJsonConfig(path)` | Parses a JSON file. Returns `{}` for a missing file, a non-plain-object value, or malformed JSON (which also warns) — a hand-edited config cannot crash the caller. |
| `loadJsonConfigWithLegacyFallback(name, file?)` | Reads the XDG path; only when that file is absent does it read the pre-XDG `~/.config/<name>/<file>`. Corruption is surfaced, never masked by the legacy file. |
| `saveJsonConfig(path, data)` | `mkdir -p`, writes pretty JSON with a trailing newline, then chmods `0600` (best effort). Returns `true`/`false` instead of throwing — guard your "Saved" message on it. |
| `validateConfig(schema, value)` | Strips unknown keys, layers schema defaults underneath, and returns `{}` on any failure. |
| `validateGuidanceFields(fields)` | Keeps `promptSnippet` only if it is a non-empty string, and `promptGuidelines` only if it is a non-empty array of non-empty strings. Everything else is dropped. |
| `GuidanceFieldsSchema` | TypeBox object for the two guidance fields, with `additionalProperties: true` so consumers can nest it in a larger config schema. |
| `GuidanceFields` | Type for the same shape: `{ promptSnippet?: string; promptGuidelines?: string[] }`. |
| `parseModelKey(key)` | Splits `provider/modelId`, also accepting the legacy `provider:modelId`; slash wins when both are present. Returns `undefined` if there is no separator at index ≥ 1. |
| `modelKey({ provider, id })` | Emits the canonical `provider/id`. Paired with `parseModelKey`, persisted colon-form keys migrate on the next save. |
| `readEnvVar(key, fallback?)` | Returns the trimmed variable, or `fallback` when it is unset or empty after trimming. |

`XDG_CONFIG_HOME` is the only variable this package reads, and it governs the `rpiv-*` config layer only — Pi's own `~/.pi/…` paths are a separate concern.

## Used by

| Package | Uses |
| --- | --- |
| [`rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) | Path resolution, model-key codec, schema validation for model config |
| [`rpiv-advisor`](https://www.npmjs.com/package/@juicesharp/rpiv-advisor) | Model-key codec, guidance fields, config load/save |
| [`rpiv-web-tools`](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools) | Provider config load/save, guidance schema and validation |
| [`rpiv-telemetry`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-telemetry) (internal, never published) | Config load/save, schema validation, env-var reads |
| [`rpiv-voice`](https://www.npmjs.com/package/@juicesharp/rpiv-voice) | Config load/save |
| [`rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) | Config load/save |
| [`rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) | Config load, guidance fields |
| [`rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | Config load, guidance fields |
| [`rpiv-warp`](https://www.npmjs.com/package/@juicesharp/rpiv-warp) | Config load |
| [`rpiv-workflow`](https://www.npmjs.com/package/@juicesharp/rpiv-workflow) | Path resolution |

These are versioned in lockstep with this package.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/LICENSE).
