# Changelog

All notable changes to `@juicesharp/rpiv-pi` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.2] - 2026-04-24

### Fixed
- **Quiet `◐ running` card no longer shifts layout**: the inline subagent tool card now renders exactly one status line throughout the entire non-terminal lifetime (including the pre-progress first frames), eliminating the 1-line ↔ N-line oscillation that could push rows into scrollback mid-stream.

## [0.12.1] - 2026-04-24

### Fixed
- **Subagent overlay no longer leaves stale duplicate rows**: multi-line `task:` strings are now collapsed to a single line before rendering.

## [0.12.0] - 2026-04-24

### Added
- **Live subagent overlay**: a Subagents tree appears above the editor while a subagent is running, showing per-agent turns, tool uses, tokens, and elapsed time — refreshing as work streams in.
- `ensureSubagentConfig()` helper in `extensions/rpiv-core/ensure-subagent-config.ts` — called from `/rpiv-setup` post-install (gated on at least one successful install), shallow-merges `parallel.concurrency: 48` and `maxSubagentDepth: 3` into `~/.pi/agent/extensions/subagent/config.json` without clobbering user-set values. Idempotent; invalid-JSON or non-object top-level → silent no-op to preserve user data. Emits a "Seeded subagent config keys: …" info notify only when at least one key was actually added.
- 13th bundled agent `agents/general-purpose.md` — fallback agent used by `validate/SKILL.md:52-54` and `resume-handoff/SKILL.md:48` call sites. Uses the same three-key isolation recipe as the other 12; read-only tools (`read, grep, find, ls, bash`). Skills require no edits — the new file resolves the dispatch references that previously pointed at the old `general-purpose` builtin (which is not present in `pi-subagents@0.17.5`'s roster: scout / planner / worker / reviewer / context-builder / researcher / delegate / oracle / oracle-executor).
- `pruneLegacySiblings()` helper in `extensions/rpiv-core/prune-legacy-siblings.ts` — called at the top of every `/rpiv-setup` invocation (before `findMissingSiblings()` so it fires even when all siblings are installed). Removes any `@tintinweb/pi-subagents` entry from `~/.pi/agent/settings.json` via a fail-soft shallow rewrite that preserves every other top-level key and packages-array entry. Emits a `Removed legacy subagent library from settings.json: …` notify when at least one entry is pruned; silent no-op when none match. Legacy registry declared declaratively as `LEGACY_SIBLINGS` in `siblings.ts` for future deprecations. Closes the 0.11.x → 0.12.0 upgrade gap where leaving the old library entry in `settings.json` caused Pi to dispatch through the deprecated tintinweb tools and fail with `path argument must be of type string`.
- `ensureBuiltinsDisabled()` helper in `extensions/rpiv-core/ensure-builtins-disabled.ts` — called from `/rpiv-setup` adjacent to the prune step. Seeds `subagents.disableBuiltins: true` in `~/.pi/agent/settings.json` so the 9 nicobailon built-in agents (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`, `oracle`, `oracle-executor`) don't appear in `/agents` alongside rpiv-pi's 13 specialists — the rpiv skills only dispatch to the specialists, so keeping the builtins enabled clutters discovery and expands the LLM's choice surface unnecessarily. User-wins: any explicit value (`true` OR `false`) at `subagents.disableBuiltins` is preserved; only an absent field gets seeded. Fail-soft on missing/invalid settings.json. Sibling keys under `subagents` (e.g. `agentOverrides`) are preserved on merge. Emits a `Disabled pi-subagents built-in agents (scout, planner, worker, …)` notify only when the field is actually written.

### Changed
- **Calmer subagent tool card**: the inline "subagent <agent>" card no longer flickers while running — it shows a small `◐ running` status underneath, and the full result renders once when the run finishes.
- **Subagent overlay sits above Todos** so active subagents stay visible at a glance.
- **Skills stop asking for `output: false`** when dispatching subagents — one less parameter to pass.
- **Subagent provider migrated**: dropped out-of-support `@tintinweb/pi-subagents@0.5.2` peer dependency in favor of `pi-subagents@0.17.5` (nicobailon fork). `packages/rpiv-pi/extensions/rpiv-core/siblings.ts` SIBLINGS[0] rewritten with an unscoped-name word-boundary regex `(^|[^\w/-])pi-subagents(?![-\w])/i` that excludes the legacy scoped form, so transitional users with `@tintinweb/pi-subagents` still in their `~/.pi/agent/settings.json` are correctly prompted to install the new package on next `/rpiv-setup`. `provides` string updated to `subagent / subagent_status tools + /agents command`.
- **Pi ceiling relaxed**: `peerDependencies["@mariozechner/pi-coding-agent"]` lifted from `"<=0.67.67"` (0.11.x) to `"*"`, matching the other Pi peers in the block and aligning with `pi-subagents@0.17.5`'s own `"*"` peer declaration. Root `package.json` dev-pin bumped from exact `"0.67.67"` to `"^0.67.68"` matching the pi-ai/pi-tui pattern. README compatibility banner at `README.md:6` rewritten accordingly.
- **Agent frontmatter modernized**: all 12 bundled agents (`agents/{claim-verifier,codebase-analyzer,codebase-locator,codebase-pattern-finder,diff-auditor,integration-scanner,peer-comparator,precedent-locator,test-case-locator,thoughts-analyzer,thoughts-locator,web-search-researcher}.md`) have `isolated: true` replaced with the explicit three-key recipe `systemPromptMode: replace` + `inheritProjectContext: false` + `inheritSkills: false` — `isolated` is no longer parsed by `pi-subagents@0.17.5`. Behavioral semantics preserved.
- **Concurrency persistence**: `README.md:190,202` rewritten to drop the vendor-qualified name and the `/agents → Settings → Max concurrency → 48` UI breadcrumb (which was tintinweb-specific and lost across every restart); replaced with documentation of the new `/rpiv-setup`-seeded `~/.pi/agent/extensions/subagent/config.json` file.
- **Skill vocabulary migrated to nicobailon's tool schema**: all 12 skills that fan out (`annotate-guidance`, `annotate-inline`, `code-review`, `design`, `discover`, `explore`, `implement`, `outline-test-cases`, `research`, `resume-handoff`, `revise`, `validate`, `write-test-cases`) now reference the `subagent` tool and `agent:` parameter name. 5 frontmatter `allowed-tools:` entries had `Agent` (tintinweb) replaced with `subagent` (nicobailon) — critical because Pi enforces that list literally; without the rename, `pi-subagents@0.17.5` could not dispatch. 14 `subagent_type: X` call-shape prose sites rewritten to `agent: X`. Section headers `## Agent Usage` / `## Agent Invocation Best Practices` renamed. `.rpiv/guidance/agents/architecture.md` and `.rpiv/guidance/skills/architecture.md` updated to cite the new tool name, new package name, and the new call shape (`subagent({ agent, task })`). Human-facing section labels (`**Agent A — …**`, `**Agent — Integration map:**`, `Agent roles`) intentionally preserved as prose — they're organizational anchors, not tool-call references.
- **Skill dispatch one-liner consolidated**: every `(parallel agents)` step across 13 skills (+ `.rpiv/guidance/skills/architecture.md`) now carries the identical self-contained one-liner with the literal call shape — `subagent({ agent: "<agent-name>", task: "<task>", context: "fresh", artifacts: false })`. Back-references like "(same convention as Wave-1)" removed so each step is independently executable. 20 invocation sites rewritten. Fixes a param-name mismatch — prose previously said `prompt:` but the `pi-subagents@0.17.5` schema uses `task:`.
- **Agent description frontmatter vocabulary**: `agents/{thoughts-analyzer,codebase-pattern-finder,web-search-researcher}.md` `description:` fields no longer use the retired Claude-Code term `subagent_type` — replaced with `agent` to match the `pi-subagents@0.17.5` tool vocabulary the dispatching model now reads.

### Fixed
- **Pi no longer refuses to start** with a "Tool 'subagent' conflicts" error — `/rpiv-setup` now claims the subagent registration cleanly instead of loading it twice.
- **Stale attribution anchors**: `rpiv-btw/btw.ts:84` comment `// Mirrors @tintinweb/pi-subagents/src/index.ts:413-422 pattern` replaced with a vendor-neutral description of the `globalThis + Symbol.for()` Node.js idiom (the original anchor was already incorrect in the shipped 0.5.2 build, and nicobailon removed the globalThis pattern entirely — rpiv-btw uses its own `Symbol.for("rpiv-btw")` key throughout, zero functional break).
- **AgentWidget mirror comment**: `rpiv-todo/todo-overlay.ts:4-7` docstring and `:21-22` constant annotation no longer cite the subagents library; the actual API owner is Pi core's `ExtensionUIContext.setWidget` at `@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1288-1317`.
- **`parseSkillBlock` misattribution**: `rpiv-args/.rpiv/guidance/architecture.md:16` corrected from `@tintinweb/pi-subagents` to `@mariozechner/pi-coding-agent` (interactive mode). The tintinweb tree contains zero `parseSkillBlock` references; the real consumer is `pi-coding-agent/dist/core/agent-session.js:40`.

### Breaking / Upgrade Notes
- **Upgrading from earlier 0.11.x**: run `/rpiv-setup` once and restart Pi. It will remove `npm:pi-subagents` from `~/.pi/agent/settings.json` (rpiv-pi owns that registration now). The `subagent` / `subagent_status` tools and `/agents` command still work — nothing you use goes away.
- **0.11.x users upgrading**: session-start emits two banners on first launch after upgrade — "rpiv-pi requires 1 sibling extension(s): pi-subagents" and "13 outdated agent(s)". Run `/rpiv-setup` once (installs new sibling, seeds `config.json`, prunes the legacy `@tintinweb/pi-subagents` entry from `settings.json`), then `/rpiv-update-agents` to refresh bundled agents. Restart the session. The legacy npm package can optionally be uninstalled with `pi uninstall npm:@tintinweb/pi-subagents` to free disk space — functionally it's already unloaded because Pi only loads what's in `settings.json`'s `packages[]` array.
- **User-customized bundled agent files**: `/rpiv-update-agents` overwrites edits to rpiv-managed filenames (pre-existing behavior documented at `README.md:191`, inherited from commit `1bc5777`). With 13 agents changing in this release, the blast radius is larger than usual — copy your customizations to a different filename before running `/rpiv-update-agents` if you have edits.
- **Existing `~/.pi/agent/extensions/subagent/config.json`**: preserved. `ensureSubagentConfig()` only adds missing keys; explicit user values (e.g., `parallel.concurrency: 16`) are never overwritten.
- **Rollback**: git revert the release commit and `pi install npm:@juicesharp/rpiv-pi@0.11.7`. Any seeded `config.json` keys remain harmless — tintinweb's subagents library doesn't read that file.

## [0.11.7] - 2026-04-23

### Fixed
- `code-review` skill: scope resolution and verification now focus on the developer's own changes. Step 1 adds default-branch auto-detection (`symbolic-ref` with `main` / `master` fallback) and a strategy tag per parser branch (`first-parent` | `explicit-range` | `working-tree`). For `first-parent` strategies (empty scope, PR branch, commit list), `InScopeFiles` is computed per-commit via `git diff-tree` union over `git log --first-parent --no-merges` — isolating each feature commit's own delta so back-merge sidecars drop out even when the merge sits on the first-parent line and its tree state inflates `--name-only`. Step 6 pre-filters the reconciled severity map by `InScopeFiles` before `claim-verifier` dispatch, so findings about files brought in by back-merges from the default branch no longer reach the artifact. `ChangedFiles` stays inflated so Wave-1's integration map still sees full blast radius. Unrecognised scope inputs (prose, unresolved branch names, mixed lists) route through `ask_user_question` instead of silently guessing.

### Changed
- `code-review` skill empty-scope default changed from "ask the user" to "feature-branch-vs-default-branch first-parent review" — matches the dominant workflow (feature-branch review + pre-push gate).
- Template v2 frontmatter adds `scope_strategy` and `in_scope_files_count` so each review records which strategy ran and how much `InScopeFiles` narrowed against `ChangedFiles`. Additive; existing reviews parse unchanged.

## [0.11.6] - 2026-04-22

### Changed
- `code-review` skill rewritten around row-only specialist agents (three-wave parallel flow): `diff-auditor` at Wave-2 (Quality + Security), `peer-comparator` at Wave-1 (Peer-Mirror), `claim-verifier` at Step 6, plus orchestrator-side Gap-Finder (set arithmetic, no agent). Row-only output contracts structurally resist narrativisation. Replaces the previous three-pass-with-advisor-adjudication variant.

### Added
- Agents `diff-auditor`, `peer-comparator`, `claim-verifier` — row-only auditors with adversarial personas used by the rewritten `code-review` skill.

## [0.11.5] - 2026-04-22

### Changed
- **Pi compatibility pinned**: `peerDependencies["@mariozechner/pi-coding-agent"]` tightened from `"*"` to `"<=0.67.67"`. Newer Pi releases ship breaking changes and are unsupported on the `0.11.x` line — install will emit a peer-dep warning. README updated with a compatibility banner. Next Pi-compatible line will be cut as a new major.
- `code-review` skill template v2: findings restructured from indented bullets to H3 + bold-label blocks (`**Where**` / `**Code**` / `**Why**` / `**Fix**` / `**Alt**`), code snippets moved to fenced blocks with language tags derived from the file extension, ASCII `───` dividers replaced with GFM `---`, Legend converted to a `text` code block, Pattern Analysis converted to a GFM pipe table, Recommendation converted to a priority-ordered table. Frontmatter gains `severity` and `verification` objects (replacing the `counts` / `verification` strings) and a `blockers_count` integer. Renders cleanly in both raw source and markdown preview.

## [0.11.4] - 2026-04-21

### Changed
- `code-review` skill template: Impact and Precedents sections converted from monospace-aligned text tables to GFM pipe tables so they render correctly in markdown viewers.

### Fixed
- `code-review` skill Step 6: verification is now drift-tolerant. Step-1 uses `grep -n` for the verbatim quote and auto-rewrites the citation to the actual line number instead of falsifying findings whose lines shifted.

## [0.11.3] - 2026-04-21

### Changed
- `code-review` skill revised based on A/B-test results. The winning variant produces better review quality across Quality, Security, and Dependencies lenses with a three-wave parallel flow and advisor adjudication. Adds a `templates/review.md` scaffold used at artifact emission. Superseded skill variants removed.

## [0.11.2] - 2026-04-21

## [0.11.1] - 2026-04-20

### Reverted
- `code-review` skill: revert the 0.11.0 changes (cross-component consistency check, workflow-risk AND gate, abstract cross-stack defect classes in the interaction sweep, 16-ecosystem dependencies lens, ecosystem-tagged CVE lookups, design-skill parallel-spawn restructure of Steps 2/3/4, and frontmatter keys `files_changed`/`advisor_used`/`interaction_sweep`/`workflow_risk_gate`). Restores the 0.9.1 skill body (Cross-Finding Interaction Sweep + local-composition checks) due to a quality regression observed in practice.

## [0.11.0] - 2026-04-20

### Changed
- `code-review` skill: Quality lens bucket 5 now checks **cross-component consistency** against 1-hop analogues from the Discovery Map (behavioral-shape comparison, same-feature-area only). Step-4 gate replaces the prior EITHER/OR with a pure AND keyed to five grep-executable **workflow-risk** signal groups (finalized in Step 2). Interaction sweep adds abstract cross-stack defect classes (dual-write divergence, invariant-enforcement gap, coupled-lifecycle mismatch) alongside the original local-composition checks. Dependencies lens broadened to **16 ecosystems** (npm, pip, nuget, go, crates, rubygems, maven, composer, swift, mix, pub, terraform, docker, …) with filename+syntax ecosystem inference and explicit ambiguity handling. CVE lens hint extended to ecosystem-tagged lookups (GHSA / OSV / RustSec / Trivy). Steps 2/3/4 restructured to the design-skill parallel-spawn+wait pattern with explicit numbered sub-steps.

### Added
- `code-review` artifact frontmatter append-only keys: `files_changed`, `advisor_used`, `interaction_sweep`, `workflow_risk_gate`.

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
