# Changelog

All notable changes to `@juicesharp/rpiv-pi` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-04-20

## [0.9.1] - 2026-04-20

### Added
- `code-review` skill gains a gated Step 4 **Cross-Finding Interaction Sweep**: one `codebase-analyzer` agent runs after all Phase-2 lenses complete and synthesises Discovery Map + Quality + Security + Precedents into emergent multi-location defects (stranded states, inert retries, duplicate-processing paths, producer/consumer contradictions, cross-layer guard/transition mismatches). Gate skips the sweep when `ChangedFiles < 2` OR Quality returned `< 4` observations. Findings require `≥ 2` concrete `file:line` facts from different files/components; 🔴/🟡 tiers only — no 💭 dumping ground.

### Changed
- `code-review` artifact now carries a dedicated `### Cross-Finding Interactions` H3 under `## Issues Found` (omitted when the sweep was skipped or returned no findings). Reconciliation rules keep subsumed local findings when still actionable and document the relationship in `## Reconciliation Notes`. Critical-ordering and agent-roles sections updated; subsequent steps renumbered 5–9.

## [0.9.0] - 2026-04-19

### Added
- Register `@juicesharp/rpiv-args` as the 7th sibling extension in `extensions/rpiv-core/siblings.ts` and pin it as a peer dependency. Provides skill-argument resolving via the `input` hook (opt-in `$N`/`$ARGUMENTS` substitution in skill bodies) without breaking any of the 17 existing skills.

### Changed
- `commit` skill consumes the user-supplied hint inline via `$ARGUMENTS` (leverages `@juicesharp/rpiv-args` when installed). Without rpiv-args, the literal token appears inline and the hint still arrives as the trailing paragraph — the fallback instruction catches both cases via history/`git diff` inference.
- `implement` skill consumes `$1` (plan path) and `${@:2}` (phase scope) inline via `@juicesharp/rpiv-args`. Phase-scoping is now explicit in the skill body (previously only advertised in `argument-hint`; phase was inferred implicitly from the trailing-paragraph context).

### Fixed
- Sibling detection regex for `@juicesharp/rpiv-args` relaxed from `/@juicesharp\/rpiv-args(?![-\w])/i` to `/rpiv-args(?![-\w])/i` so file-path installs (`file:…/packages/rpiv-args`) are recognized as installed. The tighter scope-anchored form was stricter than the other 6 siblings' regexes and would produce a persistent false-positive "missing" warning for local-development installs. Word-boundary anchor preserved to prevent false positives against names like `rpiv-args-legacy`.

## [0.8.3] - 2026-04-19

### Changed
- Tier-1 prompt-polish across 7 skill files to align skill→agent dispatch prompts with each target agent's declared `tools:` contract. `annotate-{guidance,inline}` Pass 1 Agent B tightened to grep-shape signals (path shape + manifest files + folder composition); Pass 2 `codebase-analyzer` + `codebase-pattern-finder` still cover deep analysis. `research` and `design` `precedent-locator` dispatches gated on injected `git_commit` — skipped in non-git workspaces with a "git history unavailable" note. `design` Step 2 sample prompts labeled by target agent (`codebase-pattern-finder` / `codebase-analyzer` / `integration-scanner`) and the ambiguous "show me the wiring" phrase removed. `discover` locator no longer asked for multi-line function signatures (orchestrator Step 3 reads key files for depth). `outline-test-cases` locator-2 no longer asked for frontend→backend URL correlation (Step 3 Cross-Reference handles it orchestrator-side). `write-test-cases` Agent D (`integration-scanner`) no longer asked for "what it does" — Agent C (`codebase-analyzer`) already covers handler behavior.

## [0.8.2] - 2026-04-19

### Changed
- `code-review` artifact frontmatter trimmed from 21 to 14 fields. Removed: `files_changed`, `quality_issues`, `security_issues`, `dependency_issues`, `passes`, `advisor_used`, `advisor_model`. Advisor run and dependency-pass skip are now signalled structurally via presence/absence of the `## Advisor Adjudication` and `### Dependencies` sections. Kept: `date`, `reviewer`, `repository`, `branch`, `commit`, `review_type`, `scope`, `critical_issues`, `important_issues`, `suggestions`, `status`, `tags`, `last_updated`, `last_updated_by`.

## [0.8.1] - 2026-04-19

