# Providers and credential resolution

The eleven search backends `rpiv-web-tools` ships with, what each one needs, and the
exact order in which the active provider, its API key, and its base URL are
resolved.

## The eleven providers

One is active at a time. Switching backends never discards the other backends'
keys — they are stored per provider under `apiKeys.<name>`.

| Provider | `provider` name | Key env var | Sign up | `web_fetch` path |
| --- | --- | --- | --- | --- |
| Brave | `brave` | `BRAVE_SEARCH_API_KEY` | [brave.com/search/api](https://brave.com/search/api/) | built-in HTTP → text, honours `raw` |
| Tavily | `tavily` | `TAVILY_API_KEY` | [tavily.com](https://tavily.com) | native extraction (plain text) |
| Serper | `serper` | `SERPER_API_KEY` | [serper.dev](https://serper.dev) | built-in HTTP → text, honours `raw` |
| Exa | `exa` | `EXA_API_KEY` | [exa.ai](https://exa.ai) | native extraction (plain text) |
| You.com | `youcom` | `YOUCOM_API_KEY` | [you.com](https://you.com) | native extraction (markdown) |
| Jina | `jina` | `JINA_API_KEY` | [jina.ai/reader](https://jina.ai/reader) | native extraction (markdown) |
| Firecrawl | `firecrawl` | `FIRECRAWL_API_KEY` | [firecrawl.dev](https://firecrawl.dev) | native extraction (markdown) |
| Perplexity | `perplexity` | `PERPLEXITY_API_KEY` | [docs.perplexity.ai](https://docs.perplexity.ai/) | built-in HTTP → text, honours `raw` |
| Parallel | `parallel` | none | [Search MCP docs](https://docs.parallel.ai/integrations/mcp/search-mcp) (anonymous) | built-in HTTP → text, honours `raw` |
| SearXNG | `searxng` | `SEARXNG_API_KEY` (optional) | self-hosted — see [self-hosted.md](self-hosted.md) | built-in HTTP → text, honours `raw` |
| Ollama | `ollama` | `OLLAMA_API_KEY` (optional locally) | local or [ollama.com](https://ollama.com) | native extraction |

SearXNG and Ollama also take a base URL (`SEARXNG_URL`, `OLLAMA_HOST`) because
they talk to an instance you control. Both are covered in
[self-hosted.md](self-hosted.md).

Parallel uses the hosted Search MCP anonymously without an API key. The free
endpoint has lower rate limits and uses Fast mode by default. Only `web_search`
is routed to Parallel; `web_fetch` keeps the existing provider or generic HTTP
path. A Parallel search sends the full query as `objective`, a derived 3–6-word
`search_queries` phrase, the Pi conversation ID as `session_id`, and the
project/version `User-Agent` to Parallel. Parallel documents `session_id` as an
input for free-tier rate limiting and log correlation.

## Active provider

Four tiers, first match wins:

1. **The `provider` parameter on a single `web_search` call.** Validated against
   the eleven known names; an unknown name throws. When present, tiers 2–4 are not
   consulted at all.
2. **`WEB_SEARCH_PROVIDER`** environment variable. Trimmed; a whitespace-only
   value counts as unset. Validated *only when it is the resolving tier*, so a
   bogus value cannot defeat a valid per-call override — it throws on the next
   `web_search` that actually resolves through it.
3. **`provider` in the config file**, which is what `/web-tools` writes.
4. **`brave`**, the built-in default.

`/web-tools --show` prints the resolved name together with its source
(`env`, `config`, or `default`), so you can see which tier won.

An unknown name at tier 1 or tier 2 throws:

```
Unknown web_search provider: "bravo". Valid providers: brave, tavily, serper, exa, youcom, jina, firecrawl, perplexity, parallel, searxng, ollama.
```

Tiers 3 and 4 are not validated at resolution time — a typo in the config file
instead surfaces `Unknown search provider: "bravo"` from the provider factory on
the next `web_search`.

## API key

Resolved per provider, under whichever provider name won above. Three tiers,
first match wins:

1. **The provider's own environment variable** (`BRAVE_SEARCH_API_KEY`,
   `TAVILY_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `YOUCOM_API_KEY`,
   `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `PERPLEXITY_API_KEY`,
   `SEARXNG_API_KEY`, `OLLAMA_API_KEY`). The `parallel` provider bypasses this
   key resolution and does not read `PARALLEL_API_KEY`.
2. **`apiKeys.<provider>`** in the config file.
3. **Legacy top-level `apiKey`**, Brave only. It is auto-migrated into
   `apiKeys.brave` and deleted from the file on the next `/web-tools` save.

Every environment value is trimmed, so an empty or whitespace-only variable is
treated as unset and resolution falls through to the next tier.

There is **no cross-provider fallback**. If the resolved provider requires a key
and has none, the call throws:

```
EXA_API_KEY is not set. Run /web-tools to configure, or export the env var.
```

That is deliberate — an agent can detect the misconfiguration instead of
silently getting results from a backend it did not ask for.

## Base URL

Only consulted for providers that declare a base-URL environment variable
(SearXNG and Ollama today). Hosted providers short-circuit to the empty string.

1. The provider's base-URL environment variable (`SEARXNG_URL`, `OLLAMA_HOST`).
2. `baseUrls.<provider>` in the config file.
3. The provider's built-in default (`http://localhost:8080` for SearXNG,
   `http://localhost:11434` for Ollama).

`/web-tools --show` prints one `<provider> url: <resolved> (source: …)` line per
provider that declares a base URL.

## Picker markers

The `/web-tools` provider list is ordered with the active provider first, marked
`✓`. Providers that resolve to a key are suffixed `(configured)`. Parallel is
marked `(no key)`. For SearXNG and Ollama, `(configured)` means a base URL has
been set explicitly via
environment variable or config — the bare built-in default does not count,
because it only indicates the setting has never been touched.

## Related

- [tools.md](tools.md) — the `provider` parameter and its effect on resolution.
- [configuration.md](configuration.md) — where the config file lives and what
  every key does.
- [self-hosted.md](self-hosted.md) — SearXNG and Ollama setup.
