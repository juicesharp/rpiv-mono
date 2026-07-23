# Configuration reference

Where the config file lives, every key it accepts, how malformed values are
handled, and the full `/web-tools` command surface.

## File location

```
~/.config/rpiv-web-tools/config.json
```

The directory root is XDG-aware: when `XDG_CONFIG_HOME` is set to an absolute
path (or a `~`-prefixed one), the file is
`$XDG_CONFIG_HOME/rpiv-web-tools/config.json` instead. An unset, empty,
whitespace-only, or relative `XDG_CONFIG_HOME` is ignored and `~/.config` is
used.

**Legacy fallback is read-only and one-way.** If no file exists at the
XDG-resolved path, the always-`~/.config` location is read instead, so a config
written before you set `XDG_CONFIG_HOME` is still found. Writes always go to the
XDG-resolved path — nothing is copied back. A *malformed* file at the XDG path
does not fall back; it warns and yields an empty config.

The file is written with mode `0o600` (user read/write only). The chmod is
best-effort: some filesystems ignore it, and it never gates whether the save
succeeded. When the write itself fails, `/web-tools` says so explicitly rather
than claiming a save:

```
Failed to save Exa API key to ~/.config/rpiv-web-tools/config.json — disk write failed
```

## Keys

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `provider` | string | `"brave"` when absent | Active search backend. Tier 3 of 4 — see [providers.md](providers.md#active-provider) |
| `apiKeys` | `Record<string, string>` | `{}` | Per-provider key map, keyed by provider name |
| `baseUrls` | `Record<string, string>` | `{}` | Base URL per provider; only consulted for `searxng` and `ollama` |
| `apiKey` | string | unset | Legacy top-level Brave key. Migrated into `apiKeys.brave` and deleted on the next `/web-tools` save |
| `guidance.web_search.promptSnippet` | string | `"Search the web for up-to-date information"` | One-line description the model sees for `web_search` |
| `guidance.web_search.promptGuidelines` | string[] | 5 built-in lines | Usage rules the model sees for `web_search` |
| `guidance.web_fetch.promptSnippet` | string | `"Fetch and read content from a specific URL"` | One-line description the model sees for `web_fetch` |
| `guidance.web_fetch.promptGuidelines` | string[] | 4 built-in lines | Usage rules the model sees for `web_fetch` |
| `interceptors.github` | `boolean \| object` | absent → disabled | GitHub URL interceptor opt-in — see [github-interceptor.md](github-interceptor.md) |

Every key is optional, and unknown keys round-trip untouched — the file is never
rewritten to drop fields it does not recognise.

## Failure behaviour

The whole file degrades to an empty config rather than crashing the session when
it is missing, is not valid JSON, is a directory, or violates the schema
outright.

Guidance validation is independently fail-soft: an empty string, a wrong type,
or an empty array in any `promptSnippet` / `promptGuidelines` field silently
falls back to the built-in default for that field alone. The other fields are
unaffected.

## Executor guidance overrides

`promptSnippet` and `promptGuidelines` control what the model is told about each
tool. Note the per-tool nesting under `guidance.web_search` and
`guidance.web_fetch` — this differs from the flat `guidance` shape used by
single-tool siblings such as `rpiv-advisor` and `rpiv-todo`.

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

Each field is independent: omit one and its built-in default is kept.

**Guidance is read once, at registration time**, so guidance edits take effect
on the next Pi session start. Provider and key config, by contrast, is re-read
on every tool call — switching provider or key needs no restart.

## `/web-tools`

Description: *Configure the search provider and API key used by `web_search`*.

Running it with no arguments opens a provider picker (active provider first with
`✓`, already-configured providers suffixed `(configured)`), then prompts for
that provider's API key. Pressing Enter on an empty input keeps the existing key
while still persisting the provider switch. SearXNG and Ollama drive their own
flow instead: base URL first, then the optional key.

The command requires an interactive session; without one it reports
`/web-tools requires interactive mode` and does nothing.

### `--show`

The only flag. It prints the resolved configuration without changing anything:

- the config file path in use
- the active provider and which tier it came from (`env`, `config`, `default`)
- one line per provider: the resolved key masked as first four characters,
  `...`, last four characters — with the env-var and config-file values shown
  separately so you can see which one won. Unset values render `(not set)`
- one `<provider> url: <resolved> (source: …)` line for each provider that
  declares a base URL (SearXNG and Ollama)
- a `URL interceptors:` block reporting the GitHub interceptor's state

Any other argument is ignored and falls through to the interactive picker.

## Environment variables

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Config directory root; must be absolute or `~`-prefixed, else ignored |
| `WEB_SEARCH_PROVIDER` | Pins the active provider above the config file |
| `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `YOUCOM_API_KEY`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `PERPLEXITY_API_KEY`, `SEARXNG_API_KEY`, `OLLAMA_API_KEY` | Per-provider keys; win over `apiKeys.<provider>` |
| `SEARXNG_URL`, `OLLAMA_HOST` | Self-hosted base URLs; win over `baseUrls.<provider>` |
| `GITHUB_TOKEN` | Read only to display it masked in `/web-tools --show`; GitHub auth itself flows through `gh` |

All values are trimmed, so an empty or whitespace-only variable counts as unset.
