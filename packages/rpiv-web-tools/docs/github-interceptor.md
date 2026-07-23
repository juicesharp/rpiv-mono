# GitHub URL interceptor

An opt-in URL interceptor that makes `web_fetch` return real repository content
for github.com URLs — a file tree, a directory listing, or a file's text — via
`gh` or `git`, instead of the rendered HTML page.

**It is off by default.** Nothing in this document happens until you enable it.

## Enabling it

Two tiers. The user config file always wins over the programmatic default, and a
literal `false` at the config tier turns it off regardless of what a consumer
passed.

```json
// config file — end-user opt-in
{ "interceptors": { "github": true } }
```

```ts
// or per-consumer at registration time (user config still wins)
registerWebTools(pi, { interceptors: { github: true } });
```

Resolution, in order:

1. `interceptors.github` in the config file — `false` turns it off, `true` turns
   it on, an object turns it on unless it contains `"enabled": false`.
2. `registerWebTools(pi, { interceptors: { github: true } })`.
3. Otherwise off.

`/web-tools --show` prints the current state under `URL interceptors:` — either
`github: disabled` with the two config snippets that toggle it, or
`github: enabled` with the masked `GITHUB_TOKEN`, `maxRepoSizeMB`, and
`clonePath`.

## Options

Replace the boolean shorthand with an object to tune the defaults. The object
form implies opt-in.

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
| --- | --- | --- |
| `enabled` | `false` at the top level, `true` implied inside the object form | Master switch |
| `maxRepoSizeMB` | `350` | Repos larger than this skip the clone and use the API view |
| `cloneTimeoutSeconds` | `30` | Kill the clone process after this many seconds |
| `clonePath` | `$TMPDIR/pi-github-repos` | Where shallow clones land, one subdirectory per `owner/repo` (plus ref, when the URL pins one) |

## Which URLs it handles

Only `github.com` and `www.github.com` hosts, and only code-shaped paths:

| URL shape | Type | What `web_fetch` returns |
| --- | --- | --- |
| `/owner/repo` | root | File tree plus the README, and the local clone path |
| `/owner/repo/tree/<ref>/<path>` | tree | Directory listing for `<path>` |
| `/owner/repo/blob/<ref>/<path>` | blob | The file's text, truncated at 100K chars |

Everything else returns `null` and falls through to the normal `web_fetch`
pipeline untouched — including `/issues`, `/pull`, `/pulls`, `/discussions`,
`/releases`, `/wiki`, `/actions`, `/settings`, `/security`, `/projects`,
`/graphs`, `/compare`, `/commits`, `/tags`, `/branches`, `/stargazers`,
`/watchers`, `/network`, `/forks`, `/milestone`, `/labels`, `/packages`,
`/codespaces`, `/contribute`, `/community`, `/sponsors`, `/invitations`,
`/notifications`, `/insights`.

Binary files are reported by extension and size rather than dumped, and a path
that does not exist in the clone falls back to showing the repository root.
Clone-backed responses open with `Repository cloned to: <path>` and end with a
pointer back to it so the model can keep exploring with `read` and `bash`.
API-view fallbacks have no clone, and say so explicitly instead.

## How content is retrieved

1. **Cache hit** — a repo already cloned this session is reused. The cache key
   is `owner/repo@ref`, or bare `owner/repo` when the URL pins no ref. A clone
   that failed is evicted from the cache rather than remembered.
2. **SHA-pinned URLs** — a 40-hex ref skips cloning and uses the `gh api` view,
   with a note explaining why.
3. **Oversized repos** — when `gh` can report the repo size and it exceeds
   `maxRepoSizeMB`, the API view is used instead, with a note stating the repo
   size and the threshold. Raise `maxRepoSizeMB` if you want the clone.
4. **Shallow clone** — otherwise `--depth 1 --single-branch` into `clonePath`.
   A failed clone falls back to the API view.

## `gh` and `git`

The interceptor probes for the [`gh` CLI](https://cli.github.com) with
`gh --version`. When `gh` is present it clones through `gh repo clone` and can
use `gh api` for size checks, default branches, and the API view. When `gh` is
absent it prints once to stderr:

```
[rpiv-web-tools] Install `gh` CLI for better GitHub repo access including private repos.
```

and falls back to `git clone --depth 1 --single-branch`.

Authentication flows through `gh`'s own token precedence (`GH_TOKEN`,
`GITHUB_TOKEN`, `gh auth login`) — export `GITHUB_TOKEN` to reach private repos.
`rpiv-web-tools` itself reads `GITHUB_TOKEN` only to display it masked in
`/web-tools --show`; it never passes it to a request.

This is the only part of the package that shells out to an external binary.

## Security

The `web_fetch` host guard still runs **first**, so a URL with a private or
loopback host cannot bypass it by wearing a github.com-shaped path. See
[tools.md](tools.md#host-guard).
