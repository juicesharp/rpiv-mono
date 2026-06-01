---
title: "Release notes: v1.16 → v1.17"
description: "rpiv-workflow grows the two primitives a chain needs to build on itself (sequential `iterate` and raw-text `prompt` stages), and rpiv-pi's new `polish` workflow puts both to work. Then v1.17 consolidates workflow config into `.rpiv/workflows/` (breaking), adds `skillAliases`, sharpens the design/blueprint checkpoint, and lands You.com + Perplexity search providers."
pubDate: 2026-06-01T17:00:00Z
author: juicesharp
tags: ["release", "rpiv-workflow", "rpiv-pi", "rpiv-web-tools", "rpiv-config"]
draft: false
---

Two minors in one note. v1.16 and v1.17 are a single arc told in
two halves: first the runtime grows the primitives a workflow needs
to build on its own output, then the family settles them into place:
a breaking config consolidation, a declarative skill-swap seam, a
tighter developer checkpoint, and two new search providers. If you
skipped straight from the [v1.15.0 notes](/blog/release-notes-v1-15-0),
this is everything since.

> **Upgrade notes, both at once.**
> 1. **v1.17 moves workflow config.** Project workflow files relocate
>    from `.rpiv-workflow/` to a unified `.rpiv/workflows/` tree. There
>    is no legacy fallback; the new paths are the only ones read. The
>    `mv` commands are below, and a load-time warning points at them if
>    you forget.
> 2. **Refresh the bundled agents.** v1.17.1 narrows the
>    `web-search-researcher` agent's tool grant. Run
>    `/rpiv-update-agents` inside a Pi session to pick it up.
> 3. **Still on the pre-1.14 layout?** If `/wf` reports a missing
>    `@juicesharp/rpiv-workflow` sibling, run `/rpiv-setup`.

## v1.16: the two primitives a chain needs to build on itself

The workflow runtime that shipped in v1.14 could chain skills,
branch on typed output, and loop on a gate. What it couldn't do was
let a stage build on its *own* prior output within one run. v1.16
adds the two primitives that close that gap, and a bundled workflow
that needs both.

**`iterate`: sequential accumulation, the dual of `fanout`.** A
`fanout` stage computes every unit up front and runs them blind to
one another, the right shape when the units are independent (one Pi
session per `## Phase N:` heading of a plan, say). `iterate` is the
other half: the runner calls your `IterateFn` one unit at a time and
feeds each call the validated outputs of every prior unit in the same
stage. Return the next unit, or `null` to terminate. Each unit runs
the stage's `outcome` collector exactly like a one-shot `produces`
pass, so every unit publishes into the same named slot and the next
unit can read it.

```ts
import type { IterateFn } from "@juicesharp/rpiv-workflow";

// one pass per review phase, each seeing the plans
// the earlier passes already wrote
const perPhase: IterateFn = ({ artifact, accumulated, index, cwd }) => {
  if (artifact?.handle.kind !== "fs") return null;
  const phases = readPhases(artifact.handle.path, cwd);
  if (index >= phases.length) return null; // terminator
  const prior = accumulated.flatMap((o) => o.artifacts).map(pathOf);
  return {
    prompt:
      `${artifact.handle.path} Phase ${phases[index].n}` +
      (prior.length ? `\nPrior plans: ${prior.join(", ")}` : ""),
    label: `phase ${index + 1}/${phases.length}`,
    id: `phase-${phases[index].n}`, // stable audit key
  };
};

produces({ outcome: rpivBucketOutcome("plans"), iterate: perPhase });
```

`iterate` requires `kind: "produces"` and an `outcome` with a `name`;
every unit accumulates into one slot. It's mutually exclusive with
`fanout` and script `run`, incompatible with
`sessionPolicy: "continue"` (each unit needs its own clean session),
and backstopped by a run-wide `maxIterations` cap (default 32).

**`prompt`: raw text straight to the model.** Alongside the two
existing dispatches, a skill (`/skill:<name>`) and a script (`run:`),
a stage can now carry `prompt: string | PromptFn`, sending
author-owned text as the user message with no skill body and no
skill-registry check. Prefer the typed builders `produces.prompt({…})`
/ `acts.prompt({…})`: they structurally omit `skill`/`run`/`fanout`/
`iterate`/`reads`, so an invalid combo fails to *compile* rather than
only failing load validation.

The sharp use is the `continue` follow-up: a prompt stage that sends
a turn into a session a prior stage already populated, *without*
re-invoking a skill. It's the only honest way to build on a stage
whose output is conversation-only (a `frontend-design` pass that
emits no artifact, for instance) where the downstream step leans on
the shared context.

