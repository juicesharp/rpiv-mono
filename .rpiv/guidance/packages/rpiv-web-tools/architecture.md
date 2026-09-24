# rpiv-web-tools

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. Listed in `siblings.ts`; peer-pinned by `rpiv-pi` as `"*"`. Provides `web_search`/`web_fetch` consumed by the web-search-class agent in `rpiv-pi/agents/`.

## Responsibility
Pi extension exposing two tools (`web_search`, `web_fetch`) and one `/web-tools` slash command for configuration. Search is backed by eleven configurable providers (selected per-call, by env, or via `config.provider` — see below): eight hosted REST vendors (Brave, Tavily, Serper, Exa, You.com, Jina, Firecrawl, Perplexity), keyless Parallel Search MCP, and self-hosted SearXNG/Ollama. Fetch dispatches three ways (URL interceptors → provider native fetch → generic HTML-to-text fallback), with truncation-and-temp-file-spill for context-safe payload sizes.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`, truncation helpers, default size limits
- **`@earendil-works/pi-tui`** (peer): rendering primitives
- **`typebox`**: tool parameter + config schemas — regular dependency, not a peer (moved so installers that skip peer materialization still resolve it)
- **`@juicesharp/rpiv-config`**: `configPath`, `loadJsonConfigWithLegacyFallback`, `saveJsonConfig`, `validateGuidanceFields`, `GuidanceFieldsSchema`
- **Eleven configurable search providers**: eight hosted REST vendors, keyless Parallel Search MCP, and self-hosted SearXNG/Ollama (API keys optional); keys resolve env-first, config-second where supported
- Node built-ins for config persistence + temp-file spill

## Consumers
- **Pi extension host**: loads via `pi.extensions: ["./index.ts"]`
- **`rpiv-pi`**: lists in `peerDependencies` and `siblings.ts`; the web-search-class agent declares `web_search, web_fetch` in its tool allowlist

## Module Structure
```
.
├── index.ts                  — Pi extension entry + barrel re-exports
├── web-tools.ts              — Composer: config persistence, key/base-URL resolution, three-way fetch dispatch, tool + command registration
└── providers/                — Provider registry; each provider owns its client end-to-end
    ├── types.ts              — Stable provider contracts (see below)
    ├── config.ts             — WebToolsConfig schema/IO (provider, apiKeys, baseUrls, guidance, interceptors)
    ├── factory.ts            — createSearchProvider(name, creds) → SearchProvider | FullProvider
    ├── fetch-helpers.ts      — Shared HTTP/fetch utilities for provider clients
    ├── index.ts              — Barrel: re-exports types, providers, factory, and `PROVIDERS` metadata array
    ├── <provider>.ts ×11      — brave, tavily, serper, exa, youcom, jina, firecrawl, perplexity, parallel, searxng, ollama
    └── interceptors/         — URL interceptors (host specialists, e.g. GitHub clone-and-read) + chain
```

Stable types (`providers/types.ts`):
```ts
interface SearchResult { title: string; url: string; snippet: string; }
interface SearchResponse { query: string; results: SearchResult[]; }
interface FetchResponse { text: string; title?: string; contentType?: string; contentLength?: number; }
interface SearchProvider { readonly name; readonly label; readonly envVar?;
  search(query: string, maxResults: number, signal?: AbortSignal, sessionId?: string): Promise<SearchResponse>; }
interface FetchProvider { /* …same readonly fields… */
  fetch(url: string, raw: boolean, signal?: AbortSignal): Promise<FetchResponse>; }
type FullProvider = SearchProvider & FetchProvider;   // role-split: search-only vs full
type ProviderRole = "search" | "fetch";
interface ProviderMeta { name; label; envVar?; baseUrlEnvVar?; defaultBaseUrl?;
  roles: ReadonlyArray<ProviderRole>; configure?(ui, current): Promise<ProviderConfigChange | null>; }
