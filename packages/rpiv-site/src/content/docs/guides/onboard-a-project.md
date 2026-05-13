---
title: "Onboard a project"
description: "Map a brownfield codebase for the agent before running the pipeline."
section: "guides"
order: 4
---

Before you run the pipeline against an existing codebase for the first time, give the agent a map of how the project is shaped. The annotation skills do this in one pass, in parallel, and you don't run them again until the architecture changes meaningfully.

## Three annotation paths

| Skill | Where it writes | When to pick it |
|---|---|---|
| [`annotate-guidance`](/docs/reference/skills/annotate-guidance) | `.rpiv/guidance/<mirror of source tree>/architecture.md` | **Default for most teams.** The guidance lives in a shadow tree, gitignored or not at your discretion, and stays out of the way of source files. This is what `rpiv-mono` itself uses. |
| [`annotate-inline`](/docs/reference/skills/annotate-inline) | `CLAUDE.md` next to each relevant directory of source | When you'd rather have the per-directory guidance sitting beside the code so reviewers see it in PRs, or when you're already on the inline `CLAUDE.md` convention. |
| [`migrate-to-guidance`](/docs/reference/skills/migrate-to-guidance) | Moves existing `CLAUDE.md` files into `.rpiv/guidance/` | One-shot conversion when you started with `annotate-inline` and want to switch to the shadow-tree layout. Use `--delete-originals` to clean up the source-side files in the same pass. |

## What you get

Both annotation skills auto-detect the architecture (monorepo vs single package, framework signals, language stack) and batch-write compact files at the root plus each layer that earns its own page. The output is **short, opinionated, and tuned for the agent to load on demand**, not encyclopedic documentation.

## When to re-run

You don't annotate before every feature. Run it once on first contact with the codebase, then re-run it (or update specific files by hand) when a major refactor changes the architecture.

## Next steps

- [Pick your path](/docs/guides/pick-a-path): now that the agent has a map, choose the workflow for your feature
- [Walk the chain](/docs/guides/first-skill-chain): the mid-size path demonstrated end-to-end
