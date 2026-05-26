# rpiv-web-tools

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/cover.png" alt="rpiv-web-tools cover" width="50%">
    </picture>
  </a>
</div>

Let the model search the web and read pages. `rpiv-web-tools` adds `web_search` and `web_fetch` tools to [Pi Agent](https://github.com/badlogic/pi-mono) with pluggable providers (Brave, Tavily, Serper, Exa, Jina, Firecrawl, [SearXNG](https://docs.searxng.org/), [Ollama](https://ollama.com)), plus `/web-search-config` for interactive provider selection and API-key setup.

![Provider selection prompt](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/config.jpg)

## Features

- **Eight pluggable providers** - Brave, Tavily, Serper, Exa, Jina, Firecrawl, self-hosted SearXNG, and Ollama (local or cloud). Pick one as the active backend; switch any time without losing the others' keys.
- **Per-provider fetch strategy** - Brave, Serper, and SearXNG read the URL directly and strip HTML to text; Tavily/Exa/Jina/Firecrawl use their native extraction endpoints (markdown for Jina/Firecrawl, plain text for Tavily/Exa).
- **Read any URL** - fetch http/https pages with HTML-to-text extraction, or get the raw response with `raw: true` (honoured by Brave/Serper; extraction providers always return their parsed text).
- **Large-page spillover** - oversized responses truncate inline and spill the full body to a temp file the model can read on demand.
- **SSRF guard** - refuses loopback, RFC 1918, link-local, and cloud-metadata addresses (`localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`).
- **Interactive setup** - `/web-search-config` lists providers (active one first, configured ones marked) and writes to `~/.config/rpiv-web-tools/config.json` (chmod 0600); per-provider env vars also work and take precedence over persisted keys.

## Install

```bash
pi install npm:@juicesharp/rpiv-web-tools
```

Then restart your Pi session.

## Tools

- **`web_search`** - query the active provider's search API and return titled snippets.
  1–10 results per call.
- **`web_fetch`** - fetch an http/https URL through the active provider's content path
  (raw HTTP+htmlToText for Brave/Serper; native extraction for Tavily/Exa/Jina/Firecrawl),
  truncate large responses with a temp-file spill for the full content.

### Schema - `web_search`

```ts
web_search({
  query: string,                    // natural-language query
  max_results?: number,             // 1-10, default 5
})
```

Returns:

```ts
{
  content: [{ type: "text", text: string }], // markdown list of "**title**\n url\n snippet"
  details: {
    query: string,
    backend: "brave" | "tavily" | "serper" | "exa" | "jina" | "firecrawl" | "searxng" | "ollama",
    resultCount: number,
    results?: Array<{ title: string, url: string, snippet: string }>,
  }
}
```

Throws when the active provider's API key is unset (e.g. `EXA_API_KEY is not set`) or the provider's API returns a non-2xx response.

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

Throws on invalid URL, non-http(s) protocol, private/loopback hostnames (SSRF guard), non-2xx response, or `image/` / `video/` / `audio/` content types. Extraction providers (Tavily/Exa/Jina/Firecrawl) additionally throw when the API returns an empty body or a vendor-level failure (e.g. Firecrawl `success: false`, Tavily `failed_results`).

## Commands

- **`/web-search-config`** - pick the active provider and set its API key interactively.
  Providers already configured show `(configured)`; the active one is listed first with a `✓`.
  Pressing Enter on an empty input keeps the existing key for the chosen provider while
  persisting the provider switch. Pass `--show` to see all per-provider keys (masked) and env var status.

## API key resolution (per active provider)

First match wins:

1. The active provider's environment variable: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `SEARXNG_API_KEY`, or `OLLAMA_API_KEY`
2. `apiKeys.<provider>` field in `~/.config/rpiv-web-tools/config.json`
3. Legacy `apiKey` field (Brave only — auto-migrated to the new shape on next save)

The active provider is `config.provider` (set by `/web-search-config`); falls back to `brave` if absent.

## SearXNG (self-hosted)

SearXNG is the only provider that talks to an instance you control, so it needs a base URL instead of (or in addition to) an API key.

```bash
export SEARXNG_URL=http://localhost:8080
# Optional: only if your instance sits behind a Bearer-auth reverse proxy
export SEARXNG_API_KEY=…
```

Resolution order for the URL: `SEARXNG_URL` env var → `baseUrls.searxng` in `~/.config/rpiv-web-tools/config.json` → default `http://localhost:8080`. `/web-search-config` prompts for the URL first and the (optional) API key second.

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

Or configure interactively via `/web-search-config` — select "Ollama" and enter the URL and key.

Resolution order:
- **Base URL**: `OLLAMA_HOST` env var → `baseUrls.ollama` in config → default `http://localhost:11434`
- **API key**: `OLLAMA_API_KEY` env var → `apiKeys.ollama` in config (optional for local, required for cloud)

The provider automatically uses the correct API paths:
- **Local** (`localhost`, `127.0.0.1`, `0.0.0.0`): `/api/experimental/web_search` and `/api/experimental/web_fetch`
- **Cloud** (any other host): `/api/web_search` and `/api/web_fetch`

## Executor guidance overrides

Override the `promptSnippet` / `promptGuidelines` the model sees for each tool by editing `~/.config/rpiv-web-tools/config.json`. Note the per-tool nesting under `guidance.web_search` / `guidance.web_fetch` — this differs from the flat `guidance` shape used by single-tool siblings (`rpiv-advisor`, `rpiv-todo`, `rpiv-ask-user-question`):

```json
{
  "provider": "exa",
  "apiKeys": {
    "exa": "sk-...",
    "brave": "sk-..."
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

## Security note: `web_fetch` host guard

`web_fetch` refuses URLs targeting loopback (`localhost`, `127.0.0.0/8`, `::1`), RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, including cloud-metadata at `169.254.169.254`), and IPv6 unique-local / link-local (`fc00::/7`, `fe80::/10`). Attempts surface as `Refusing to fetch private/loopback address: <host>`. This blocks the most common SSRF class — direct-literal targeting of internal services or cloud-metadata endpoints — without preventing legitimate public-web fetches.

The guard is host-literal only; it does NOT resolve DNS or validate redirects. A public hostname that resolves to a private IP, or a public URL that 302-redirects to one, will still reach the target. For untrusted automation environments, layer an egress proxy or firewall on top.

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-web-tools.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT
