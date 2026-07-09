# Changelog

All notable changes to `@juicesharp/rpiv-web-tools` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `web_search` now accepts an optional `provider` parameter that routes a single call to a different backend than the active provider set via `/web-tools`, without mutating persisted config or restarting the session. Valid values: `brave`, `tavily`, `serper`, `exa`, `youcom`, `jina`, `firecrawl`, `perplexity`, `searxng`, `ollama`. The named provider must have its own API key / base URL configured (env var or `/web-tools`); an unknown name or an unconfigured provider throws instead of silently falling back, so callers can detect misconfiguration. `details.backend` reflects the actually-used provider. Closes #82.
- `WEB_SEARCH_PROVIDER` env var now pins the active provider as a middle tier in the resolution chain: per-call `provider` override ?? `WEB_SEARCH_PROVIDER` ?? `config.provider` ?? default. A non-empty env value is validated like the override — an unknown name throws on the next `web_search` — but only when it actually wins the resolution, so a bogus `WEB_SEARCH_PROVIDER` no longer defeats a valid per-call override. `/web-tools --show` and the provider picker derive the active provider from a shared resolver that reports its source (env/config/default) without validating, so a typo surfaces honestly in the display and only fails once a search actually runs.
- `readConfig()` now reads through `@juicesharp/rpiv-config`'s XDG-aware `loadJsonConfigWithLegacyFallback("rpiv-web-tools")` instead of a fixed `loadJsonConfig(CONFIG_PATH)` call, so the config directory follows `XDG_CONFIG_HOME` when set to a usable absolute path, falling back to `~/.config` when unset, empty, whitespace, or relative. The legacy `~/.config/rpiv-web-tools/config.json` path is still read, but only when no file exists at the resolved XDG location; a malformed file at the XDG location warns and returns `{}` rather than silently falling back to the legacy file. Config writes remain XDG-only.

### Fixed
- Moved `typebox` from `peerDependencies` to `dependencies` (`^1.1.24`, matching the Pi host's range) so `web_search` / `web_fetch` parameter schemas resolve under installers that don't materialise peer deps. Fixes `ERR_MODULE_NOT_FOUND: typebox` on standalone consumer installs (#79).
- Test files are no longer published in the npm tarball. `files` packed `providers/**/*.test.ts`, which import the private, unpublished `@juicesharp/rpiv-test-utils` fixture package, so a standalone consumer running the bundled tests hit `ERR_MODULE_NOT_FOUND`. Added a `!**/*.test.ts` exclusion to `files` (#80).
- Raised `EXA_MAX_FETCH_CHARACTERS` from 10,000 (matching Exa's documented OpenAPI schema) to 1,000,000 (matching the live API's actual accepted maximum). At 10k chars, content from Exa's `fetch()` fell below the 50 KiB `DEFAULT_MAX_BYTES` threshold used by `web_fetch`'s `truncateHead()`, so truncation never triggered and no `[Content truncated: ...]` footer or temp-file spill occurred — the model saw silently truncated content with no recovery path. At 1M chars, truncation reliably triggers, appending the footer and spilling the full text to a temp file the model can read (#94).

## [1.20.0] - 2026-06-15

### Fixed
- Jina search now handles the Search API returning `data` as a direct array (not just a `{ data: [...] }` envelope), so `web_search` no longer yields zero results against that response shape (#73).

## [1.19.1] - 2026-06-10

## [1.19.0] - 2026-06-09

## [1.18.2] - 2026-06-04

## [1.18.1] - 2026-06-04

## [1.18.0] - 2026-06-04

### Changed
- Drop Notes column from the providers table in the README.

## [1.17.1] - 2026-06-01

### Added
- **You.com search+fetch provider** — new `FullProvider` backed by You.com's Search API (`POST /v1/search`) and Contents API (`POST /v1/contents`). Returns native markdown with `contentType: "text/markdown"`. Configure via `YOUCOM_API_KEY` env var or `apiKeys.youcom` in `~/.config/rpiv-web-tools/config.json`. `web_fetch` uses the Contents API for clean markdown extraction (same path as Jina/Firecrawl).
- **Perplexity search provider** — search-only `SearchProvider` posting to `POST https://api.perplexity.ai/search` with `Authorization: Bearer $PERPLEXITY_API_KEY`. Configure via env var or `/web-tools` (paste the key from [docs.perplexity.ai](https://docs.perplexity.ai/)). `web_fetch` falls through to the shared raw-HTTP + htmlToText pipeline (same path as Brave/Serper/SearXNG). $5/1K requests, 50 RPS tier-independent rate limit. See README provider table.

## [1.17.0] - 2026-06-01

## [1.16.1] - 2026-05-30

## [1.16.0] - 2026-05-30

## [1.15.0] - 2026-05-28

### Added
- **GitHub URL interceptor** — `web_fetch` can route github.com URLs through `gh` / `git` for full repository content (file tree, README, file contents) instead of the rendered HTML page. **Off by default** to preserve existing behavior. Opt in via `"interceptors": { "github": true }` in `~/.config/rpiv-web-tools/config.json` (end-user) or `registerWebTools(pi, { interceptors: { github: true } })` (consumer extensions). Power-user object form available for tuning `maxRepoSizeMB` (default 350), `cloneTimeoutSeconds` (default 30), and `clonePath` (default `$TMPDIR/pi-github-repos`). See README §GitHub URL interceptor.
- `/web-tools --show` now reports URL interceptor state at the bottom of its output (enabled/disabled, masked `GITHUB_TOKEN`, `clonePath`, threshold).
- Programmatic `RegisterOptions` parameter: `registerWebTools(pi, { interceptors?: { github?: boolean } })`.
- New exports: `GitHubInterceptor`, `parseGitHubUrl`, `GitHubUrlInfo`, `GITHUB_TOKEN_ENV_VAR`, `resolveGitHubOptions`, `UrlInterceptor`, `FetchProvider`, `FullProvider`, `ProviderRole`.

### Changed
- **Provider role split.** `SearchProvider` is now search-only (no `fetch()` method). Providers with native fetch endpoints — Tavily, Exa, Jina, Firecrawl, Ollama — implement the new `FullProvider = SearchProvider & FetchProvider`; search-only providers — Brave, Serper, SearXNG — implement `SearchProvider`. `ProviderMeta.roles: ReadonlyArray<"search" | "fetch">` makes capability explicit.
- `web_fetch` dispatch is now three-way: URL interceptor chain → provider's native `fetch()` when present → shared `fetchViaGenericHtml` fallback. Brave/Serper/SearXNG previously each carried their own `fetch()` method that wrapped the shared pipeline; same observable behavior, single helper now.
- `createSearchProvider(name, creds)` return type widened from `SearchProvider` to `SearchProvider | FullProvider`. Narrow with `"fetch" in provider`.
- Config schema gained a top-level `interceptors` key. Existing config files keep working unchanged.

### Removed
- Per-provider `fetch()` methods on `BraveProvider`, `SerperProvider`, and `SearxngProvider`. The shared `fetchViaGenericHtml` helper in `providers/fetch-helpers.ts` is invoked by the orchestrator's fallback branch.

### Breaking / Upgrade Notes
- Consumers that imported `SearchProvider` and called `.fetch()` on it will get a TypeScript error. Migrate the type to `FullProvider` (Tavily/Exa/Jina/Firecrawl/Ollama users) or narrow generic code with `"fetch" in provider`.
- Consumers that called `new BraveProvider(key).fetch(...)`, `new SerperProvider(key).fetch(...)`, or `new SearxngProvider(...).fetch(...)` directly should use `fetchViaGenericHtml(url, raw, signal)` from `providers/fetch-helpers.ts` instead.
- No config migration required for existing users — released `provider` / `apiKeys` / `baseUrls` / `apiKey` (legacy) / `guidance` keys all behave unchanged.

## [1.14.7] - 2026-05-28

## [1.14.6] - 2026-05-28

## [1.14.5] - 2026-05-28

## [1.14.4] - 2026-05-28

## [1.14.3] - 2026-05-28

## [1.14.2] - 2026-05-28

## [1.14.1] - 2026-05-28

## [1.14.0] - 2026-05-28

### Added
- Ollama search provider supporting both local instances and cloud (ollama.com), with configurable base URL and optional API key.

### Changed
- `/web-search-config` command renamed to `/web-tools`.
- Cover artwork redesigned with all eight provider logos.

## [1.13.0] - 2026-05-25

## [1.12.0] - 2026-05-21

### Added
- New `searxng` search provider for self-hosted [SearXNG](https://docs.searxng.org/) instances. Configure via `SEARXNG_URL` env var or `baseUrls.searxng` in `~/.config/rpiv-web-tools/config.json` (defaults to `http://localhost:8080`); optional `SEARXNG_API_KEY` / `apiKeys.searxng` for instances behind a Bearer-auth proxy. `/web-search-config` prompts for the URL first, then the optional key. `web_fetch` reuses the shared HTTP + htmlToText pipeline (same path as Brave/Serper). A `403` response from the instance attaches an actionable hint that `json` likely needs to be enabled under `search.formats` in `settings.yml`.

### Changed
- **Breaking (provider factory):** `createSearchProvider(name, apiKey: string)` is now `createSearchProvider(name, creds: ProviderCredentials)` where `ProviderCredentials = { apiKey?: string; baseUrl?: string }`. The six hosted providers still receive their key transparently via `creds.apiKey`; direct downstream callers must update to the options-bag form. SearXNG uses the new `baseUrl` slot.
- README clarifies that the SSRF guard applies to URLs `web_fetch` retrieves, not to the SearXNG search endpoint (which intentionally supports loopback for self-hosted instances).
- README adds a Docker recipe for running SearXNG locally with persistent settings.

### Fixed
- Harden SearXNG provider against misconfigured URLs: reject non-HTTP schemes at construction, strip multiple trailing slashes, and surface a dedicated `401` hint for auth-proxy rejections.

### Breaking / Upgrade Notes
- `createSearchProvider(name, apiKey)` callers must update to `createSearchProvider(name, { apiKey, baseUrl })`.

## [1.11.0] - 2026-05-20

### Changed
- Relocate npm + MIT badges from the cover area to the License section in README.

## [1.10.2] - 2026-05-20

### Changed
- Refresh npm cover (`docs/cover.{svg,png}`): align with the unified card layout used across the `@juicesharp/rpiv-*` family and add a provider chip strip surfacing all six backends (Brave active, plus Tavily, Serper, Exa, Jina, Firecrawl) with the `/web-search-config` hint.

## [1.10.1] - 2026-05-19

## [1.10.0] - 2026-05-19

## [1.9.2] - 2026-05-19

## [1.9.1] - 2026-05-19

## [1.9.0] - 2026-05-18

## [1.8.3] - 2026-05-18

## [1.8.2] - 2026-05-17

## [1.8.1] - 2026-05-17

### Fixed
- `/web-search-config` now persists settings to disk before applying them in memory, preventing silent reverts on write failure.

## [1.8.0] - 2026-05-16

### Added
- Multi-provider web search with support for Tavily, Exa, Jina, and Firecrawl alongside Brave and Serper.
- `/web-search-config` shows the active provider first with a ✓ marker, marks configured providers, and preserves existing API keys on empty input.

### Changed
- Update README and npm metadata to document the six-provider search architecture.

### Fixed
- `/web-search-config` notifications and input titles now display clean provider labels.
- Reject loopback and private-network URLs to prevent SSRF via Brave/Serper raw fetch.
- Handle empty response bodies from Jina fetch correctly.

## [1.7.0] - 2026-05-15

## [1.6.1] - 2026-05-14

## [1.6.0] - 2026-05-14

## [1.5.2] - 2026-05-13

### Added
- Per-tool guidance overrides for `web_search` and `web_fetch` via `~/.config/rpiv-web-tools/config.json`.

### Changed
- README documents the nested guidance shape and `web_fetch` reach.

## [1.5.1] - 2026-05-13

## [1.5.0] - 2026-05-12

## [1.4.2] - 2026-05-11

## [1.4.1] - 2026-05-11

## [1.4.0] - 2026-05-10

## [1.3.1] - 2026-05-10

## [1.3.0] - 2026-05-08

## [1.2.1] - 2026-05-07

## [1.2.0] - 2026-05-07

## [1.1.5] - 2026-05-05

### Documentation
- README: documented the `web_search` and `web_fetch` tool schemas so consumers can see the parameter surface without reading the source.

## [1.1.4] - 2026-05-03

## [1.1.3] - 2026-05-03

## [1.1.2] - 2026-05-03

## [1.1.1] - 2026-05-03

## [1.1.0] - 2026-05-03

## [1.0.19] - 2026-05-03

## [1.0.18] - 2026-05-02

## [1.0.17] - 2026-05-02

## [1.0.16] - 2026-05-02

## [1.0.15] - 2026-05-02

## [1.0.14] - 2026-05-01

### Changed
- Cover redesigned as a macOS-style terminal-window screenshot demonstrating the extension's hero feature.

## [1.0.13] - 2026-05-01

### Added
- `docs/vertical-cover.{svg,png}` — portrait-orientation hero artwork (1280×800 canvas; PNG downscaled to 320×711).

### Changed
- Cover canvas extended from 1280×640 to 1280×800 with refreshed crop marks/footer.
- README hero swapped from `docs/cover.png` to `docs/vertical-cover.png`, rendered at `width="160"`. The `<a>` wrapper around the `<picture>` was removed so the image is no longer a clickable link to the package directory.

## [1.0.12] - 2026-05-01

### Added
- `docs/cover.png` — package hero (rasterized from `docs/cover.svg` via `rsvg-convert`, 1280×640).

### Changed
- README hero: open with a `<picture>`-wrapped `cover.png` above the shield badges so pi.dev's package-card image extractor picks the friendly artwork instead of the npm version shield. Existing `docs/config.jpg` screenshot retained below the description.

## [1.0.11] - 2026-04-30

### Changed
- README rewritten with a user-outcome opener ("Let the model search the web and read pages") and a new `## Features` section (Brave-backed search 1–10 results, raw/text fetch modes, large-page spillover to temp file, interactive `/web-search-config` setup writing chmod 0600 config). `package.json` `description` synced.

## [1.0.10] - 2026-04-30

## [1.0.9] - 2026-04-30

## [1.0.8] - 2026-04-29

## [1.0.7] - 2026-04-29

## [1.0.6] - 2026-04-29

## [1.0.5] - 2026-04-29

## [1.0.4] - 2026-04-28

## [1.0.3] - 2026-04-28

## [1.0.2] - 2026-04-28

## [1.0.1] - 2026-04-28

## [1.0.0] - 2026-04-28

## [0.13.0] - 2026-04-28

## [0.12.7] - 2026-04-26

## [0.12.6] - 2026-04-26

## [0.12.5] - 2026-04-24

## [0.12.4] - 2026-04-24

## [0.12.3] - 2026-04-24

## [0.12.2] - 2026-04-24

## [0.12.1] - 2026-04-24

## [0.12.0] - 2026-04-24

## [0.11.7] - 2026-04-23

## [0.11.6] - 2026-04-22

## [0.11.5] - 2026-04-22

## [0.11.4] - 2026-04-21

## [0.11.3] - 2026-04-21

## [0.11.2] - 2026-04-21

## [0.11.1] - 2026-04-20

## [0.11.0] - 2026-04-20

## [0.10.0] - 2026-04-20

## [0.9.1] - 2026-04-20

## [0.9.0] - 2026-04-19

## [0.8.3] - 2026-04-19

## [0.8.2] - 2026-04-19

## [0.8.1] - 2026-04-19

## [0.8.0] - 2026-04-19

## [0.7.0] - 2026-04-18

## [0.6.1] - 2026-04-18

## [0.6.0] — 2026-04-18

### Changed
- Consolidated into the `juicesharp/rpiv-mono` monorepo. Version aligned to the rpiv-pi family lockstep starting point. No runtime behavior change from `0.1.2`.
