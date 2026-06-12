# Roadmap

rpiv-mono builds one thing: a pipeline that keeps an experienced driver meaningfully in the loop while the work moves at LLM speed. Models produce correct code; they don't yet produce *aligned* code — diffs that fit a codebase's unwritten conventions, stay reviewable, and don't quietly erode the architecture. Closing that gap takes a human steering at the right moments. Everything here exists to structure that steering: ask the right question at the right time, surface architectural decisions where they matter, verify before advancing, and do it fast enough that the driver stays in flow.

This document is the structured, directional companion to the [README's Roadmap section](./README.md#roadmap), which carries the longer philosophy. It is weighted toward the two core packages — **rpiv-pi** (the skill pipeline) and **rpiv-workflow** (the engine that chains it) — and covers the rest of the monorepo more lightly. No dates, no version targets, no tracking. Items move from one section to the next as they ship.

## What's Done

The repo went from a first public cut to a mature pipeline in roughly six weeks, lately at a dozen-plus releases inside a fortnight. What that cadence produced:

- **The rpiv-pi skill pipeline.** A library of around twenty composable skills covering the full arc — `discover` → `research` / `design` / `blueprint` → `plan` → `implement` → `validate` → `code-review` → `commit`, plus handoff, annotation, and frontend skills. Skills carry declared `produces`/`consumes` contracts in their frontmatter, so a workflow can derive routing and validate stage-to-stage compatibility automatically.
- **Fifteen named subagents.** A library of read-only specialists (locators, analyzers, reviewers, comparators, verifiers) that skills fan out to for parallel analysis under fresh context.
- **Six built-in workflows.** `ship`, `build`, `arch`, `vet`, `polish`, and the read-only `pr-triage` — each a pre-wired `/wf` chain over the skills above, contract-driven where the plan's phases drive the fan-out.
- **Per-skill and per-stage model control.** A model-management subsystem (`/rpiv-models`, `models.json`) lets the driver assign model and reasoning effort per agent, per workflow stage, and per skill — the lever that makes affordable-model runs tunable.
- **The rpiv-workflow engine.** Declarative, statically validatable, auditable, resumable multi-stage pipelines: predicate routing in an edge graph, per-stage output validation, and a durable JSONL audit trail that doubles as the system of record for resume. Its defining trade is the opposite of an imperative agent harness — it gives up ad-hoc parallelism to gain a graph you can preview, validate, and replay.
  - **A unified loop driver.** One continuation-style kernel behind three constructors — `fanout` (parallel-shaped), `iterate` (sequential accumulation), `assess` (produce/judge until done).
  - **First-class judges and per-stage `verify`.** A `Judge` is a valid-by-construction value — a dispatchable grading session whose verdict is validated and published to its own channel. Any producing stage can attach a `verify` post-condition that gates advancement and retries with feedback.
  - **Session-backed, fine-grained resume.** Every stage row records the Pi session that backed it; a crashed or aborted run resumes mid-loop, adopting the interrupted session's branch and skipping work that already landed.
  - **A skill-contract architecture.** Skills inject JSON-Schema-shaped contracts; the loader warns on incompatible adjacent stages and the runtime halts on a clean data-vs-schema mismatch.
- **The sibling family.** The extensions the pipeline composes — structured questionnaires (`ask-user-question`), a live task overlay (`todo`), reviewer escalation (`advisor`), web search and fetch (`web-tools`), placeholder expansion (`args`), localization (`i18n`) — plus the ones that ride the same lockstep rails: `btw`, `voice`, `warp`, and MLflow observability (`telemetry`).
- **The monorepo as a repo.** No build step (Pi loads raw `.ts`), one Vitest runner across every package, lockstep versions, and local-only releases — chosen so orchestration and tool surfaces evolve together and ship as one.

## What's Next

The near-term work has a clear arc: finish the primitive set, automate authoring on top of it, then run it autonomously at scale — alongside the verification and delegation work that closes the residual quality gap on affordable models.

- **Complete the loop primitive set.** The judge-as-a-value decision opened a small, composable surface where new patterns fall out of the existing kernel instead of growing it: a **panel of judges** (N independent skeptics with a vote fold) to turn single-judge checks into genuinely adversarial verification, a first-class **fan-in / synthesize** affordance so a fanout's results reach a downstream consumer visibly rather than implicitly, and a **`match()` enum gate** so classify-and-act on a string field stops needing routing boilerplate. Together these also make generate-and-filter composable with no new loop kind.
- **Automatic flow generation.** Today a human authors each workflow graph. The next step is an agent that proposes the graph — reading a task and the available skill contracts, then assembling a candidate `/wf` chain the driver reviews and runs. Authoring the pipeline becomes part of the pipeline.
- **Headless Pi / out-of-process execution.** The engine is sequential because Pi is single-active-session. Running stages out of process unlocks the autonomous, parallel scenarios a single interactive session can't host — long unattended runs and concurrent work the driver checks in on rather than babysits.
- **Verification under affordable models.** The pipeline already runs viably on affordable open-weight models, but output isn't yet at frontier parity — and the failure mode is self-validation blindness, with two roots. *Same model*: affordable work passes affordable verifiers, and only frontier escalation reliably catches the residual. *Same context*: a verifier that inherits the author's chat anchors on the author's framings and ratifies instead of attacks. Frontier escalation defeats the cost argument; isolation doesn't. The work is verification setups that lean on fresh-context isolation first and escalate to a frontier judge only where it earns its keep.
- **Delegation strategy.** Runtime cost is a function of how work is split across skills and subagents — what runs in parallel, what serially, which model handles which step, where verification fires. This is an open optimization question, not a planned feature: find the delegation pattern that minimizes total run cost without sacrificing output quality, and measure what actually trades off against what.

## What's Possible

Exploratory directions — proven enough to name, not committed enough to schedule.

- **Telemetry public release.** The MLflow observability layer is architecturally complete but ships private and opt-in. Making run inspection a first-class, public part of the pipeline is a question of polish and intent, not new architecture.
- **Non-Pi host embedding.** rpiv-workflow's coupling to Pi is structural-only — its public type surface names zero Pi types, guarded by a compile-time tripwire. That design leaves room for the engine to drive a host other than Pi.
- **Ecosystem and extensibility.** Skill contracts and layered workflow packs are already the seams a third party would extend — installable workflow bundles, third-party skill contracts, user-contributed packs. A real ecosystem story could grow from those seams.
- **Tournament ranking.** Pairwise-bracket ranking (sort N candidates by repeated judge comparison) slots cleanly into the unified loop driver as one more arm. Worth building only if demand for it materializes — not speculatively.
- **True parallelism with worktree isolation.** The highest-leverage autonomous use cases — mass migrations, large-scale ranking, whole-subsystem rewrites — lean on parallel agents in isolated git worktrees. This is blocked by Pi's single-session model and needs a real scheduler, so it stays a design note until headless execution lands beneath it.

---

A real enterprise harness — the layer connecting an engine like this to ticketing, CI, and an organization's institutional context — is a separate piece of work and deliberately out of scope here. This project is the engine for the driver-in-the-loop, not the harness around it. For the philosophy behind that bet, see the [README](./README.md#roadmap).
