# rpiv-web-tools

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/cover.png" alt="rpiv-web-tools cover" width="50%">
    </picture>
  </a>
</div>

Let the model search the web and read pages. `rpiv-web-tools` adds `web_search` and `web_fetch` tools to [Pi Agent](https://github.com/badlogic/pi-mono) with pluggable providers (Brave, Tavily, Serper, Exa, You.com, Jina, Firecrawl, Perplexity, [SearXNG](https://docs.searxng.org/), [Ollama](https://ollama.com)), plus `/web-tools` for interactive provider selection and API-key setup.

![Provider selection prompt](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/config.jpg)

## Providers

Pick one as the active backend; switch any time without losing the others' keys.

| Provider | Env var | Signup | Fetch mode |
|---|---|---|---|
| Brave | `BRAVE_SEARCH_API_KEY` | [brave.com/search/api](https://brave.com/search/api/) | raw HTTP → htmlToText, `raw: true` available |
| Tavily | `TAVILY_API_KEY` | [tavily.com](https://tavily.com) | native extraction (plain text) |
| Serper | `SERPER_API_KEY` | [serper.dev](https://serper.dev) | raw HTTP → htmlToText, `raw: true` available |
| Exa | `EXA_API_KEY` | [exa.ai](https://exa.ai) | native extraction (plain text) |
| You.com | `YDC_API_KEY` | [you.com](https://you.com) | native extraction (markdown) |
| Jina | `JINA_API_KEY` | [jina.ai/reader](https://jina.ai/reader) | native extraction (markdown) |
| Firecrawl | `FIRECRAWL_API_KEY` | [firecrawl.dev](https://firecrawl.dev) | native extraction (markdown) |
| Perplexity | `PERPLEXITY_API_KEY` | [docs.perplexity.ai](https://docs.perplexity.ai/) | raw HTTP → htmlToText, `raw: true` available |
| SearXNG | `SEARXNG_URL` (+ optional `SEARXNG_API_KEY`) | self-hosted | raw HTTP → htmlToText, `raw: true` available |
| Ollama | `OLLAMA_HOST` / `OLLAMA_API_KEY` | local or [ollama.com](https://ollama.com) | native extraction |

## Features

- **Read any URL** - fetch http/https pages with HTML-to-text extraction, or get the raw response with `raw: true` (honoured by Brave/Serper/Perplexity/SearXNG; extraction providers — Tavily/Exa/You.com/Jina/Firecrawl/Ollama — always return their parsed text).
- **GitHub URL interceptor (opt-in)** - github.com URLs route through `gh`/`git` for full repository content (file tree, README, individual file contents) instead of the rendered HTML page. Off by default; enable per-user via config or per-consumer at registration time. See [§GitHub URL interceptor](#github-url-interceptor).
- **Large-page spillover** - oversized responses truncate inline and spill the full body to a temp file the model can read on demand.
- **SSRF guard** - refuses loopback, RFC 1918, link-local, and cloud-metadata addresses (`localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`).
- **Interactive setup** - `/web-tools` lists providers (active one first, configured ones marked) and writes to `~/.config/rpiv-web-tools/config.json` (chmod 0600); per-provider env vars also work and take precedence over persisted keys.

## Install

```bash
pi install npm:@juicesharp/rpiv-web-tools
```

Then restart your Pi session.

## Tools

- **`web_search`** - query a search provider's API and return titled snippets. Defaults to the active provider set via `/web-tools`; pass `provider` to target a different backend on a single call without switching the persisted default. 1–10 results per call.
- **`web_fetch`** - read an http/https URL. Lookup order: opt-in URL interceptors
  (see [§GitHub URL interceptor](#github-url-interceptor)), then the active provider's native
  fetch endpoint when it has one (Tavily/Exa/You.com/Jina/Firecrawl/Ollama → vendor extraction;
  Brave/Serper/Perplexity/SearXNG → shared raw HTTP + HTML-to-text fallback). Large responses truncate
  inline and spill the full body to a temp file the model can read on demand.

### Schema - `web_search`

```ts
web_search({
  query: string,                    // natural-language query
  max_results?: number,             // 1-10, default 5
  provider?:                        // per-call provider override; see below
    | "brave" | "tavily" | "serper" | "exa" | "youcom" | "jina"
    | "firecrawl" | "perplexity" | "searxng" | "ollama",
})
```

Returns:

```ts
{
  content: [{ type: "text", text: string }], // markdown list of "**title**\n url\n snippet"
  details: {
    query: string,
    backend: "brave" | "tavily" | "serper" | "exa" | "youcom" | "jina" | "firecrawl" | "perplexity" | "searxng" | "ollama",
    resultCount: number,
    results?: Array<{ title: string, url: string, snippet: string }>,
  }
}
```

Throws when the resolved provider's API key is unset (e.g. `EXA_API_KEY is not set`), the provider's API returns a non-2xx response, or an explicit `provider` names a provider with no configured credentials (no silent fallback — the caller can detect the misconfiguration).

#### Per-call `provider` override

The optional `provider` parameter routes a single call to a different backend than the active provider set via `/web-tools`, without mutating persisted config or restarting the session. Resolution:

1. `params.provider` (if present) — must be one of the literal provider names listed above. Unknown names throw `Unknown web_search provider: "<name>"`.
2. `config.provider` (the active provider selected via `/web-tools`).
3. `brave` (default when `config.provider` is absent).

The named provider must have its own API key / base URL configured (via env var or `/web-tools`); the override does not inherit credentials from the active provider. A request for an unconfigured provider throws the provider's usual `… is not set` error rather than silently falling back, so agents can detect and react. Use this for provider comparison, falling back to a second backend when the active one returns poor results, or any multi-provider workflow that previously required a config switch and session restart.

### Schema - `web_fetch`

```ts
web_fetch({
  url: string,                      // http or https only
  raw?: boolean,                    // true → return raw HTML; default false → strip to text
})
```

Returns:

```ts
{
  content: [{ type: "text", text: string }], // header (URL/title/content-type) + body
  details: {
    url: string,
    title?: string,                 // <title> element, if present (HTML, non-raw)
    contentType?: string,
    contentLength?: number,         // from Content-Length header
    truncation?: TruncationResult,  // present when body exceeded inline limits
    fullOutputPath?: string,        // temp-file path containing the un-truncated body
  }
}
```

Throws on invalid URL, non-http(s) protocol, private/loopback hostnames (SSRF guard), non-2xx response, or `image/` / `video/` / `audio/` content types. Extraction providers (Tavily/Exa/You.com/Jina/Firecrawl) additionally throw when the API returns an empty body or a vendor-level failure (e.g. Firecrawl `success: false`, Tavily `failed_results`).

## Commands

- **`/web-tools`** - pick the active provider and set its API key interactively.
  Providers already configured show `(configured)`; the active one is listed first with a `✓`.
  Pressing Enter on an empty input keeps the existing key for the chosen provider while
  persisting the provider switch. Pass `--show` to see all per-provider keys (masked), env var status,
  and current URL interceptor states (see [§GitHub URL interceptor](#github-url-interceptor)).

## API key resolution (per active provider)

First match wins:

1. The active provider's environment variable: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `YDC_API_KEY`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `PERPLEXITY_API_KEY`, `SEARXNG_API_KEY`, or `OLLAMA_API_KEY`
2. `apiKeys.<provider>` field in `~/.config/rpiv-web-tools/config.json`
3. Legacy `apiKey` field (Brave only — auto-migrated to the new shape on next save)

The active provider is `config.provider` (set by `/web-tools`); falls back to `brave` if absent.

## SearXNG (self-hosted)

SearXNG is the only provider that talks to an instance you control, so it needs a base URL instead of (or in addition to) an API key.

```bash
export SEARXNG_URL=http://localhost:8080
# Optional: only if your instance sits behind a Bearer-auth reverse proxy
export SEARXNG_API_KEY=…
```

Resolution order for the URL: `SEARXNG_URL` env var → `baseUrls.searxng` in `~/.config/rpiv-web-tools/config.json` → default `http://localhost:8080`. `/web-tools` prompts for the URL first and the (optional) API key second.

Your instance must have `json` enabled in `settings.yml` under `search.formats` — default SearXNG installs ship with JSON disabled and will return `403 Forbidden` otherwise (per the [SearXNG search API docs](https://docs.searxng.org/dev/search_api.html)). The provider surfaces that case with an actionable hint. SearXNG's `web_fetch` reuses the same raw-HTTP + HTML-to-text pipeline as Brave/Serper, so URLs returned by `web_search` can be fetched without any extra setup.

The SSRF guard (which refuses loopback and RFC-1918 addresses) applies to URLs `web_fetch` retrieves on the model's behalf, not to the SearXNG search endpoint itself: a `SEARXNG_URL` pointing at `http://localhost:8080` or another private host is intentionally reachable, since SearXNG is self-hosted by design.

### Running SearXNG locally with Docker

The `searxng/searxng` entrypoint **overwrites** `/etc/searxng/settings.yml` on first start with the bundled default (ships with `formats: [html]` only). Pre-populating the mounted file doesn't stick — wait for the entrypoint, then patch:

```bash
mkdir -p ~/.searxng
docker run -d --name searxng --restart unless-stopped \
  -p 8080:8080 -v "$HOME/.searxng":/etc/searxng \
  -e BASE_URL=http://localhost:8080/ searxng/searxng:latest
sleep 5  # wait for entrypoint to write settings.yml
sed -i.bak '/^  formats:$/,/^[^ ]/ { /- html/a\
    - json
}' ~/.searxng/settings.yml
docker restart searxng

# Sanity check — a number > 0 means it's wired correctly
curl -sf 'http://localhost:8080/search?q=hello&format=json' | jq '.results | length'
```

`403` means JSON is still disabled — re-check `~/.searxng/settings.yml`. Works identically on Docker Desktop or OrbStack. For a throwaway test instance, swap `~/.searxng` for `/tmp/searxng` and drop `--restart unless-stopped`.

## Ollama (local or cloud)

Ollama provides web search and fetch as built-in capabilities — no third-party API key needed for local usage. For cloud access, an API key is required.

### Local Ollama

Just run Ollama locally and it works out of the box:

```bash
ollama serve
```

No API key needed. The provider talks to `http://localhost:11434` by default.

### Ollama Cloud

For cloud access via [Ollama Cloud](https://ollama.com), set the base URL and API key:

```bash
export OLLAMA_HOST=https://ollama.com
export OLLAMA_API_KEY=your_api_key   # generate at https://ollama.com/settings/keys
```

Or configure interactively via `/web-tools` — select "Ollama" and enter the URL and key.

Resolution order:
- **Base URL**: `OLLAMA_HOST` env var → `baseUrls.ollama` in config → default `http://localhost:11434`
- **API key**: `OLLAMA_API_KEY` env var → `apiKeys.ollama` in config (optional for local, required for cloud)

The provider automatically uses the correct API paths:
- **Local** (`localhost`, `127.0.0.1`, `0.0.0.0`): `/api/experimental/web_search` and `/api/experimental/web_fetch`
- **Cloud** (any other host): `/api/web_search` and `/api/web_fetch`

## GitHub URL interceptor

Routes github.com URLs through `gh` / `git` to return repository content (file tree, README, file content) instead of the rendered HTML. **Off by default.** Opt in two ways:

```json
// ~/.config/rpiv-web-tools/config.json — end-user opt-in
{ "interceptors": { "github": true } }
```

```ts
// or per-consumer at registration time (user config still wins)
registerWebTools(pi, { interceptors: { github: true } });
```

When enabled, github.com URLs are parsed into `owner/repo/ref/path`; non-code paths (`/issues`, `/pulls`, `/discussions`, `/releases`, …) fall through to the active provider. The interceptor probes for `gh`, falls back to plain `git clone` (with a stderr hint to install `gh`), and uses the `gh api` JSON view for SHA-pinned URLs and repos above `maxRepoSizeMB`. Shallow clones (`--depth 1 --single-branch`) land in `clonePath`; successful clones cache by `owner/repo@ref` for the session. Auth flows through `gh`'s normal `GH_TOKEN`/`GITHUB_TOKEN` precedence — export `GITHUB_TOKEN` to reach private repos.

Replace the boolean shorthand with an object to tune the defaults; object form implies opt-in.

```json
{
  "interceptors": {
    "github": {
      "maxRepoSizeMB": 1000,
      "cloneTimeoutSeconds": 90,
      "clonePath": "/Users/me/.cache/pi-github-repos"
    }
  }
}
```

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `false` (top-level) / `true` (inside object form) | Master switch |
| `maxRepoSizeMB` | `350` | Repos above this threshold skip the clone and use the API view |
| `cloneTimeoutSeconds` | `30` | Kill the clone process after this many seconds |
| `clonePath` | `$TMPDIR/pi-github-repos` | Where shallow clones land; one subdir per `owner/repo@ref` |

`/web-tools --show` reports the current state at the bottom of its output (resolved token masked, `clonePath`, `maxRepoSizeMB`). The SSRF guard still runs first — a URL with a private/loopback host can't bypass it via a github.com path shape.

## Executor guidance overrides

Override the `promptSnippet` / `promptGuidelines` the model sees for each tool by editing `~/.config/rpiv-web-tools/config.json`. Note the per-tool nesting under `guidance.web_search` / `guidance.web_fetch` — this differs from the flat `guidance` shape used by single-tool siblings (`rpiv-advisor`, `rpiv-todo`, `rpiv-ask-user-question`):

```json
{
  "provider": "exa",
  "apiKeys": {
    "exa": "sk-...",
    "brave": "sk-..."
  },
  "interceptors": {
    "github": true
  },
  "guidance": {
    "web_search": {
      "promptSnippet": "Search the web for current docs and library versions",
      "promptGuidelines": [
        "Only call web_search when training-data answers may be stale.",
        "Always include a Sources: section with markdown hyperlinks."
      ]
    },
    "web_fetch": {
      "promptSnippet": "Fetch a specific URL and read its content"
    }
  }
}
```

Each field is independent: omit one and the built-in default is kept. Invalid values (empty string, wrong type, empty array) silently fall back to defaults. Changes take effect on the next Pi session start.

The `interceptors` key is the GitHub URL interceptor opt-in — see [§GitHub URL interceptor](#github-url-interceptor) for the full schema (boolean shorthand or per-field overrides).

## Security note: `web_fetch` host guard

`web_fetch` refuses URLs targeting loopback (`localhost`, `127.0.0.0/8`, `::1`), RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, including cloud-metadata at `169.254.169.254`), and IPv6 unique-local / link-local (`fc00::/7`, `fe80::/10`). Attempts surface as `Refusing to fetch private/loopback address: <host>`. This blocks the most common SSRF class — direct-literal targeting of internal services or cloud-metadata endpoints — without preventing legitimate public-web fetches.

The guard is host-literal only; it does NOT resolve DNS or validate redirects. A public hostname that resolves to a private IP, or a public URL that 302-redirects to one, will still reach the target. For untrusted automation environments, layer an egress proxy or firewall on top.

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-web-tools.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT
