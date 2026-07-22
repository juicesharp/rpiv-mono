# Self-hosted backends

Two of the ten providers talk to an instance you run yourself, so nothing has to
leave your network: **SearXNG** and **Ollama**. Both take a base URL in addition
to (or instead of) an API key, and both drive their own prompt flow inside
`/web-tools` — URL first, then the optional key.

## SearXNG

[SearXNG](https://docs.searxng.org/) is a self-hosted metasearch engine. It
needs a base URL; the API key is optional and only used when the instance sits
behind a Bearer-auth reverse proxy.

```sh
export SEARXNG_URL=http://localhost:8080
# Optional: only if your instance sits behind a Bearer-auth reverse proxy
export SEARXNG_API_KEY=…
```

Base-URL resolution: `SEARXNG_URL` → `baseUrls.searxng` in the config file →
`http://localhost:8080`. When the resolved URL is empty, `web_search` throws
`SEARXNG_URL is not set. Run /web-tools to configure, or export the env var.`

### JSON output must be enabled

Your instance must have `json` listed under `search.formats` in `settings.yml`.
Default SearXNG installs ship with JSON disabled and return `403 Forbidden`
otherwise (see the
[SearXNG search API docs](https://docs.searxng.org/dev/search_api.html)). The
provider surfaces that case with an actionable hint appended to the error:

- `403` → *the SearXNG instance may have JSON output disabled; enable 'json'
  under 'search.formats' in its settings.yml*
- `401` → *the SearXNG instance's reverse-proxy rejected the Bearer token; check
  `SEARXNG_API_KEY` or `apiKeys.searxng`*

### Running SearXNG locally with Docker

The `searxng/searxng` entrypoint **overwrites** `/etc/searxng/settings.yml` on
first start with the bundled default (which ships `formats: [html]` only).
Pre-populating the mounted file does not stick — wait for the entrypoint, then
patch:

```sh
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

A `403` here means JSON is still disabled — re-check `~/.searxng/settings.yml`.
Works identically on Docker Desktop and OrbStack. For a throwaway test instance,
swap `~/.searxng` for `/tmp/searxng` and drop `--restart unless-stopped`.

### Fetching

SearXNG is search-only. `web_fetch` falls through to the built-in HTTP +
HTML-to-text pipeline, so URLs returned by `web_search` are readable with no
extra setup, and `raw: true` is honoured.

## Ollama

[Ollama](https://ollama.com) exposes web search and web fetch as built-in
capabilities. Local use needs no third-party key; cloud use requires one.

### Local

```sh
ollama serve
```

That is all — the provider talks to `http://localhost:11434` by default and no
API key is needed. If the instance is not running, the error is
`Could not connect to Ollama at <host>. Make sure Ollama is running (ollama serve).`

### Cloud

```sh
export OLLAMA_HOST=https://ollama.com
export OLLAMA_API_KEY=your_api_key   # generate at https://ollama.com/settings/keys
```

Or run `/web-tools`, select **Ollama**, and enter the URL and key interactively.

### Resolution

- **Base URL**: `OLLAMA_HOST` → `baseUrls.ollama` in the config file →
  `http://localhost:11434`. An empty resolved URL throws
  `OLLAMA_HOST is not set. Run /web-tools to configure, or export the env var.`
- **API key**: `OLLAMA_API_KEY` → `apiKeys.ollama` in the config file. Optional
  for local, required for cloud.

### API paths

The provider picks the endpoint pair from the resolved host, so you never set it
by hand:

| Host | Search path | Fetch path |
| --- | --- | --- |
| `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]` | `/api/experimental/web_search` | `/api/experimental/web_fetch` |
| anything else (cloud) | `/api/web_search` | `/api/web_fetch` |

Ollama is a full provider: `web_fetch` uses its native extraction endpoint
rather than the built-in HTML pipeline.

## Note on the host guard

`web_fetch` refuses private and loopback hosts, but that guard applies to URLs
fetched **on the model's behalf**, not to provider endpoints. A `SEARXNG_URL` or
`OLLAMA_HOST` pointing at `http://localhost` is intentionally reachable — these
providers are self-hosted by design. See
[tools.md](tools.md#host-guard) for the full guard.
