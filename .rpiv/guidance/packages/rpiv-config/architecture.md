# rpiv-config

## Monorepo Context
Published plain library in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. NOT a Pi extension — no `pi` field, no `siblings.ts` entry, not auto-suggested by `/rpiv-setup`. Opt-in dependency: siblings add it to their `dependencies` explicitly.

## Responsibility
Shared JSON config I/O utilities for rpiv-mono sibling packages: load/save with crash-resistant defaults, path resolution, guidance-field validation, env-var fallback, and TypeBox-driven schema validation. Stateless — no module-level singletons, no globalThis caches, no side effects.

## Dependencies
- **`typebox`** (direct dependency — moved from peer): `Value` (Clean, Clone, Create) for schema-driven validation; `TObject` / `Static` for type inference

## Consumers
- **`@juicesharp/rpiv-todo`**: `loadJsonConfigWithLegacyFallback`, `validateGuidanceFields`, `GuidanceFields` (type)
- **`@juicesharp/rpiv-ask-user-question`**: `loadJsonConfigWithLegacyFallback`, `validateGuidanceFields`, `GuidanceFields` (type)
- **`@juicesharp/rpiv-warp`**: `loadJsonConfigWithLegacyFallback`, `configPath`
- **`@juicesharp/rpiv-advisor`**: `loadJsonConfigWithLegacyFallback`, `saveJsonConfig`, `configPath`, `validateGuidanceFields`, `modelKey`, `parseModelKey`, `GuidanceFields` (type)
- **`@juicesharp/rpiv-web-tools`**: `loadJsonConfigWithLegacyFallback`, `saveJsonConfig`, `configPath`, `validateGuidanceFields`, `GuidanceFieldsSchema`
- **`@juicesharp/rpiv-voice`**: `loadJsonConfigWithLegacyFallback`, `saveJsonConfig`, `configPath`
- **`@juicesharp/rpiv-i18n`**: `loadJsonConfigWithLegacyFallback`, `saveJsonConfig`, `configPath`
- **`@juicesharp/rpiv-pi`** (rpiv-core): `configPath`, `loadJsonConfigWithLegacyFallback`, `validateConfig`, `parseModelKey`, `modelKey`, `saveJsonConfig`
- **`@juicesharp/rpiv-workflow`**: `configPath`
- **`@juicesharp/rpiv-telemetry`**: `configPath`, `loadJsonConfigWithLegacyFallback`, `readEnvVar`, `saveJsonConfig`, `validateConfig`

No consumer imports plain `loadJsonConfig` anymore — all config-reading siblings migrated to `loadJsonConfigWithLegacyFallback`.

## Module Structure
```
.                — config.ts (all implementation), index.ts (barrel re-export).
                   No subdirectories, no assets, no prompts.
```

## Public API

| Export | Purpose |
|---|---|
| `configPath(name, file?)` | Resolve `<resolveConfigDir()>/<name>/<file>` (default: `config.json`) — XDG-aware, `~/.config` when `XDG_CONFIG_HOME` doesn't apply |
| `loadJsonConfig<T>(path)` | Read + parse JSON config; `{}` for missing/malformed/non-object |
| `loadJsonConfigWithLegacyFallback<T>(name, file?)` | Prefer the XDG-resolved path; read the legacy `~/.config/<name>/<file>` only when the XDG file is absent. Preferred load entry point for all consumers |
| `saveJsonConfig(path, data)` | Write formatted JSON with mkdir + chmod(0o600); returns `boolean` (false on fs failure) — callers MUST guard the success notification on it |
| `GuidanceFields` | Interface: `{ promptSnippet?: string; promptGuidelines?: string[] }` |
| `GuidanceFieldsSchema` | TypeBox form of `GuidanceFields` (`additionalProperties: true`) for callers baking guidance into a larger validated config |
| `validateGuidanceFields(fields)` | Extract valid guidance fields from unknown value |
| `parseModelKey(key)` | Parse `provider/modelId` (or legacy `provider:modelId`) → `{ provider, modelId } \| undefined`; slash preferred |
| `modelKey({provider, id})` | Compose canonical `provider/modelId` string; slash-only emission |
| `readEnvVar(key, fallback?)` | Trimmed env-var lookup with optional fallback |
| `validateConfig<T>(schema, value)` | TypeBox-driven clean + defaults; `{}` on failure |

## XDG Config Resolution
`resolveConfigDir()` (private, `config.ts`) honors `XDG_CONFIG_HOME` per spec: unset, empty-after-trim, whitespace-only, or relative values fall back to `~/.config`; the result is always absolute. Tilde contract: bare `~` and leading `~/` expand to the home directory, but `~user` does NOT (XDG defines no such form) — it fails the `isAbsolute` check and silently routes to the default. `loadJsonConfigWithLegacyFallback` pairs the XDG path with an always-legacy `~/.config/<name>/<file>` read so pre-XDG config files survive an operator setting `XDG_CONFIG_HOME` — but the fallback is one-way: a present-but-malformed XDG file warns and returns `{}` rather than silently reading legacy, so corruption is surfaced, not masked.

## Architectural Boundaries
- **NO Pi extension** — no `pi` field, no tools/commands/hooks
- **NO module-level state** — no singletons, no globalThis caches, no side effects at import time
- **NO test/setup.ts beforeEach reset needed** — stateless package has nothing to reset
- **NO `GuidanceFields` logic divergence** — single canonical implementation replaces 4 byte-identical copies
- **`saveJsonConfig` returns `boolean`** — `false` on mkdir/write failure (disk full, EACCES, EROFS); callers MUST guard the "Saved …" notification on it. The chmod step is best-effort and never affects the return value
- **`loadJsonConfig` applies typeof guard universally** — rejects null, primitives, arrays (fixes Variant B latent bug)
- **`validateConfig` clones before Clean** — `Value.Clean` mutates; `Value.Clone` prevents caller-side mutation
- **`XDG_CONFIG_HOME` governs the rpiv-* sibling config layer only** — Pi-native paths (`~/.pi/…`, via `PI_CODING_AGENT_DIR`) are an orthogonal concern and intentionally NOT unified here