> **When not to.** Prompt text in a workflow definition isn't
> versioned, localized, or independently testable the way a
> `SKILL.md` is. Keep prompt stages short and glue-like; anything
> reusable belongs in a skill.

**`polish`: the workflow that needs both.** rpiv-pi 1.16.0 ships a
new bundled chain for a large architecture review that can't be
planned in one pass:
`architecture-review → blueprint (iterate) → implement (fanout) →
validate → code-review → commit`. Three moves make it work, and each
leans on a v1.16 primitive:

- **`blueprint` iterates** over the review's phases. Phase 3's plan
  sees phases 1 and 2. Where `fanout` would plan every phase blind,
  `iterate` hands each pass the plans the earlier passes wrote, with
  the instruction to build on them rather than duplicate.
- **`implement` fans out** over every plan the blueprint pass
  accumulated: push decomposition, because implementing one phase
  doesn't depend on another.
- **`validate` is a `prompt` stage, and it has to be.** A plain
  positional arg would hand `validate` only the *last* plan, leaving
  the earlier phases unvalidated. The prompt stage owns its whole
  message, so it reaches into the accumulation and builds a
  `/skill:validate <p1> <p2> …` call over *every* plan from the
  latest blueprint pass.

The review loop routes on the same `{ blockers_count }` schema as
`build`, but the backward edge returns to `blueprint`: a corrective
pass re-plans every phase with the blockers folded in, under the same
`maxBackwardJumps` bound. The new
[Compose skills as skills](/docs/guides/compose-skills-as-skills)
guide walks the whole thing as the iterate-plus-prompt capstone,
including the four-questions authoring protocol.

**v1.16.1** is the install-hardening patch that always tails a new
file: `iterate.ts` was git-tracked but missing from the published
`files` allowlist, so an npm install shipped `stage-lifecycle.ts`
without the `../iterate.js` it imports. Source builds and CI passed
because the file was on disk, which is exactly why it slipped
through. Fixed.

## v1.17: settling the primitives into place

With the primitives landed, v1.17 is about making them livable: where
the config lives, how you reuse a bundled chain without forking it,
and how the design loop decides what to ask you.

### The workflow config tree moved (breaking)

Project workflow config consolidates from `.rpiv-workflow/` into the
unified `.rpiv/workflows/` tree, with the three concerns each in their
own subfolder:

```sh
mkdir -p .rpiv/workflows
mv .rpiv-workflow/workflows.config.ts .rpiv/workflows/config.ts
mv .rpiv-workflow/workflows            .rpiv/workflows/packs
# run state: .rpiv/workflows/<run-id>.jsonl → .rpiv/workflows/runs/<id>.jsonl
```

The user layer aligns for symmetry:
`~/.config/rpiv-workflow/{config.ts, packs/}`. These are the **only**
locations read; no legacy fallback. Load-time warnings (advisory,
never blocking) fire on a stale project `.rpiv-workflow/` directory,
orphaned top-level `*.jsonl` run files, or a legacy
`~/.config/rpiv-workflow/workflows.config.ts`, each pointing at its
`mv`.

> **The gitignore gotcha.** `.rpiv/workflows/` is *commonly
> gitignored* because it holds ephemeral run state, which means the
> moved `config.ts` and `packs/` may be **silently uncommittable**.
> `git add .rpiv/workflows/config.ts` becomes a no-op with no error.
> If you version-control your workflow config, un-ignore the config
> surface, e.g. add `!.rpiv/workflows/config.ts` and
> `!.rpiv/workflows/packs/` to `.gitignore`. The overlay warning now
> carries this advisory inline.

One API rename rides along: the public `workflowsDir` export is now
`runsDir` and points at `.rpiv/workflows/runs` (was
`.rpiv/workflows`). Update any direct importers.

### `skillAliases`: reuse a bundled chain, swap one skill

You often want a bundled chain (`ship`, `build`, `arch`, `vet`,
`polish`) exactly as shipped, but with one skill swapped for your
own. The canonical case is model attribution on commits: a team
authors an `attributed-commit` skill and wants *every* chain to use
it. Forking five workflow definitions to change one stage is the
wrong move; they'd drift on the next upgrade.

`skillAliases` is the seam. One declarative entry in `config.ts`
remaps a skill name across **every** loaded workflow (built-in,
user, and project) at load time:

```ts
// .rpiv/workflows/config.ts
export default { skillAliases: { commit: "attributed-commit" } };
```

