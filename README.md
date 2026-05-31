# rpiv-mono

[![CI](https://img.shields.io/github/actions/workflow/status/juicesharp/rpiv-mono/ci.yml?branch=main&label=CI)](https://github.com/juicesharp/rpiv-mono/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/juicesharp/rpiv-mono/branch/main/graph/badge.svg?v=2)](https://codecov.io/gh/juicesharp/rpiv-mono)
[![tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/juicesharp/rpiv-mono/badges/tests.json)](https://github.com/juicesharp/rpiv-mono/actions/workflows/ci.yml)

Nine npm packages: one pipeline (rpiv-pi) and the sibling extensions it composes. Kept in one repo so orchestration and tool surfaces evolve together and ship in lockstep.

The pipeline needs most of them. **rpiv-args** expands shell-style `$1` and `$ARGUMENTS` placeholders inside skills, **rpiv-ask-user-question** lets the model put a structured questionnaire to the user instead of guessing, **rpiv-todo** keeps a live task overlay that survives `/reload` and compaction, **rpiv-advisor** escalates to a stronger reviewer model before the agent acts, **rpiv-web-tools** gives the model web search and fetch with pluggable providers, and **rpiv-workflow** chains skills into typed multi-stage pipelines (audited JSONL state, predicate routing, per-stage output validation) and ships the `/wf` command Pi calls to run them. A couple exist because I wanted them inside Pi: **rpiv-btw** is a side-conversation pattern I got used to in Claude Code, and **rpiv-warp** integrates Pi with Warp terminal's notification system, because that's where I actually run Pi. **rpiv-i18n** is the one that came from users: it started as localization for ask-user-question and grew into a small SDK. **rpiv-telemetry** wires Pi into MLflow — auto-instruments lifecycle events and sub-agent activity so runs are inspectable after the fact.

> [!TIP]
> **For the full pipeline narrative, the subagent map, and install instructions, visit [rpiv-pi.com](https://rpiv-pi.com).**

## Fork overlay (code tools)

This repository is a **direct fork** of [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono). It is maintained for personal tooling preferences and is **not intended for upstream contribution**.

### Install (replace upstream npm)

```bash
pi uninstall npm:@juicesharp/rpiv-pi
pi install git:github.com/spacemeld/rpiv-pi
```

Then inside Pi: `/rpiv-setup`, restart, `/rpiv-update-agents`.

### Upstream sync and version labels

When [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) releases (e.g. `1.16.2`), `.github/workflows/sync-upstream.yml` merges upstream, re-applies the code tools overlay, and labels the fork package version:

| Outcome | Version example |
| --- | --- |
| Overlay applied | `1.16.2-overlay` |
| Overlay failed (upstream agents restored) | `1.16.2-no-overlay` |

Pi shows an update at startup when the installed version differs. Quit and run `pi update` to apply it. If the overlay failed to apply, the postinstall hook prints a yellow warning during `pi update` directing you to check the Sync Upstream workflow run. No extra runtime extension is involved.

### Code tool prerequisites

| Extension | npm package | What it adds |
| --- | --- | --- |
| Pi-fff | `@ff-labs/pi-fff` | `fffind`, `ffgrep`, `fff-multi-grep` — fast fuzzy file and content search |
| Pi-cymbal | `pi-cymbal` | `cymbal_*` tools — symbol search, refs, impact, and call-graph navigation |

**Cymbal binary required.** `pi-cymbal` wraps the [Cymbal](https://chain.sh/cymbal/) CLI. Install Cymbal (`v0.13.5+`) and ensure `cymbal` is on your `PATH`, or set `CYMBAL_BIN` to its absolute path before starting Pi. Pi-fff has no separate binary — it ships a native Rust binding via npm. Both extensions are installed by `/rpiv-setup`.

See [packages/rpiv-pi/README.md](./packages/rpiv-pi/README.md) for troubleshooting.

## Roadmap

The realization shaping AI-assisted development right now is that LLMs produce correct code, not aligned code. The output compiles and passes tests, but it isn't enterprise-grade in the way human engineers produce: fitting the codebase's existing patterns, respecting conventions that aren't written down anywhere, making the boring choices mature systems rely on, staying reviewable and extensible by the next person who touches it. Closing that gap takes a driver: an experienced engineer who carries the context the model can't have, who frames the task correctly upfront, who steers architecture, who pushes back when output drifts. Without that active driver, the codebase fills with locally-correct, globally-misaligned diffs that look fine in PR review and erode the team's confidence over time.

Misaligned code isn't zero-value, it's negative-value: it compiles, it ships, then it taxes every engineer who reads that file afterward and costs the next refactor a half-day of reasoning about near-duplicates that shouldn't exist. Worse, it quietly subtracts from the architecture's coherence in a way no PR review catches. Misaligned-diff throughput is alignment-debt throughput. The cost of a driver-in-the-loop pipeline is latency, paid up front and visible on a dashboard; the cost of skipping it is alignment debt, paid later, by someone else, and rarely traced back to the diff that caused it.

rpiv-pi exists to keep the driver meaningfully in the loop while the work moves at LLM speed. The pipeline asks the right questions at the right moments (ask-user-question), surfaces architectural decisions where they matter, and structures human involvement as participation rather than approval. The bet isn't that models will plateau. They'll keep getting better. The bet is that the structural conditions for fully autonomous coding (institutional knowledge availability, connector maturity, correctness and latency at enterprise scale) are a decade-scale problem absent a real breakthrough. For that whole interval, the realistic operating model is a driver in the loop. rpiv-pi is the engine for that loop: it writes and verifies code under expert supervision. A real enterprise harness, the layer that connects an engine like this to ticketing, CI, and an organization's institutional context, is a separate piece of work and not what this project is today. At Codemasters, we're about to start exploring how an engine like rpiv-pi could fit as part of a broader multi-chain experiment. Whether any of that surfaces back here is open.

In parallel, the pipeline is already viable on affordable open-weight models today (GLM-5.1, Kimi K2.5, MiMo-V2-Pro), and produces genuinely good results in practice. Output isn't yet at parity with frontier on the same task: more mistakes than I'd want, longer runs than I'd want. Closing that residual gap is the next set of work below. I'm assessing this as a CTO leading AI adoption at a mid-size company with no frontier-lab budget, where the cost difference matters: as of May 2026, GLM-5.1 lists at roughly a third of Claude Sonnet 4.6's output token price, and around a fifth of Opus 4.7's.

- **Verification under affordable-model runs.** The failure mode I see today on GLM/Kimi/MiMo isn't loud breakage; it's self-validation blindness, and it has two roots, not one. Same model is the obvious one: affordable-model work passes affordable-model verifiers, and only escalation to a frontier judge (currently Opus 4.7, May 2026) reliably catches the residual issues. The less obvious one is same context: a verifier that inherits the author's chat anchors on the same framings, ratifies instead of attacks, and writes tests that encode the author's mental model rather than probe it. Frontier escalation defeats the cost argument; isolation doesn't. The next round of work is experimenting with verification setups that lean on fresh-context isolation first and frontier escalation only where it earns its keep.
- **Delegation strategy.** The pipeline's runtime cost is a function of how work is delegated across skills and subagents: what runs in parallel, what serially, which model handles which step, where verification fires. Some of the slowness on affordable-model runs is infrastructure-side and outside scope. The part that's tractable is finding the delegation pattern that minimizes total run cost without sacrificing output quality. This is an open optimization question, not a planned feature; the next round of work is experimenting with combinations and measuring what actually trades off against what.

## Who built this

Sergii Guslystyi. Software Architect and CTO at Codemasters International. Two decades building software, currently leading AI-first development adoption inside the company. rpiv-mono is a personal initiative, on my own time, where I prototype the patterns I'm working through professionally and put them in public for anyone to use, fork, or push back on.

Find me on X: [@juicesharp](https://x.com/juicesharp).

## Repo as a repo

npm workspaces monorepo. Clone, `npm install` at the root, that's it.

A few choices worth naming up front:

- No build step. Packages publish raw `.ts`; Pi loads TypeScript directly. No `dist/`, no per-package tsconfig.
- One Vitest runner at the root walks every package. No per-package vitest configs.
- Lockstep versions. All nine packages share one version, enforced by `sync-versions.js`.
- Releases are local-only by design. `node scripts/release.mjs <patch|minor|major|x.y.z>` cuts a release; no CI publish workflow.
- Husky gates the work. `pre-commit` runs Biome and `tsc --noEmit` (fast); `pre-push` runs the full test suite with coverage thresholds. Tests don't block commits, they block pushes.
- Single shared config across the workspace: one `biome.json`, one `tsconfig.base.json`, one `vitest.config.ts`.

### Contributions

Issues are welcome. PRs too, but please open an issue first if the change isn't trivial. The project has a definite shape and direction, and a quick conversation up front saves both of us a round-trip.

## Status and expectations

Started April 2026. MIT licensed.

Single maintainer (me); Claude Code is a co-author on most commits.

Actively maintained as a personal project. Issues triaged on best effort. Cadence may slow when the day job runs hot.

## Pointers

- Site: [rpiv-pi.com](https://rpiv-pi.com)
- License: [MIT](./LICENSE)
- X: [@juicesharp](https://x.com/juicesharp)

### Packages

Almost every package can be installed directly from npm on its own. `/rpiv-setup` (shipped by `rpiv-pi`) only auto-installs the siblings the pipeline depends on; the rest are opt-in via `pi install npm:@juicesharp/rpiv-<name>`.

| Package | Role | Standalone install | Auto with `rpiv-pi` | npm |
| --- | --- | :---: | :---: | --- |
| `rpiv-pi` | Pipeline (skills + subagents) | ✓ | — | [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) |
| `rpiv-args` | `$1` / `$ARGUMENTS` placeholders in skills | ✓ | ✓ | [`@juicesharp/rpiv-args`](https://www.npmjs.com/package/@juicesharp/rpiv-args) |
| `rpiv-ask-user-question` | Structured questionnaire to the user | ✓ | ✓ | [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) |
| `rpiv-todo` | Live task overlay surviving `/reload` | ✓ | ✓ | [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) |
| `rpiv-advisor` | Escalate to a stronger reviewer model | ✓ | ✓ | [`@juicesharp/rpiv-advisor`](https://www.npmjs.com/package/@juicesharp/rpiv-advisor) |
| `rpiv-web-tools` | Web search + fetch with pluggable providers | ✓ | ✓ | [`@juicesharp/rpiv-web-tools`](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools) |
| `rpiv-i18n` | Localization SDK for sibling extensions | ✓ | ✓ | [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) |
| `rpiv-workflow` | `/wf` runner — chain skills into typed multi-stage pipelines | ✓ | ✓ | [`@juicesharp/rpiv-workflow`](https://www.npmjs.com/package/@juicesharp/rpiv-workflow) |
| `rpiv-btw` | `/btw` side-conversation slash command | ✓ | — | [`@juicesharp/rpiv-btw`](https://www.npmjs.com/package/@juicesharp/rpiv-btw) |
| `rpiv-voice` | Local voice dictation (`/v` overlay, on-device Whisper) | ✓ | — | [`@juicesharp/rpiv-voice`](https://www.npmjs.com/package/@juicesharp/rpiv-voice) |
| `rpiv-telemetry` | MLflow observability — auto-instruments lifecycle + sub-agent activity | ✓ | — | [`@juicesharp/rpiv-telemetry`](https://www.npmjs.com/package/@juicesharp/rpiv-telemetry) |
| `rpiv-warp` | Warp terminal notification integration | ✓ | — | [`@juicesharp/rpiv-warp`](https://www.npmjs.com/package/@juicesharp/rpiv-warp) |
