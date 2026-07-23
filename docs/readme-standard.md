# README standard

How every README in this repo is written. One shape, so a reader who has read one
has read them all.

## The premise

A README is a **front door, not a manual**. It is the npm package page, the GitHub
landing page, and — increasingly — the first thing a coding agent reads before it
decides whether to install anything. All three audiences want the same first 30
seconds: *what is this, is it for me, how do I start.* None of them want the
authoring DSL in paragraph four.

The failure mode this standard exists to fix is the one these packages had: READMEs
that grew into reference manuals. Every fact in them was true and most were useful
to *someone*, but the person deciding whether to `pi install` had to read 400 lines
to find out. Reference material is not deleted — it moves to `docs/` where the
people who need it go looking, and the front door gets its job back.

## The split

| Goes in the README | Goes in `docs/` |
| --- | --- |
| What it is, who it's for | Complete option/flag reference |
| Install + restart | Full tool JSON schemas |
| The single shortest path to it working | Authoring guides, DSL specs |
| The 5–7 capabilities that make someone want it | Per-provider setup walkthroughs |
| The 3–5 config knobs most people touch | Step-by-step integration tutorials |
| Where the deep docs are | Architecture, internals, extension points |

A section belongs in the README only if a *first-time reader* needs it to get to a
working state. Everything a *returning* reader looks up belongs in `docs/`.

## Section order

Fixed. Do not reorder, do not invent new top-level sections, do skip any section
that would be empty or padding.

```
# <npm package name>
[badges: npm version, license]
[cover image]

<lede — 2–3 sentences>

## Install
## Quick start
## What you get
## Configuration      (only if user-configurable)
## Reference          (only if docs/*.md exist)
## Requirements       (only if non-obvious: native deps, runtimes, API keys)
## Troubleshooting    (only for failures users actually hit)
## Related            (only for real coupling to sibling packages)
## License
```

### `# <npm package name>`

The published name, `@juicesharp/rpiv-x` — that is what a reader searched for.
Badges go directly under the H1 (npm version, license), then the cover image.
Badges at the bottom of a page are decoration; at the top they are metadata.

### Lede

Two to three sentences, no heading. Sentence one: what it does, in the user's
vocabulary, not the codebase's. Sentence two: the mechanism, concretely — the
command, the tool, the surface it adds. Sentence three, if needed: who it's for or
what it pairs with. Link [Pi Agent](https://github.com/badlogic/pi-mono) on first
mention.

No marketing adjectives. "Powerful", "seamless", "blazing" are noise; a concrete
capability is the persuasion.

### `## Install`

The one command, plus the restart note. Nothing else.

````md
```sh
pi install npm:@juicesharp/rpiv-x
```

Restart your Pi session.
````

### `## Quick start`

The shortest complete path from installed to visibly working — ideally one command
and what the user sees happen. A screenshot here earns its place; a screenshot in
place of an explanation does not. If the package needs an API key or a model
selection before it does anything, that gate belongs here, not buried in
Configuration.

### `## What you get`

Five to seven bullets, bold lead-in then one sentence. Benefit first, mechanism
second: **Survives compaction** — state is rehydrated from the session file on
`/reload`, not held in memory. Not a feature list of every code path; the reasons
someone would install this over not installing it.

### `## Configuration`

The knobs most people touch, as a table: setting, what it does, default. Full
option surfaces go to `docs/`. State the config file path once, literally
(`~/.config/rpiv-x/config.json`), and any file-permission behavior.

### `## Reference`

A short linked list into `docs/`. One line each saying what the reader will find,
so nobody opens a file to find out whether it is the one they wanted.

### `## Troubleshooting`

Only real, reported, reproducible failures — symptom → cause → fix. An empty
Troubleshooting section is worse than none: it implies the package is fragile.

### `## License`

`MIT` and a link to `LICENSE`. One line.

## Rules

1. **Length ceiling.** Extensions ≤ 150 lines. The `rpiv-pi` umbrella ≤ 200. Over
   the ceiling means content belongs in `docs/`, not a smaller font.
2. **Every command runs as written.** Copy-pasteable, no placeholders that aren't
   obviously placeholders, no invented flags. If it isn't in the code, it isn't in
   the README.
3. **No restating `package.json`.** Version, dependency lists, and keywords are
   metadata the registry already renders.
4. **Tables for anything enumerable.** Config keys, providers, commands, flags.
   Prose for anything with a "because" in it.
5. **Absolute image URLs.** `https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/<pkg>/docs/<file>` — relative paths break on npm. Every image gets meaningful alt text.
6. **Second person, present tense.** "You pick a model with `/advisor`", not "the
   user may configure an advisor model".
7. **Facts only.** No aspirational features, no roadmap, no rationale essays. If a
   design decision needs defending, it is a `docs/` topic or a blog post.
8. **Sibling links are real links.** Cross-package references point at the npm
   package or the GitHub directory, never a bare name.

## What ships in the tarball

`docs/` holds two things with opposite economics, and they are packaged
differently:

| | Reference markdown | Cover and screenshot art |
| --- | --- | --- |
| Size | 4–6 KB each | 122–435 KB each |
| Version-sensitive | Yes — it documents this release's flags and defaults | No |
| How it is consumed | Read as a file | Fetched over HTTP by absolute URL |

The tarball is the *versioned* artifact; the repo is the rolling one. Docs that
describe a specific release belong pinned to that release, so every published
package with a `docs/` directory carries:

```json
"files": ["…", "docs/", "!docs/*.png", "!docs/*.jpg", "!docs/*.svg", "…"]
```

Markdown ships; art does not. Art is only ever referenced by absolute
`raw.githubusercontent.com` URL, so excluding it breaks nothing and drops ~92%
of the packed size on image-heavy packages. Pi materialises installs under
`~/.pi/agent/npm/node_modules/`, so the shipped markdown is reachable on disk.

Use the `docs/` + negation form, not a `docs/*.md` glob: `verifyShipManifest`
computes staleness with a literal `existsSync`, so a glob is flagged as a ghost
entry, while `!`-prefixed entries are skipped by both of its checks.

> [!NOTE]
> Known gap, deliberately unfixed: README links point at `/blob/main/`, so a
> reader pinned to an older version clicks through to current docs. The shipped
> tarball copy is version-correct, but nobody thinks to look for it. The fix —
> rewriting `main` to the version tag in `release.mjs` at publish time — is not
> worth building while one major is live and effectively everyone runs latest.
> Revisit when two majors are supported at once.

## Internal packages

`rpiv-config`, `test-utils`, `rpiv-site`, `rpiv-telemetry` are not consumer
installs. They get a short internal README instead — under 60 lines:

```
# <package name>

<one line: what it is and that it is internal to this repo>

## What it provides   (or ## Develop, for the site)
## Used by
## Conventions        (only if there are non-obvious ones)
```

No install section for anything that cannot be installed, no badges for anything
unpublished, no cover art.
