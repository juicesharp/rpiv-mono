# @juicesharp/rpiv-web-tools

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-web-tools.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/cover.png" alt="rpiv-web-tools — search the web, read the page" width="50%">
    </picture>
  </a>
</div>

Let the model answer from the live web instead of its training data.
`rpiv-web-tools` adds two tools to [Pi Agent](https://github.com/badlogic/pi-mono):
`web_search`, which queries a search API and returns titled results with URLs and
snippets, and `web_fetch`, which reads an http/https page as text. You pick one
of eleven backends with `/web-tools`. For local search, run SearXNG or a local
Ollama instance so queries stay on your network.

## Install

```sh
pi install npm:@juicesharp/rpiv-web-tools
```

Restart your Pi session.

## Quick start

`web_search` needs an active provider. Run:

```
/web-tools
```

Choose Parallel (no key) for hosted search without a Parallel API key, or select a provider that
requires credentials and paste its API key. SearXNG and Ollama prompt for a base
URL first. `brave` remains the default. The active provider is listed first with
`✓`, configured providers are marked `(configured)`, and Parallel is marked
`(no key)`. Parallel sends the search query and Pi conversation ID to its hosted
service. Its project/version `User-Agent` identifies `rpiv-web-tools` so Parallel
can measure aggregate free MCP usage; the header contains no per-user or
installation ID. See [Providers](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/providers.md) for request details.

Prefer environment variables? Export the provider's key instead and skip the
command entirely — [Providers](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/providers.md) has the variable name per backend:

```sh
export BRAVE_SEARCH_API_KEY=…
```

Then ask the model something that needs current information — it calls
`web_search`, then `web_fetch` on the URLs worth reading. `web_fetch` alone
works with no API key at all.

## What you get

- **Answers from the live web** — `web_search` returns 1–10 titled results with
  URLs and snippets per call, and the built-in guidance tells the model to cite
  a `Sources:` section with markdown hyperlinks.
- **Eleven backends, one switch, keys never lost** — Brave, Tavily, Serper, Exa,
  You.com, Jina, Firecrawl, Perplexity, Parallel, SearXNG and Ollama. Keys are
  stored per provider, so switching backends preserves every other one.
- **Compare backends without touching config** — pass `provider` on a single
  `web_search` call to route it elsewhere. No config write or restart; a target with missing required credentials throws instead of silently falling back.
- **Self-hosted search** — SearXNG and a local Ollama instance can keep search
  requests on your network, with their own base-URL resolution and setup flow.
- **Big pages don't blow up the context** — `web_fetch` truncates long bodies
  and writes the full text to a temp file the model can read on demand.
- **The model can't be tricked into probing your internal network** —
  `web_fetch` refuses non-http(s) protocols and private, loopback and metadata
  addresses.
- **GitHub links become repository content** — opt in, and a github.com URL
  returns a file tree, a directory listing, or a file's text from a cached
  shallow clone rather than the rendered HTML page.

## Configuration

`/web-tools` writes `~/.config/rpiv-web-tools/config.json` with mode `0600`
(the directory root follows `XDG_CONFIG_HOME` when it is set). Run
`/web-tools --show` to print the resolved config, with keys masked.

| Key | What it does | Default |
| --- | --- | --- |
| `provider` | Active search backend | `brave` |
| `apiKeys.<provider>` | Per-provider API key | none |
| `baseUrls.<provider>` | Instance URL for `searxng` / `ollama` | provider default |
| `interceptors.github` | Enables the GitHub URL interceptor | disabled |
| `guidance.<tool>` | Replaces the built-in tool guidance the model sees | built-in text |

Environment variables win over the file: `WEB_SEARCH_PROVIDER` pins the active
backend, and each provider's own key variable overrides `apiKeys` — see
[Providers](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/providers.md) for the variable name per backend. Provider and key
changes apply on the next tool call; guidance changes apply on the next session
start.

## Reference

- [Tool reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/tools.md) — full `web_search` / `web_fetch` schemas,
  result envelopes, dispatch order, truncation, and the host guard.
- [Providers](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/providers.md) — all eleven backends, their credential requirements and key variable names,
  plus the exact resolution order for the active provider, its
  key, and its base URL.
- [Self-hosted backends](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/self-hosted.md) — SearXNG and Ollama setup,
  including a working Docker recipe for SearXNG.
- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/configuration.md) — every config key, failure behaviour,
  guidance overrides, and the `/web-tools --show` output.
- [GitHub URL interceptor](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/github-interceptor.md) — opt-in forms, options,
  which URLs it handles, and how content is retrieved.

## Requirements

- **Node.js ≥ 22** and a running Pi Agent host.
- **An active search provider** before `web_search` works. Parallel supports
  anonymous hosted search without a key; credentialed providers need their own
  key, and SearXNG/Ollama need a reachable instance. SearXNG also needs `json`
  enabled under `search.formats`.
- **`gh` or `git`** — only for the opt-in GitHub URL interceptor. Nothing else
  in the package shells out.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `<ENV_VAR> is not set` on every search | The resolved provider has no key | Run `/web-tools`, or check `/web-tools --show` to see which tier set the active provider |
| SearXNG returns `403 Forbidden` | The instance has JSON output disabled | Add `json` under `search.formats` in its `settings.yml` — see [self-hosted.md](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/self-hosted.md) |
| `Could not connect to Ollama at <host>` | No Ollama instance at the resolved host | Start it with `ollama serve`, or set `OLLAMA_HOST` |
| `Unknown web_search provider: "…"` | A typo in `WEB_SEARCH_PROVIDER` or in the per-call `provider` argument | Use one of the eleven names in [providers.md](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/docs/providers.md) |
| `Unknown search provider: "…"` | A typo in `provider` in the config file | Run `/web-tools` to reselect, or fix the name in `config.json` |

## Related

- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) —
  the umbrella package; its `web-search-researcher` agent depends on these two
  tools.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-web-tools/LICENSE).
