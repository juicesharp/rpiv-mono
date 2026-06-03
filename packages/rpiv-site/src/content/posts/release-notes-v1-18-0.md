---
title: "Release notes: v1.18.0"
description: "Per-step model and reasoning-effort control lands in rpiv-pi via /rpiv-models, the workflow runner gains resume-by-run-id and cooperative cancellation, and the family settles on one provider/modelId key form."
pubDate: 2026-06-03T12:00:00Z
author: juicesharp
tags: ["release", "rpiv-pi", "rpiv-workflow", "rpiv-config", "rpiv-advisor"]
draft: false
---

Two threads in this one. rpiv-pi learns to spend model budget unevenly: which model runs each step, and how hard it reasons, is now configurable per skill, per stage, and per agent. And the workflow runner, which learned to resume a dead run in v1.17, now resumes one that died mid-fan-out or mid-iterate, and can be cancelled between stages. Underneath both, the family standardizes on a single model-key form.

> **Upgrade notes.**
> 1. **One breaking rename (embedders only).** rpiv-workflow's exported `WorkflowContext` type is now `WorkflowHostContext`. If you type host handles against it, update the import. No runtime behavior changed.
> 2. **Model keys moved to slash form.** Persisted keys are now `provider/modelId` (was `provider:modelId`). The colon form is still read and auto-migrates on the next save. Caveat: if you roll back across this release, re-run `/advisor` on the old version first, or the advisor silently disables itself (the older parser is colon-strict).
> 3. **Two new commands:** `/rpiv-models` to configure model/effort overrides, and `/wf @<run-id>` to resume a failed run.

## Right-size the model (rpiv-pi)

One global model is a blunt instrument: `research` synthesizes, `design` decides, `commit` writes a sentence, and the locator subagents barely reason at all. The new `/rpiv-models` command and its config file (`~/.config/rpiv-pi/models.json`) let you set both axes, model and reasoning effort, at four granularities:

- **Per-skill** (`skills.<name>`): follows a skill everywhere it runs, both as a workflow stage and as a standalone `/skill:<name>` you type yourself. Standalone overrides arm only on an explicit entry, so your session model stays sovereign otherwise.
- **Per-stage** (`stages.<name>`): keyed on the workflow graph position.
- **Per-preset stage** (`presets.<workflow>.stages.<stage>`): one stage of one bundled workflow, resolved ahead of the flat stage rule.
- **Per-agent** (`agents.<name>`): the research subagents, applied globally.

Most specific wins: preset-stage, then stage, then skill, then `defaults`.

Reasoning effort gained a first-class `off`. The vocabulary is now `off | minimal | low | medium | high | xhigh`, and **omitting** the field (inherit your session baseline) is distinct from **`off`** (disable reasoning); the effort picker offers both as separate choices. `/rpiv-models` ships full CRUD: a `✓` on every configured entry, per-entry reset, a gated reset-all, and a session-start warning when a key matches no real skill, stage, agent, or workflow.

One operational note: agent overrides live in agent frontmatter, written at sync time. A fresh session picks up your latest `agents.*` edits on its own, but to apply them mid-session (or to force them over an agent file you have hand-edited) run `/rpiv-update-agents`, which now re-reads `models.json` before syncing. The new [Right-size the model](/docs/guides/right-size-the-model) guide walks the whole thing.

## Resume and cancellation (rpiv-workflow)

The audited JSONL trail every run leaves behind is now fully resumable. `/wf @<run-id>` (or `resumeWorkflowByRunId` programmatically) replays the trail, rebuilds the accumulated state, and re-enters at the first stage that never completed, including a stage that died **mid-fan-out** or **mid-iterate**, where it re-pulls only the unfinished units. A looped stage resumes its trailing generation. Resume guards the one boundary it can check: if a `FanoutFn`/`IterateFn` recomputes a different unit list than the run recorded, it refuses rather than run the wrong unit, so a non-deterministic generator fails loudly.

Alongside it:

- **Cooperative cancellation.** Every options bag accepts an optional `signal: AbortSignal`. The runner checks it at each between-stage seam, records an `aborted` row for the stage about to run, and returns `{ success: false }`. It does not interrupt a stage already streaming; cancellation lands at the next stage boundary.
- **Two one-shot helpers.** `runWorkflowByName` and `resumeWorkflowByRunId` fold load, find, and run (or resume) into a single call. Both return a failure envelope and never throw on a bad name or unresolvable run-id.
- **Typed `STOP`.** The terminal-edge sentinel is re-exported from the package entry, so authors can write `edges: { commit: STOP }`; the bare `"stop"` literal still works.

See [Run a workflow](/docs/guides/run-a-workflow) for the resume command and the programmatic surface.

## One model-key form across the family

`modelKey` and `parseModelKey` are consolidated into `@juicesharp/rpiv-config` so every consumer shares one codec. The canonical form is `provider/modelId` (slash). Reads accept both separators and prefer slash when both are present; writes emit slash only, so persisted colon-form keys migrate the next time any consumer re-serializes. rpiv-advisor configs auto-migrate on the next `/advisor` save (mind the rollback caveat above).

## Fixes worth calling out

- **Stale extension context after auto-compaction** no longer produces spurious warnings or errors. This was a cross-package issue, fixed in rpiv-pi (guidance injection, git-context injection, model-override lifecycle), rpiv-btw, and rpiv-todo.
- **Startup no longer crashes** with a barrel-initialization race when loading rpiv-workflow.
- **Workflow model-override lifecycle** resets its baseline before restoring at `onWorkflowEnd`, so a failed restore can no longer leave the override armed and poison the next workflow.
- **`blueprint` / `design`** slice-overlap detection now partitions deterministically by file and symbol, cutting verification time further on large plans.

## On the site

rpiv-site shipped the new [Right-size the model](/docs/guides/right-size-the-model) guide, and refreshed [Run a workflow](/docs/guides/run-a-workflow), [Pick your path](/docs/guides/pick-a-path), and [Compose skills as skills](/docs/guides/compose-skills-as-skills) for the resume command, the typed `STOP` sentinel, the `IterateFn`/`FanoutFn` determinism contract, and the corrected `polish` count.

## Grab it

```sh
npm install @juicesharp/rpiv-pi@1.18.0
```

Or let your normal upgrade flow pick it up. Run `/rpiv-update-agents` once afterward if you configure per-agent models, and migrate any embedder that types against `WorkflowContext`.

See you at v1.19.0.
