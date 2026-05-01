# rpiv-web-tools

<a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools">
  <picture>
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/cover.png" alt="rpiv-web-tools cover" width="100%">
  </picture>
</a>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-web-tools.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Let the model search the web and read pages. `rpiv-web-tools` adds `web_search` and `web_fetch` tools to [Pi Agent](https://github.com/badlogic/pi-mono), backed by the Brave Search API, plus `/web-search-config` for interactive API-key setup.

![Brave Search API key prompt](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/config.jpg)

## Features

- **Brave-backed search** — 1–10 ranked results per query with title and snippet.
- **Read any URL** — fetch http/https pages, strip HTML to text, or get the raw HTML with `raw: true`.
- **Large-page spillover** — oversized responses truncate inline and spill the full body to a temp file the model can read on demand.
- **Interactive setup** — `/web-search-config` writes the key to `~/.config/rpiv-web-tools/config.json` (chmod 0600); env var `BRAVE_SEARCH_API_KEY` also works.

## Install

```bash
pi install npm:@juicesharp/rpiv-web-tools
```

Then restart your Pi session.

## Tools

- **`web_search`** — query the Brave Search API and return titled snippets.
  1–10 results per call.
- **`web_fetch`** — fetch an http/https URL, strip HTML to text (or return raw
  HTML with `raw: true`), truncate large responses with a temp-file spill for
  the full content.

## Commands

- **`/web-search-config`** — set the Brave API key interactively. Writes to
  `~/.config/rpiv-web-tools/config.json` (chmod 0600). Pass `--show` to see
  the current (masked) key and env var status.

## API key resolution

First match wins:

1. `BRAVE_SEARCH_API_KEY` environment variable
2. `apiKey` field in `~/.config/rpiv-web-tools/config.json`

## License

MIT
