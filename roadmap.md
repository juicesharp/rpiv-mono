# Roadmap

Keeping an experienced driver in the loop while the work moves at LLM speed. Companion to the [README's Roadmap](./README.md#roadmap) — no dates, no version targets. Items move down the list as they ship.

## What's Done

- rpiv-pi skill pipeline — ~20 contract-carrying skills (`discover` → `research`/`design`/`blueprint` → `plan` → `implement` → `validate` → `code-review` → `commit`)
- 15 named subagents for parallel analysis under fresh context
- 6 built-in `/wf` workflows — `ship`, `build`, `arch`, `vet`, `polish`, `pr-triage`
- Per-skill / per-stage model + effort control (`/rpiv-models`, `models.json`)
- rpiv-workflow engine — declarative, validatable, auditable, resumable pipelines with predicate routing
- Unified loop driver — `fanout` / `iterate` / `assess`
- First-class judges + per-stage `verify`
- Session-backed, mid-loop resume
- Skill-contract architecture (load-time + runtime schema checks)
- Sibling family — `ask-user-question`, `todo`, `advisor`, `web-tools`, `args`, `i18n`, `btw`, `voice`, `warp`, `telemetry`

## What's Next

- `panel()` — N judges + vote fold (adversarial verification)
- First-class fan-in / synthesize affordance
- `match()` enum gate
- Automatic flow generation via agent
- Headless Pi / out-of-process execution
- Verification under affordable models (fresh-context isolation + frontier escalation)
- Delegation strategy optimization

## What's Possible

- Telemetry public release
- Non-Pi host embedding
- Ecosystem / extensibility (third-party skill contracts, user workflow packs)
- Tournament bracket ranking
- True parallelism with worktree isolation
