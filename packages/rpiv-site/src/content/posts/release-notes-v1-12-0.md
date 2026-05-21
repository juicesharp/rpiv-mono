---
title: "Release notes: v1.12.0"
description: "rpiv-web-tools learns to talk to your own search engine: a self-hosted SearXNG provider, a new shape for the provider factory, and a sharper line between SSRF for fetch and loopback for search."
pubDate: 2026-05-21T15:00:00Z
author: juicesharp
tags: ["release", "rpiv-web-tools"]
draft: false
---

v1.12.0 is a single-package story. `rpiv-web-tools` already spoke
six hosted search engines after v1.8.0 — Brave, Tavily, Serper, Exa,
Jina, and Firecrawl. v1.12.0 adds the first one you can host
yourself: [SearXNG](https://docs.searxng.org/). With it comes a
small but real reshaping of how providers receive their
configuration, and a clearer story about which SSRF rules apply
where.

## A self-hosted seventh provider

The new `searxng` provider plugs into the same `SearchProvider`
contract as the six hosted vendors. It reuses the shared HTTP +
`htmlToText` pipeline that Brave and Serper already go through, so a
SearXNG result with no native extraction endpoint still comes back
as readable text rather than raw HTML.

Configure it the usual two ways: `SEARXNG_URL` in the environment,
or `baseUrls.searxng` in `~/.config/rpiv-web-tools/config.json`. The
default is `http://localhost:8080`, which is what you get out of the
box from the official Docker image. If your instance sits behind a
Bearer-auth proxy, set `SEARXNG_API_KEY` or `apiKeys.searxng` — the
provider attaches the header without you having to think about it.

The `/web-search-config` picker has learned the new shape too. When
you select `searxng` it asks for the URL first, then offers the
optional API key as a second prompt; either submitted empty
preserves whatever you already had.

## The factory grew a baseUrl slot

Six hosted providers each need exactly one secret. SearXNG needs an
address, optionally a key, and nothing else. The old factory
signature couldn't carry both:

```ts
// before
createSearchProvider(name, apiKey: string)

// after
createSearchProvider(name, creds: { apiKey?: string; baseUrl?: string })
```

The six hosted providers still receive their key transparently via
`creds.apiKey`, so internal call sites all flipped over in one
mechanical pass. Direct downstream callers — if you import
`createSearchProvider` yourself rather than going through the
extension's tool surface — will need the options-bag form. The
changelog calls this out under **Breaking / Upgrade Notes** for
anyone reading the diff.

## SSRF for `web_fetch`, loopback for search

The interesting tension with a self-hosted provider is that
`http://localhost:8080` is *exactly* the kind of URL the SSRF guard
in v1.8.0 was designed to refuse. v1.8.0 taught `web_fetch` to
reject loopback, RFC1918, link-local, and unique-local IPv6 — so a
search result that resolves to your dev server or the cloud
metadata endpoint can't be fetched through the agent.

That guard still applies to `web_fetch`. It does *not* apply to the
search endpoint itself, because the whole point of a self-hosted
instance is that you reach it at `localhost`. The README now spells
this asymmetry out explicitly: search talks to a server you trust
and chose to run; fetch talks to URLs the search result hands back,
which you don't.

## Hardening the new edges

Two small fixes landed alongside the feature, both from looking at
what could go wrong at the URL boundary:

- The provider now rejects non-HTTP schemes at construction time
  rather than letting them propagate into the request layer, and
  strips trailing slashes so `http://host:8080/` and
  `http://host:8080` resolve identically.
- A `401` from the instance attaches a dedicated hint about
  auth-proxy rejections, the same way a `403` already hinted that
  `json` likely needs to be added to `search.formats` in
  `settings.yml` — the most common SearXNG misconfiguration when
  the agent first tries to query an instance that was set up for
  humans, not for JSON consumers.

## Running SearXNG locally

The README picked up a short Docker recipe for spinning up an
instance with persistent settings. Two surprises worth knowing about
if you're building it yourself: the upstream `searxng/searxng`
image uses an entrypoint that needs a writable `/etc/searxng`
volume, and the `json` format isn't on by default. The recipe in
the README handles both, and the changelog notes them as a heads-up
for anyone copy-pasting from the official docs.

## Anything else?

Every other package in the `@juicesharp/rpiv-*` family bumped to
1.12.0 with no user-visible changes — the standard lockstep ride.
A second commit refactored the per-provider config plumbing onto a
`ProviderMeta` dispatch table; that's a code-shape change with no
behavior delta, but it's why adding the eighth provider, whenever
it shows up, will be a much smaller diff than this one.

Grab the new version the usual way:

```sh
npm install @juicesharp/rpiv-pi@1.12.0
```

Or let your normal upgrade flow pick it up. The full per-package
changelog lives in each package's `CHANGELOG.md` in the
[monorepo](https://github.com/juicesharp/rpiv-mono).

See you at v1.13.0.
