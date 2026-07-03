---
title: "rpiv 2.0: three pipelines, one design gate, parallel lanes"
description: "build is redefined as a sliced, panel-gated 19-stage pipeline with a verbatim goal artifact and one human design gate. Fanout units run as simultaneous Pi sessions under a live lane console. The /wf set slims to build, vet, polish."
pubDate: 2026-07-03T12:00:00Z
author: juicesharp
tags: ["release", "rpiv-pi", "rpiv-workflow", "rpiv-ask-user-question", "rpiv-web-tools", "rpiv-todo"]
draft: true
---

Two big moves earn the major version. `build` is redefined from the ground up: a sliced, panel-gated pipeline that captures your brief verbatim, designs slices in parallel, and pauses for one real design decision, at a consolidated design review. And the runner underneath it learns true parallelism: fanout units now run as simultaneous Pi child sessions, watched from a live lane console. Around them, the `/wf` set slims from six presets to three pipelines.

> **Upgrade notes.**
> 1. **In-flight runs don't survive the upgrade.** The state trail moved from v1 to v2 to hold parallel-fanout completions. A v1 trail is refused at resume with `version-mismatch` rather than mis-replayed. Finish or discard running workflows before upgrading.
> 2. **The `/wf` set is now `build`, `vet`, `polish`.** The `ship`, `arch`, and `pr-triage` workflow graphs are gone. The `pr-triage`, `revise`, `design`, and `plan` skills remain standalone via `/skill:<name>`. Bare `/wf <input>` now runs `vet` unless your config names a `default`.
> 3. **Review your `models.json` presets.** Overrides under `presets.ship`, `presets.arch`, and `presets["pr-triage"]` warn once and stop applying. A `presets.build` entry silently carries over to the redefined 19-stage build. If you tuned it for the old 7-stage chain, revisit it.
> 4. **The legacy `thoughts/shared/` auto-migration is removed.** Stragglers migrate by hand: `cp -r thoughts/shared/* .rpiv/artifacts/ && rm -rf thoughts/shared`.

## build, redefined (rpiv-pi)

`/wf build` now runs the pipeline previously prototyped as `carve`. Nineteen stages, three quality gates, one human design gate.

The run opens with a script stage, not a model. `goal` writes your brief to disk byte-for-byte. That file is the contract everything downstream is judged against: the plan and code panels grade completeness and correctness against it, and `validate` receives it as `--goal`. `research` grounds the brief in your codebase. `slice` then cuts it into independent vertical slices. You confirm the cut once. That confirmation freezes the coverage units the structure check conserves from then on.

The gates come in two kinds. `slice-check` is a program: dependency-cycle freedom plus coverage conservation, zero LLM calls. A re-slice may redistribute your brief across slices, but it can never pass by dropping a piece of it. `slice-grade`, `plan-grade`, and `code-grade` are fresh-context panels, one session per dimension: completeness, correctness, actionability, pattern-following, architecture-fit. Each gate has its own fix arm. `slice-fix` re-cuts with structural authority. `amend` repairs plans surgically from the verdicts. Verdicts fold with a severity floor, so a cosmetic nit can't stall a gate and a real blocker can't slip one.

Between the gates, everything fans out. `design-slice` runs one fresh session per slice, in dependency order. `subplan` merges designs per DAG cluster, then `plan` folds the sub-plans into one. `elaborate` writes implement-ready code per phase. A deterministic splice stitches it back into the plan, and the code gate re-grades the result. `implement` stays serial on purpose: applying one plan to one working tree is a patch series, not a race.

And one pause carries real judgment. `design-review` presents every slice's design in a single summary: approach, key interfaces, data types, file map. You accept, or you adjust. A contract-changing edit cascades to the changed contract's dependents before synthesis ever sees the designs. Elsewhere, questions reach you when the code can't decide (a research clarification, the slice-cut confirm, a genuine design fork), plus quick confirms before research writes its document and before commit lands.

## Parallel lanes (rpiv-workflow + rpiv-pi)

Fanout units now run **simultaneously**: one Pi child session per unit, in-process, scheduled in waves that respect each unit's declared dependencies. A lane console rides over the run. Its dock tracks every lane's progress and token spend in real time. You can step into any lane and watch its output live. When a lane asks a question, it reaches you through the console without halting the others. A per-command watchdog arms over child sessions, and a tool timeout routes to the soft-halt gate instead of an abort and redispatch.

`iterate` stays sequential by contract: each pass must see the plans the earlier passes wrote. A fanout can still opt down to `concurrency: 1` where its units mutate shared state. `implement` does exactly that.

Two smaller runner changes are worth knowing. A `fanin(name)` read modifier gives synthesize-shaped stages every accumulated unit of a channel instead of latest-wins, with a load-time nudge when a bare read points at a fanout channel. And resume reconstructs mid-fanout state under the new v2 trail, re-pulling only unfinished units.

## Fewer pipelines, on purpose

Six presets tried to ladder every scope. Three pipelines map to what you actually have in hand: a brief (`build`), a diff (`vet`), or an architecture review (`polish`). Small change in a big codebase? `/skill:discover` and `/skill:research` slice the search space. From there the change is cheap in chat, or with `/skill:blueprint`. And `/wf vet --staged` gives the diff a structured second pass when you want one.

## Around the family

- **rpiv-ask-user-question** renders its questionnaire in RPC hosts, the VSCode pendant included, instead of silently declining. Multi-select gains free-text input. The collapse shortcut is configurable.
- **rpiv-web-tools** adds a per-call provider override to `web_search`. The Exa fetch limit rises to 1M characters to match the live API.
- **rpiv-todo** makes the overlay's collapse height configurable via `maxWidgetLines`, and reports "No change" instead of a phantom "Updated #N" on no-effect updates.
- **rpiv-args** labels token-path skill arguments so a provided path is never read as empty input. This also fixes `validate` branching to its recent-plans list when handed a real plan path.

## Fixes

Pipeline skills are hidden from model auto-invocation: they're dispatched by pipelines and by you, not by a model's whim. `/skill:code-review` accepts a tree scope. `typebox` moved to `dependencies`, so standalone installs stop failing with `ERR_MODULE_NOT_FOUND`. Test files no longer ship in the npm tarball.