Now every stage that would dispatch `/skill:commit` dispatches
`/skill:attributed-commit`, and the bundled definitions stay
byte-for-byte untouched and upgrade-safe. It keys on the skill name
(`stage.skill ?? <stage key>`), so it catches both implicit and
explicit-`skill:` stages; it's one hop only (no transitive chains);
`run`/`prompt` stages are skipped; project overrides user per key.
It's visible, not magic: `/wf` previews a
`Skill aliases in effect: commit → attributed-commit` banner, and an
alias key matching no dispatched skill anywhere surfaces a load-time
warning. An alias-only `config.ts` with no `workflows` block is now
valid; packs still reject the envelope, keeping `default` and aliases
one-source-of-truth-per-layer.

### A sharper design/blueprint checkpoint

rpiv-pi 1.17.0 splits the developer checkpoint in `design` and
`blueprint` into two tiers. **Directional decisions**
(extend-vs-replace, propagate-a-pattern, spread-a-convention) now get
a single batched confirm at Step 4, separate from genuine
ambiguities. "Follow the pattern" is offered without a Recommended
badge; choosing "move off" promotes the finding to a one-at-a-time
genuine question. And every slice now renders a mandatory **Fit**
line at Step 6.3 (`reused` / `new surface` / `convention`)
regardless of the omit list, so you always see how a slice relates to
what's already there.

### Two new search providers

rpiv-web-tools 1.17.1 adds two:

- **You.com**: a `FullProvider` backed by You.com's Search API
  (`POST /v1/search`) and Contents API (`POST /v1/contents`), returning
  native markdown (`contentType: "text/markdown"`). `web_fetch` uses
  the Contents API for clean extraction, the same path as
  Jina/Firecrawl. Configure via `YOUCOM_API_KEY` or `apiKeys.youcom`.
- **Perplexity**: a search-only `SearchProvider` posting to
  `POST https://api.perplexity.ai/search`. `web_fetch` falls through
  to the shared raw-HTTP + htmlToText pipeline (the Brave/Serper/
  SearXNG path). Configure via `PERPLEXITY_API_KEY` or paste the key
  through `/web-tools`. $5/1K requests, 50 RPS.

### Fixes worth calling out

- **Clean `npm install @juicesharp/rpiv-pi` no longer crashes** when
  the `@juicesharp/rpiv-workflow` peer is absent. Built-in workflow
  registration is now deferred behind a guarded dynamic import, so
  `/rpiv-setup` and the missing-siblings banner always load and can
  offer to install the sibling. (1.17.0)
- **`web-search-researcher` agent tool-gating.** Under `pi-subagents`
  0.10 the bundled agent now selects only `web_search` and `web_fetch`
  instead of exposing the full `rpiv-web-tools` surface. Run
  `/rpiv-update-agents` to refresh. (1.17.1)
- **Slice verification skips cross-slice walks** for slices that share
  no files or symbols, cutting verification time on large `blueprint`
  / `design` plans. (1.17.1)
- **rpiv-workflow loader hardening**: a present-but-non-array
  `workflows` field is now a load error instead of a `TypeError`,
  restoring the "loader never throws" contract; and the in-product
  legacy-migration shell now creates the destination directory and
  globs `packs/*.ts` correctly. (1.17.0)

## On the site

rpiv-site 1.17.0 shipped the
[Compose skills as skills](/docs/guides/compose-skills-as-skills)
authoring guide, the producer's tour to match the consumer's
[Run a workflow](/docs/guides/run-a-workflow), documenting the
four-questions protocol, the three dispatch modes, and the
fanout/iterate split through the `polish` walkthrough. Docs now
reference the unified `.rpiv/workflows/` paths and `skillAliases`,
the blogroll rows are fully clickable, and the agent carousel got
working drag and keyboard navigation.

## Anything else?

Every other package in the `@juicesharp/rpiv-*` family rode the
lockstep bump to 1.17.1 with no user-visible changes. `rpiv-advisor`
gained fuzzy type-to-filter in its model and reasoning-level pickers
(1.16.0), and `rpiv-warp` fixed a stale "Waiting for your answer"
badge left behind when ESC refuses a blocking prompt (1.16.0).

Grab the new version the usual way:

```sh
npm install @juicesharp/rpiv-pi@1.17.1
```

Or let your normal upgrade flow pick it up, then run
`/rpiv-update-agents` once for the agent tool-gating fix, and migrate
your workflow config if you keep one. The full per-package changelog
lives in each package's `CHANGELOG.md` in the
[monorepo](https://github.com/juicesharp/rpiv-mono).

See you at v1.18.0.
