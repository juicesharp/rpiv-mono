# Tool reference

Complete parameter schemas, result envelopes, and failure modes for the two tools
`rpiv-web-tools` registers: `web_search` and `web_fetch`.

## `web_search`

Registered as tool name `web_search`, label `Web Search`. Queries the active
search provider's API and returns titled results with URLs and snippets.

### Parameters

```ts
web_search({
  query: string,                    // required — natural-language query
  max_results?: number,             // 1-10, default 5
  provider?:                        // per-call override; see below
    | "brave" | "tavily" | "serper" | "exa" | "youcom" | "jina"
    | "firecrawl" | "perplexity" | "searxng" | "ollama",
})
```

`max_results` is **clamped**, not rejected: values below `1` become `1`, values
above `10` become `10`, and an omitted value becomes `5`.

### Result

```ts
{
  content: [{ type: "text", text: string }], // "**Search results for \"<query>\":**"
                                             // then a numbered list of
                                             // "**title**\n   url\n   snippet"
  details: {
    query: string,
    backend: string,                         // the provider that actually ran
    resultCount: number,
    results?: Array<{ title: string, url: string, snippet: string }>,
  }
}
```

When the provider returns zero results, the envelope collapses to
`content: [{ type: "text", text: 'No results found for "<query>".' }]` with
`details.resultCount = 0` and no `results` array.

### Throws

| Condition | Message shape |
| --- | --- |
| Resolved provider has no key | `EXA_API_KEY is not set. Run /web-tools to configure, or export the env var.` |
| Unknown provider name | `Unknown web_search provider: "<name>". Valid providers: brave, tavily, serper, exa, youcom, jina, firecrawl, perplexity, searxng, ollama.` |
| Provider API returns non-2xx | vendor-specific, with the status code |

### Per-call `provider` override

The optional `provider` parameter routes a single call to a different backend
without mutating persisted config and without a session restart. The named
provider must have its own credentials — the override does **not** inherit the
active provider's key, and an unconfigured target throws the usual `… is not
set` error rather than silently falling back, so the caller can detect the
misconfiguration.

An override also short-circuits the `WEB_SEARCH_PROVIDER` environment variable
entirely: that tier is neither read nor validated when an override is present,
so a bogus env var cannot defeat a valid per-call override. Full four-tier
resolution is documented in [providers.md](providers.md#active-provider).

Use it for provider comparison inside one session, or to retry against a second
backend when the active one returns poor results.

## `web_fetch`

Registered as tool name `web_fetch`, label `Web Fetch`. Reads an http/https URL
and returns its text.

### Parameters

```ts
web_fetch({
  url: string,                      // required — http or https only
  raw?: boolean,                    // true → raw response body; default false → text
})
```

### Result

```ts
{
  content: [{ type: "text", text: string }], // header block + body
  details: {
    url: string,
    title?: string,                 // <title> element, when present
    contentType?: string,
    contentLength?: number,         // from the Content-Length header
    truncation?: TruncationResult,  // present only when the body was truncated
    fullOutputPath?: string,        // temp file holding the un-truncated body
  }
}
```

The text content is prefixed with a header block before the body:

```
**Fetched:** <url>
**Title:** <title>
**Content-Type:** <content-type>
```

### Dispatch order

`web_fetch` resolves the body through three tiers, first hit wins:

1. **URL interceptors** — currently only the opt-in GitHub interceptor, which
   returns `null` for anything that isn't a github.com code URL. The chain is
   empty when the interceptor is disabled. See
   [github-interceptor.md](github-interceptor.md).
2. **The active provider's native fetch** — Tavily, Exa, You.com, Jina,
   Firecrawl and Ollama carry vendor extraction endpoints.
3. **The built-in HTTP + HTML-to-text pipeline** — used for search-only
   providers (Brave, Serper, Perplexity, SearXNG) and whenever the active
   provider has no `fetch` method. This path needs no API key at all, so
   `web_fetch` still works when the active provider is an unkeyed search-only
   backend. An unkeyed extraction provider (Tavily, Exa, You.com, Jina,
   Firecrawl) throws instead, because its native fetch runs first and never
   reaches this tier.

`raw: true` is honoured by tier 3 (raw response instead of extracted text).
Extraction providers always return their own parsed text.

### Truncation and spillover

Bodies are truncated to 2000 lines / 50 KB. When truncation occurs the **full**
body is written to a temp file under `$TMPDIR/rpiv-fetch-XXXXXX/content.txt`,
the path is recorded in `details.fullOutputPath`, and a footer is appended to
the content telling the model exactly what was omitted:

```
[Content truncated: showing 64 of 988 lines (3.2 KB of 61.4 KB).
 924 lines (58.2 KB) omitted. Full content saved to: /tmp/rpiv-fetch-Xa0k/content.txt]
```

The model can then read the temp file to recover the rest.

### Host guard

`web_fetch` parses the URL and refuses it before any network call when the
protocol is not `http:`/`https:`, or when the host literal falls in a
private/loopback range:

| Class | Refused hosts |
| --- | --- |
| Loopback / unspecified | `localhost`, `*.localhost`, `0.0.0.0/8`, `127.0.0.0/8`, `::1`, `::` |
| RFC 1918 | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` |
| Link-local | `169.254.0.0/16` (including cloud metadata at `169.254.169.254`), `fe80::/10` |
| IPv6 unique-local | `fc00::/7` (`fc…`, `fd…`) |

Refusals surface as `Refusing to fetch private/loopback address: <host>`. The
guard runs **before** the interceptor chain, so a private host cannot bypass it
via a github.com-shaped path.

The guard is **host-literal only** — it does not resolve DNS and does not
validate redirects. A public hostname that resolves to a private IP, or a public
URL that 302-redirects to one, still reaches the target. For untrusted
automation environments, layer an egress proxy or firewall on top.

The guard applies to URLs `web_fetch` retrieves on the model's behalf, not to
provider endpoints: a `SEARXNG_URL` or `OLLAMA_HOST` pointing at
`http://localhost` is intentionally reachable.

### Throws

Invalid URL, unsupported protocol, a refused private/loopback host, a non-2xx
response, or an `image/` / `video/` / `audio/` content type. Extraction
providers additionally throw on an empty body or a vendor-level failure (for
example Firecrawl `success: false`, Tavily `failed_results`).