### Changed
- `code-review` security lens tightened for precision: agent-stage `confidence ≥ 8` gate, hard-exclusion list (DOS, rate-limit, log spoofing, prototype pollution, open redirects, regex DOS, client-side-only authn/authz gaps, React/Angular XSS without unsafe sinks, env/CLI/UUID-sourced findings, test-only and `.ipynb` findings, outdated-dep CVEs), and Step-4 🔴 requires an explicit source→sink trace. 🟡 narrowed to concrete crypto issues only (weak hash in auth role, non-constant-time compare on secrets, hardcoded key material).

## [0.8.0] - 2026-04-19

### Changed
- `code-review` skill rewritten as a three-pass parallel reviewer (quality, security, dependencies) with an always-on `precedent-locator` and a conditional `web-search-researcher` CVE lookup when manifests change. Reconciliation escalates to `advisor()` from the main thread when the tool is active, falling back to an inline dimension-sweep when it is not. `allowed-tools` removed from the skill frontmatter so it inherits `Agent`, `ask_user_question`, `advisor`, `Write`, and `web_search`.

### Fixed
- `thoughts/shared/reviews` is now scaffolded by `scaffoldThoughtsDirs` on `session_start`, matching every other skill-output directory. Previous builds required the directory to already exist before the `code-review` skill could write its artifact.

## [0.7.0] - 2026-04-18

## [0.6.1] - 2026-04-18

## [0.6.0] — 2026-04-18

### Added
- `@juicesharp/rpiv-btw` registered as a sibling plugin. `/rpiv-setup` now installs it, session-start warns when missing, and the README documents the new `/btw` command (ask a side question without polluting the main conversation).

## [0.5.1] — 2026-04-17

### Changed
- `explore` skill steps reformatted as `### Step N:` H3 headings (matching `discover`); Step 2.5 promoted to Step 3 with 3–8 cascaded to 4–9.

## [0.5.0] — 2026-04-17

### Added
- `--rpiv-debug` flag surfaces injected guidance and git-context messages for troubleshooting extension behavior.
- `explore` skill restructured into an option-shopping flow: generates 2–4 named candidates, confirms via a Step 2.5 checkpoint, and supports a no-fit recommendation branch.

## [0.4.x]

### Fixed
- `/rpiv-setup pi install` spawn failure on Windows.
- `git-context` showing branch as commit hash.
- Skill-pipeline description corrected: `review` → `validate`.
- `saveAdvisorConfig` error handling and effort-picker fallback index.

### Changed
- Provider setup moved to optional prereq; added Pi Agent install instructions to the README.
- Peer dependencies cleaned up (dropped `pi-ai`, `pi-tui`, `typebox`).

## [0.4.0]

### Added
- Bundled agents sync by content diff with manifest tracking.
- Git user and git-context messages injected per session, deduplicated across the lifecycle.
- Root guidance injected at session start; subfolder `CLAUDE.md` / `AGENTS.md` surfaced via per-depth resolver.
- `CLAUDE.md` migration path to `.rpiv/guidance/` tree.

### Changed
- Tools extracted into sibling `@juicesharp` Pi plugins (`ask-user-question`, `todo`, `advisor`, `web-tools`). `rpiv-pi` is now pure infrastructure.
- Skills renamed to a bare-verb convention (`/skill:research`, `/skill:design`, `/skill:plan`, …).

## [0.3.0]

### Added
- Advisor tool + `/advisor` command with reasoning effort picker, an "off" option, and model+effort persistence across sessions.
- CC-parity todo tool: 4-state machine (pending → in_progress → completed + deleted), `blockedBy` dependency graph, and a persistent overlay widget with status glyphs.
- Custom overlay for `ask-user-question` (themed borders, accent header, explicit keybinding hints).

## [0.2.0]

### Added
- Initial Pi extension: 9 agents and 21 skills covering the full discover → research → design → plan → implement → validate pipeline.

[Unreleased]: https://github.com/juicesharp/rpiv-mono/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/juicesharp/rpiv-mono/releases/tag/v0.6.1
[0.6.0]: https://github.com/juicesharp/rpiv-pi/releases/tag/v0.6.0
[0.5.1]: https://github.com/juicesharp/rpiv-pi/releases/tag/v0.5.1
[0.5.0]: https://github.com/juicesharp/rpiv-pi/releases/tag/v0.5.0
