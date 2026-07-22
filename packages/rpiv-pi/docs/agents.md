# Bundled subagents

The 15 named specialists `@juicesharp/rpiv-pi` installs, what each one is for, and how
they get onto disk.

Skills dispatch these through the `Agent` tool — you do not invoke them directly. That
tool comes from [`@tintinweb/pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents)
(or the API-compatible `@gotgenes` fork), which `/rpiv-setup` installs. Without it the
parallel-analysis skills have nothing to dispatch to.

## Codebase specialists

| Agent | Purpose |
| --- | --- |
| `codebase-locator` | Finds *where* code lives — files, directories, components — and ranks the most load-bearing rows. A "super grep/find/ls"; reach for it instead of grepping twice. |
| `codebase-analyzer` | Traces one component end to end and reports its implementation details. |
| `codebase-pattern-finder` | Finds similar implementations and usage examples, with concrete code snippets to model after. |
| `integration-scanner` | The reverse-reference counterpart to `codebase-locator`: inbound references, outbound dependencies, config registrations, event subscriptions for a component. |
| `scope-tracer` | Bounds a research investigation. Sweeps anchor terms, reads 5–10 key files for depth, returns a Discovery Summary plus 5–10 dense numbered questions. `research` dispatches it in-band before analysis. |
| `precedent-locator` | Finds similar past changes in git history — commits, blast radius, follow-up fixes, and lessons from related artifacts. Use it to learn what went wrong last time. |

## Review and verification specialists

| Agent | Purpose |
| --- | --- |
| `claim-verifier` | Grounds each supplied claim against actual repository state and tags it Verified / Weakened / Falsified with a justification. |
| `diff-auditor` | Row-only patch auditor. Walks a patch against a caller-supplied surface list and emits `file:line \| verbatim \| surface-id \| note` rows — evidence only, no narrative or severity. |
| `peer-comparator` | Given `(new_file, peer_file)` pairs, tags each peer invariant Mirrored / Missing / Diverged / Intentionally-absent. Use when a new entity parallels an existing sibling. |
| `slice-verifier` | Adversarially audits a freshly generated slice before it is locked, catching forward references, cross-slice symbol mismatches, decision drift, and atomicity violations that a post-finalization reviewer cannot find. |
| `artifact-code-reviewer` | Walks each slice code fence in a finalized artifact against code quality, codebase fit, and actionability; one severity-tagged row per finding (`blocker`, `concern`, `suggestion`). |
| `artifact-coverage-reviewer` | Verifies every Verification Note and Precedent entry in a finalized artifact lands somewhere actionable — a success criterion or emitted code — and flags the ones that do not. |

## Artifact and web specialists

| Agent | Purpose |
| --- | --- |
| `artifacts-locator` | Discovers prior research, designs, plans, and reviews in `.rpiv/artifacts/`. The research equivalent of `codebase-locator`. |
| `artifacts-analyzer` | Deep-dives one research topic across `.rpiv/artifacts/`. The research equivalent of `codebase-analyzer`. |
| `web-search-researcher` | Researches information that only exists on the web, via deep search and fetch. Needs [`@juicesharp/rpiv-web-tools`](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools) for `web_search` / `web_fetch`. |

## How they reach disk

Agents are **not** registered through the Pi manifest. On first session load, rpiv-pi
copies them into `<agent dir>/agents/` — `~/.pi/agent/agents/` by default, or under
`PI_CODING_AGENT_DIR` if you set it. That location is user-global, so every project
shares one copy.

A manifest, `.rpiv-managed.json`, records a sha256 per managed file, which is what lets
the sync respect your edits:

| Situation at session start | What happens |
| --- | --- |
| File missing | Copied |
| File matches the bundled source | Left alone |
| Bundled source changed, your copy still matches the recorded hash | Updated automatically |
| Bundled source changed **and** your copy was edited | Flagged as pending; you get a banner asking you to run `/rpiv-update-agents` |
| File no longer bundled, unedited | Flagged as pending removal |

`/rpiv-update-agents` runs the same sync in force mode: it adds, updates, and removes
regardless of the recorded hash, so it **will** overwrite an rpiv-managed file you
edited. Files you added yourself are never touched. It also re-reads `models.json`
first, so per-agent `model` and `thinking` overrides land in the frontmatter on disk —
see [models-config.md](./models-config.md).

Manifest keys are allowlisted against path traversal: a single basename, no `/`, `\`,
`..`, or NUL, not absolute, and it must end in `.md`.

Older versions kept a per-project copy in `<cwd>/.pi/agents/`. That directory is cleaned
up all-or-nothing — only when a manifest exists, every managed file still matches its
source, and no unmanaged file is present.