// configure() UI contract: ProviderConfigUi, ProviderConfigCurrent, ProviderConfigChange
```

`web-tools.ts` is metadata-driven: it reads the `PROVIDERS` `ProviderMeta[]` for resolution and UI listing and never depends on a specific provider's wire shape. Search-only providers (Brave, Serper, SearXNG, Perplexity, Parallel) implement `SearchProvider`; full providers (Tavily, Exa, You.com, Jina, Firecrawl, Ollama) also implement `fetch()`.

## Active-Provider Selection (four-tier chain, first wins)
`instantiateProvider(config, override?)` (web-tools.ts:175-198) is the single instantiation path shared by both tools: **per-call `provider` tool parameter → `WEB_SEARCH_PROVIDER` env var → `config.provider` → default (brave)**. `web_search`'s optional `provider` param (web-tools.ts:331-341) is a TypeBox union of literal names derived from `PROVIDERS` (`KNOWN_PROVIDER_NAMES`) and targets a different backend for a single call without mutating saved config; unknown names throw the uniform `Unknown web_search provider` error. Credentialed providers require their configured credentials; keyless Parallel skips key resolution, and neither path silently falls back to another provider. `WEB_SEARCH_PROVIDER` lets an operator pin the backend without editing config; it is validated **lazily**: `resolveActiveProviderName` does not validate, so a bogus value renders honestly in `/web-tools --show`/picker and only throws when env is actually the resolving tier for a call (an override wins without consulting it).

## API Key Resolution (env wins over config, per provider)
Search offers eleven providers: eight hosted REST vendors, keyless Parallel Search MCP, and self-hosted SearXNG/Ollama (which may use optional keys). Where an API key is required, resolution is a **per-provider env-then-config chain**: the provider's own environment variable takes priority, then persisted `apiKeys[<provider>]`; missing required credentials throw at tool entry rather than causing a fallback. A top-level legacy `config.apiKey` is honored as a fallback **for Brave only** (`LEGACY_TOP_LEVEL_KEY_PROVIDER`), regardless of the active provider; every successful `/web-tools` save migrates a nonempty legacy key to `apiKeys.brave` before removing the legacy field. Config is read via `loadJsonConfigWithLegacyFallback` (`readConfig`, providers/config.ts:147): `XDG_CONFIG_HOME` is honored when set, with a one-way fallback to the legacy `~/.config` path only when no file exists at the new location; a JSON parse failure returns an empty config, while a schema violation degrades **per-field** (`salvageConfig` drops only the offending paths — `{}` is the floor, never the default response to a partially-bad file). The persisted config file is written with `0o600` permissions.

## Base-URL Resolution (self-hosted providers)
`resolveProviderBaseUrl(meta, config)`: providers that declare `baseUrlEnvVar` (self-hosted SearXNG, Ollama) resolve their endpoint **env → `config.baseUrls[<provider>]` → `meta.defaultBaseUrl` → `""`**. Hosted providers (no `baseUrlEnvVar`) short-circuit to `""`. The `configure()` META hook lets such providers drive a richer `/web-tools` prompt instead of the default single-key input.

## Three-Way web_fetch Dispatch
`web_fetch` resolves a body in priority order (web-tools.ts:440-461): **(1)** URL interceptors (`providers/interceptors/`, currently GitHub; cheap-reject `null` for unrelated hosts; enabled either by end-user `config.interceptors.github` boolean-or-options OR by an embedding consumer via `registerWebTools(pi, { interceptors: { github: true } })` — default OFF, end-user config wins, an explicit `false` overrides a consumer default) → **(2)** the active provider's native `fetch()` when `"fetch" in provider` (full providers) → **(3)** generic HTML-to-text fallback. The factory returns `SearchProvider | FullProvider`; consumers narrow on `"fetch" in provider`.

## Outbound API Call Shape
See providers/brave.ts:31-55 for the canonical client shape (`URL`+`searchParams.set`, `AbortSignal` forwarding, `!res.ok` throw, boundary normalization; SSRF guard `parseAndAssertHttpUrl` rejects non-http(s) protocols and loopback/RFC1918/link-local hosts); the rules are enumerated under Architectural Boundaries below.

## Truncate-Then-Spill Pattern (for large payloads)
See web-tools.ts:464-483 for the spill sequence (`truncateHead` → `spillFullContentToTempFile` → `details.fullOutputPath` + truncation footer). The architectural rule: **never return more than the truncation budget inline**, even if the caller has room.

## Architectural Boundaries
- **NO retry/backoff/throttle** — vendor 429s surface as a thrown error to the agent
- **NO hand-concatenated query strings** — always `new URL(...)` + `searchParams.set`
- **Vendor JSON normalized at the boundary** — internal result shape isolates the rest of the file from vendor-API changes
- **Hard failures throw `Error`** — the host turns it into a tool-error message; never return success-shaped envelopes for failures
- **SSRF guard on every fetched URL** — `parseAndAssertHttpUrl` + private/loopback hostname rejection before any request
- **Config file mode 0o600** — secrets at rest; config loader returns `{}` on parse failure (never crashes)
- **`web_fetch` text-only** — `image/`, `video/`, `audio/` content types throw `Unsupported content type`

<important if="you are adding a new web tool to this extension">
## Adding a Tool
1. **Auth source**: reuse the existing credential resolver when adding another endpoint under the same vendor; otherwise add a parallel resolver with its own env-var + config-field
2. **API client**: own banner section per client; URL via `URL`+`searchParams`, forward the caller's `AbortSignal`, throw on `!res.ok`
3. **Boundary normalization**: every client returns an internal shape — vendor JSON never leaks
4. **Tool registration**: snake_case name, TypeBox params, dual-channel envelope (`content` + typed `details`)
5. **Spill discipline**: large output is truncated inline and spilled to a temp file recorded in `details.fullOutputPath`
6. **Render**: theme-token styling only — no raw ANSI
</important>
