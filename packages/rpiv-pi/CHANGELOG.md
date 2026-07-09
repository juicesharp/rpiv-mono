# Changelog

All notable changes to `@juicesharp/rpiv-pi` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **`carve` renamed to `build`; `build` redefined.** `/wf build` now runs the sliced, panel-gated carved pipeline — 19 stages (`goal → research → slice → … → commit`) with three automated grade gates (each backed by a fix loop) and one human design checkpoint — superseding the old 7-stage build (`research → blueprint → implement → validate → code-review → revise → commit`). The shipped `/wf` set is now `arch`, `build`, `ship`, `vet`, `polish` (previously `ship` / `build` / `arch` / `vet` / `polish` / `pr-triage`, with `carve` as an additional preset). `build` is redefined rather than removed-then-added — the name is continuous — so the old build is folded into this bullet, not listed separately under Removed.
- **Silent `presets.build` semantic shift.** A `models.json` `presets.build` override tuned for the old 7-stage build will silently apply to the new 19-stage carved pipeline with **no warning**, because `build` remains a valid live-registry key (carve was renamed to `build`). Review or rename your `presets.build` entry. This contrasts with `presets["pr-triage"]`, which now warns once and stops applying because that key has left the live registry.

### Fixed
- **`validate` no longer misreads a provided plan path as empty input (#89).** The skill's `## Input` line embedded `$ARGUMENTS` in documentation prose with the empty-input fallback in the same sentence, so after rpiv-args substitution the argument read as placeholder text and models branched to the recent-plans list. The input now lands in a dedicated `User input (raw):` slot, and the fallback is explicitly gated on that slot being empty. Lane transcripts also strip rpiv-args' new `Skill input:` argument-trailer label so the viewer shows what the human typed.
- Moved `typebox` from `peerDependencies` to `dependencies` (`^1.1.24`, matching the Pi host's range) so `models-config.ts`'s schema resolves under installers that don't materialise peer deps. Fixes `ERR_MODULE_NOT_FOUND: typebox` on standalone consumer installs (#79).
- Test files are no longer published in the npm tarball. The `extensions/`, `skills/`, `agents/`, and `scripts/` globs in `files` packed `**/*.test.ts`, which import the private, unpublished `@juicesharp/rpiv-test-utils` fixture package. Added a `!**/*.test.ts` exclusion to `files` (#80).

### Removed
- **Legacy `thoughts/shared/` → `.rpiv/artifacts/` auto-migration.** The one-shot migration (`migrateThoughtsToArtifacts`, run on `session_start`) shipped in 1.x to relocate the old artifact store into `.rpiv/artifacts/` has run its course: it no-ops for everyone who has started a session since, and on repos where `thoughts/shared` became a symlink back into `.rpiv/artifacts` it looped every session, emitting `[rpiv-pi] migration: src and dest cannot be the same …`. Stragglers with a real, still-populated `thoughts/shared/` can migrate manually: `cp -r thoughts/shared/* .rpiv/artifacts/ && rm -rf thoughts/shared`.
- **Removed built-in `/wf` preset `pr-triage` and the superseded old 7-stage `build`.** The `pr-triage`, `revise`, `design`, and `plan` skills remain standalone-invokable via `/skill:<name>`; only their `/wf <name>` workflow graphs are gone. (`build` itself is redefined, not removed — see Changed above.)

### Added
- **Lane dock: a persistent, focusable panel for parallel and background `/wf` runs.** Every in-flight or detached workflow run now surfaces as a row in an always-mounted panel rendered below the editor (superseding the original ambient overlay + modal lane manager). Step in via `↓` on an empty prompt, `^Q`, or `/lanes`; navigate with `↑`/`↓`; `⏎` answers a lane's queued `ask_user_question` inline (or `→` opens its read-only transcript) while other flagged lanes still await input; `x` aborts/evicts a lane; `↑`-at-top/`esc` steps back out to the primary input. Each row shows a progress bar driven by a distinct-stage-visited count rather than the raw stage ordinal (so loop-backs no longer show a misleading "7/4"), a `↻N` lap marker only when a stage is genuinely re-entered, a compact `↑in ↓out` token tally, and a failure-cause chip. Fan-out stages get individually addressable sub-lanes — own session, teardown snapshot, disk-fallback pointer, and deferred-input queue per unit — with a dim `○` pending glyph for units not yet started.
- **Live per-lane transcript viewer with streaming "thinking".** Stepping into a lane's transcript replays it faithfully — bash runs, skill invocations, tool calls/results, and compaction/branch summaries each render via their own component, mirroring interactive mode — and shows the child session's in-flight partial assistant message as it streams, not only after the turn commits. A pause/follow toggle (`PageUp`/`PageDown`) freezes the window on a stable anchor line instead of drifting as streaming tokens grow the body, and auto-resumes following on reaching the tail. A durable on-disk fallback (`loadBranchFromDisk`) restores the transcript for a terminated/retired run even after the live session is gone, and the dock/viewer surface the recorded failure cause on a failed or aborted run.
- **Per-unit and per-run token usage.** Token consumption (`↑in ↓out`, plus cache-read % and cost in the full viewer header) is captured at session teardown and tallied in real time across the dock and viewer, surviving lane retirement.
- **Per-command bash watchdog for fan-out child sessions.** A detached child's bash tool now honors a wall-clock ceiling per command (default 3 min, clamped to [5s, 30min], overridable via `RPIV_BASH_TIMEOUT_MS`); on expiry the child session aborts and the run routes to the soft-halt gate instead of hanging on a runaway command (e.g. `find /`) for the rest of the run.
- **Tree-scoped code reviews (#76).** `/skill:code-review` gains a scope that diffs the null tree against the index (`git diff --cached <null_tree>`) so a staged-but-uncommitted file produces real hunks instead of silently falling through the synthetic-patch fallback.
- **`build` pipeline (carve) hardening.** A deterministic citation check (`verifyCitations`) now runs on the slice map, plan, and code-bearing plan, failing a gate when a `file:line` citation doesn't resolve against the tree instead of letting fabricated precision propagate into design or implementation; a unique whole-segment tree suffix backs an otherwise-bare citation. A deterministic `slice-structure` floor (dependency-cycle freedom + brief-coverage conservation) runs alongside a single collapsed `design-readiness` LLM dimension. A first-class `risks:` frontmatter channel lets `synthesize` flag concerns that `grade`/`validate` must rule pass/fail per flag, blocking the gate on a ruled failure. A verbatim `goal` artifact and a per-run commit baseline (`goal/baseline-<stamp>.json`) are threaded into `validate`'s scope checks and `commit`'s dispatch so pre-existing dirty files are never mistaken for the run's own changes. A `design-review` human checkpoint sits between `slice-design` and `subplan`; slice design is now dependency-ordered (`--upstream` threading so a slice's design waits on, and reads, its declared dependencies' decided interfaces); `research` is front-loaded as the pipeline's first stage; and a severity floor means a low/none finding no longer blocks a gate. Gate tiers (light/standard/strict, derived from slice/phase count and verdict severities) plus a one-time independent second judgment before a first blocking verdict forces a fix round cut grading overhead on small runs by roughly 35-40% while preserving full scrutiny on large ones.
- Config loaders (including `models.json`) honor `XDG_CONFIG_HOME` with a one-way legacy fallback to `~/.config/rpiv-pi/` when the XDG path is absent; a malformed XDG file warns and degrades to `{}` rather than silently falling back to the legacy path.

### Changed
- **Pipeline skills hidden from model invocation (closes #77).** The 18 pipeline-stage and workflow-internal fanout skills now set `disable-model-invocation: true` so they only run via explicit `/skill:<name>` or workflow dispatch — models can no longer spontaneously enter a human-gated stage — trimming roughly 3k tokens of skill descriptions from every session's system prompt. A ~120-token hidden pipeline index injected at session start keeps the stage commands discoverable. The 9 natural-language utility skills (`commit`, `code-review`, `changelog`, `create-handoff`, `resume-handoff`, `pr-triage`, `annotate-*`, `migrate-to-guidance`) stay auto-invocable.
- The legacy `ctx.ui.setStatus` status line and the per-stage/per-unit completion toasts are retired — the lane dock's progress bar and streaming preview are now the sole live-progress surface.
- The `foreground`/`background` skill-lane distinction is dropped now that every stage runs in its own detached child session: all stages route through the same dock-bound relay, so a fan-out unit's `ask_user_question` queues and badges in the dock rather than requiring a dedicated foreground slot.

### Fixed
- Citation floor no longer false-fails real files cited with a package-relative path (e.g. `validate/stage-rules.ts` for a file under a sibling package) — a unique whole-segment tree suffix now backs the citation; an ambiguous suffix stays unbacked with candidates named instead of failing the run.
- `designPathsBySlice` takes the latest design per slice instead of throwing when `design-review` legitimately re-emits a reviewed design onto the same channel.
- Plan/slice/review heading counts (`## Phase N:`, `## Slice N:`) are now counted outside fenced code blocks, so a meta-plan that embeds example plan fixtures no longer trips the derived-array staleness guard.
- `stitch-elaborations` splits phases only at column-0 headings outside fenced code blocks and merges idempotently, so re-elaborate → re-stitch cycles no longer shred `## `-prefixed Find/Replace content or accumulate duplicate per-phase trailers.
- A stray colon in an agent-authored artifact frontmatter scalar (e.g. `target: foo (lane UI: L0-L2)`) no longer throws and halts the whole workflow — frontmatter degrades to `{}` and the field is left to the stage's own schema validation.
- A resumed run's lane no longer stays stuck rendering as "failed" — `recordRun` now reactivates a retained lane's status, snapshot, and progress on resume.
- The nested-fanout depth guard now throws a typed `FanoutDepthExceededError` (carrying `depth`/`max`) instead of a bare `Error`, distinguishing it from an unexpected worker bug.
- Child-session isolation fixes: launcher-only ambient observer extensions (e.g. `rpiv-warp`) are filtered out of child resource loaders (fixing a stale-context crash from an orphaned idle timer), and the branch is read via `sessionManager.getBranch()` instead of raw session messages (fixing every stage halting with `FAIL_STAGE_NO_RESPONSE` after an otherwise-successful run).
- Numerous lane-dock/viewer/console rendering and state fixes: stale duplicate or "ghost" frames on stage transitions, height changes, and preview re-targets are now cleared by forcing a full repaint on the relevant shape signature; progress advances by a true completion count instead of unit index (fixing regressions under out-of-order parallel completion); the distinct-stage-visited numerator is seeded from a resumed run's replayed walk and credits bypassed recovery arms so it reaches the total while the terminal stage runs; a soft-halted fan-out unit now flips its dock row to failed instead of spinning forever; the needs-input aging clock and last-session-file pointer no longer race a transient input drain; and `⏎` on a fanned-out lane's aggregate-flag row now jumps to and arms the first flagged sub-row's question instead of going inert.

### Performance
- `build`'s quality-panel gates skip the re-grade entirely when a fix round only cleared a deterministic floor (cite-check/structure), since that edge routes on the same gate predicate as the grade edge; when a real re-grade does run, it re-runs only the previously-failing dimensions and carries passing verdicts forward instead of re-grading the whole panel from scratch. Eliminates the redundant full-panel re-grade and the pass↔fail flap that spawned extra fix loops; regressions are still caught by the downstream code-grade/validate.

### Breaking / Upgrade Notes
- `/lanes` and `^Q` now step into the always-mounted lane dock instead of opening the old modal lane manager (removed). Custom tooling built against the manager overlay must move to the dock's keyboard model (`↓`/`^Q`/`/lanes` to step in, `⏎` to answer/view, `x` to abort, `esc`/`↑` to step out).
- The parallel-fanout execution trail schema bumped v1 → v2 (fanout rows are now placed by `unitIndex` and carry a `collected` discriminator). A run started before this upgrade cannot be resumed afterward — `reconstructState`'s version gate refuses a v1 trail rather than mis-replaying it, and there is no in-place migration — so finish or discard in-flight runs before upgrading.

## [1.20.0] - 2026-06-15

### Added
- **User-installed skill contracts.** A new lazy contract provider (owner `"user-skills"`) harvests `contract:` frontmatter from skills in Pi's default user locations (`<agentDir>/skills` + `<cwd>/.pi/skills`) and registers them alongside the bundled set, so workflows naming user skills get contract-driven validation and outcome derivation. Enumeration is filesystem-based via Pi's `loadSkills` (no captured `pi` handle — those go stale on session replacement / `/reload`); bundled skills are excluded by a realpath-safe path check. Skills shipped by other Pi packages register their own contracts via `registerSkillContracts`.
- **Outcome derivation consults registered bucket mappings.** `deriveOutcomes` resolves `artifactKind → bucket` through `registerBucketKindMapping` entries first, falling back to the built-in `BUCKET_BY_KIND` table — user skills with novel artifact kinds can route to their own buckets. Overriding a built-in kind's bucket surfaces a load-time warning (once per kind per load): workflows reading the canonical bucket would otherwise halt at runtime far from the cause.

### Changed
- The built-in workflows' loop stages migrate to the new `loop:` field + `fanout()` / `iterate()` / `assess()` constructors (no behavior change): `FRONTMATTER_PHASE_FANOUT` / `PLANS_PHASE_FANOUT` become `fanout({ units })`, and `REVIEW_PHASE_ITERATE` becomes `iterate({ next })`. `implement` still fans out one pass per plan phase; polish's `blueprint` still iterates one pass per review phase.

### Added
- Per-unit model resolution for loop stages via the new `onUnitStart` lifecycle hook — a judge or per-phase unit's dispatched skill now resolves its model through the existing `models.json` `skills.<name>` cascade with no new configuration axes.

### Changed
- Action-required session banners share one boxed renderer (`renderBanner` in `banner.ts`). The agent-drift notice now uses the same rounded-box style as the missing-siblings banner, listing each drift category as a bullet with the `/rpiv-update-agents` call to action; passive status lines (copied/synced) stay single-line.

### Removed
- **Agent-manifest v1 migration + `.rpiv-managed.v2` sentinel.** The v1 (string-array) manifest format never reached production, so the one-shot "package wins" migration window and its sentinel marker are gone. `syncBundledAgents` now applies the smart gate uniformly: a file with no recorded hash, or whose content differs from it, is gated as `pendingUpdate`/`pendingRemove` and `/rpiv-update-agents` force-resolves. A leftover `.rpiv-managed.v2` file from earlier builds is inert.

## [1.19.1] - 2026-06-10

### Added
- New `pr-triage` built-in workflow — read-only triage for incoming GitHub PRs. The `pr-triage` skill fetches the PR thread, assesses the diff against repo standards, and writes a triage artifact with a recommended disposition; a script-stage security gate halts the run on BLOCK (`security_flag ≥ 2`) before any checkout. Chain: `pr-triage → security-gate → stop`. Adds the `triage` outcome bucket and brings the built-in workflow count from five to six.

### Fixed
- `rpiv-core` no longer fails to load with `Cannot find module '@juicesharp/rpiv-config'` (or `@juicesharp/rpiv-workflow/registration`) when those packages aren't resolvable from `rpiv-pi`'s install location — e.g. peers not nested under `rpiv-pi` combined with an install-scope split. Root cause is module resolution, not jiti's `exports`/`.ts` handling (jiti 2.7.0 resolves `.ts` subpath exports fine). Two fixes: `@juicesharp/rpiv-config` moves from `peerDependencies` to `dependencies` so npm always installs it alongside `rpiv-pi` regardless of peer settings or scope; and the `@juicesharp/rpiv-workflow/registration` value-import is deferred off the entry path (via the `outcome-derivation` chain) so a missing or non-co-located optional sibling degrades gracefully instead of crashing extension load. The absent-sibling guard now also recognizes jiti's `MODULE_NOT_FOUND` (Pi loads extensions via jiti) in addition to Node's `ERR_MODULE_NOT_FOUND`, so a genuinely-absent sibling stays a silent no-op rather than a noisy `[rpiv-core] failed to register` log. (#66)

## [1.19.0] - 2026-06-09

### Added
- Pipeline skills (`code-review`, `commit`, `design`, `discover`, `explore`, `implement`, `plan`, `research`, `validate`, and the annotate/handoff/frontend skills) now declare `produces`/`consumes` contracts in their frontmatter, so workflows can derive routing and validate stage-to-stage compatibility automatically.
- The `plan` skill emits a `phases:` frontmatter array and `implement` fans out one pass per plan phase; `architecture-review` phases carry scheduling metadata (`depends_on`, `blast_radius`, `effort`) so blueprint passes run in dependency order and each pass sees only the plans it depends on.

### Changed
- `ship` and `polish` presets are now contract-driven — their phase fan-out and stage outcomes derive from the plan's `phases` contract rather than hand-wired buckets.

### Removed
- Experimental prototype presets `blueprint-c`, `architecture-review-c`, `shipx`, and `polishx`; their proven behavior is now folded into the shipped `ship`/`polish` flows.

### Fixed
- `/code-review` now works inside a git worktree. The patch tempfile path resolves via `git rev-parse --git-path` instead of a hardcoded `.git/code-review-patch.diff`, which failed with `Not a directory` (ENOTDIR) where `.git` is a gitlink file. (#63)
- `implement` can check off `Automated Verification` checkboxes again; the plan-mutation ban is narrowed to plan content only. (#64)
- `validate` skill guidance no longer contradicts the runtime ordering of `implement → validate → commit`. (#62)

## [1.18.2] - 2026-06-04

### Fixed
- Workflow runs no longer halt when a planning skill pauses for developer input. `research`, `design`, and `blueprint` previously ended the assistant turn on a free-text "wait for the developer's response" gate (or the sanctioned "Free-text with ❓ Question:" question branch) before writing their artifact; inside a `/wf` run the runner reads turn-end as "stage done", finds no artifact path, and fails the stage (`research finished without producing a path matching …`), halting the chain. These pre-write checkpoints now go through the `ask_user_question` tool, which keeps the session alive across the pause; its automatic "Other" row preserves the free-text escape hatch, so standalone (non-workflow) behavior is unchanged. (#58)

## [1.18.1] - 2026-06-04

### Fixed
- Sibling detection now recognizes the API-compatible `@gotgenes/pi-subagents` fork (same `subagent` / `get_subagent_result` / `steer_subagent` tool surface), so users running it no longer see a false "1 sibling extension missing" banner on `session_start`. Detection-only change: `pkg` stays `npm:@tintinweb/pi-subagents`, so `/rpiv-setup` still installs the upstream fork by default, and the `LEGACY_SIBLINGS` prune leaves the scoped `@gotgenes` namespace untouched. The widened regex adds a `(?![-\w])` word boundary to avoid over-matching a hypothetical `@scope/pi-subagents-*` variant.

## [1.18.0] - 2026-06-04

### Added
- Per-agent and per-stage model/effort configuration via `~/.config/rpiv-pi/models.json`. Configured agents have `model`/`thinking` frontmatter injected at sync time; workflow stages have `setModel`/`setThinkingLevel` applied via lifecycle listeners. Supports `defaults` cascade into both agents and stages. 5-value ThinkingLevel vocabulary (`minimal|low|medium|high|xhigh`); "off" is rejected with a warning.
- Per-workflow per-stage overrides via `presets.<workflow>.stages.<stage>` — resolves before flat `stages[stage]`. Same five-value `thinking` vocabulary; per-field cascade against `defaults`.
- Per-skill overrides via top-level `skills.<name>` — applies to **both** workflow-dispatched skill stages (via the existing `onStageStart` lifecycle listener) AND user-typed standalone `/skill:<name>` invocations (via a new `input → agent_end` bracket). The standalone bracket arms only on explicit `skills[<name>]` entries (not on `defaults`) so your current session model stays sovereign when no per-skill override is configured.
- New `/rpiv-models` slash command — cascade pickers (scope → key → model → effort → save) for `~/.config/rpiv-pi/models.json`. Persists via `saveJsonConfig` and invalidates the in-process cache after every successful write. Skill picker source is live (`pi.getCommands()` filtered by `source === "skill"`) so third-party + user skills are pickable.
- `/rpiv-models` reset + at-a-glance UX: a "reset all overrides" scope (gated behind a confirm dialog) and a per-entry "Reset to default" — available on every scope including `defaults` — that removes one override with cascading empty-container cleanup and honest "Removed" vs "No override set" feedback. Every picker shows a `✓` where an override is set (scope level and key level) and floats the marked entries to the top; the model list floats the current selection to the top too (still checked + preselected).
- Warn-on-miss for `models.json`: a `session_start` validator surfaces record-key typos (`skills.committ`, `agents.codebase-analzyer`, `presets.shipp`, `presets.ship.stages.plann`) that pass schema validation but silently never apply. Warns once per process via `console.warn`. The `stages`/`presets` axes are validated only when rpiv-workflow can supply the workflow/stage universe — skipped (never false-warned) when the sibling is absent.

### Changed
- First-class `off` thinking level. `models.json` `thinking` now accepts all six values (`off | minimal | low | medium | high | xhigh`), and `off` is honored end-to-end — injected as `thinking: off` into agent frontmatter and applied via `setThinkingLevel("off")` at the stage/skill seams. `off` (disable reasoning) is now distinct from **omitting** the field (inherit the session baseline); the `/rpiv-models` effort picker offers `inherit (no override)` and `off (disable reasoning)` as separate choices. Previously the picker's "off" silently meant "inherit" and a persisted `thinking: "off"` was dropped with a warning. (Corrects the prior claim that `setThinkingLevel`/agent frontmatter reject `off` — they accept it; the restriction was rpiv-side only.)
- Canonical model-key form is now `provider/modelId` (slash-separated). Legacy `provider:modelId` (colon) form is still accepted on read for back-compatibility; new saves emit slash form. Persisted advisor configs auto-migrate on the next `/advisor` save; persisted `disabledForModels` arrays stay colon-form on disk and are normalised at compare time. **Rollback caveat**: rolling back across this release without first re-running `/advisor` on the older version silently disables the advisor (the older `parseModelKey` is colon-strict).
- Faster session start. Startup maintenance — per-cwd agent cleanup, bundled-agent sync, and the cleanup/drift/missing-siblings banner — now runs once per process instead of on every `session_start`, so programmatic spawns (each `/wf` stage, batch ops) no longer re-run the redundant filesystem work the immutable bundle made pointless. Built-in workflow registration and the model-override lifecycle now import rpiv-workflow's runner-free `/startup` entry, and the built-in workflow definitions are constructed on first `/wf` — keeping the workflow runtime off the session-start path. `/reload` and `/rpiv-update-agents` remain the explicit re-sync paths.

### Fixed
- `/rpiv-update-agents` now re-reads `models.json` before syncing, so mid-session edits to per-agent `model`/`thinking` overrides are injected into the agent frontmatter on disk. Previously the command reused the config cached at session start and silently re-injected stale overrides.
- The workflow model-override lifecycle now resets its baseline state before attempting restore at `onWorkflowEnd`, so a genuine (non-stale) failure while restoring the baseline model can no longer leave the override "armed" and poison subsequent workflows. Matches the clear-before-restore ordering already used by the standalone `/skill:` bracket.
- Stale extension context after auto-compaction no longer causes warnings or errors from guidance injection, git-context injection, or model-override lifecycle listeners.
- Startup no longer crashes with a barrel-initialization race when loading `rpiv-workflow`.

### Performance
- `blueprint` / `design`: slice overlap detection now uses deterministic file-and-symbol partitioning, further reducing verification time on large plans.

## [1.17.1] - 2026-06-01

### Performance
- `blueprint` / `design`: slice verification now skips cross-slice walks for slices that share no files or symbols, reducing verification time on large plans.

### Fixed
- Bundled `web-search-researcher` agent now selects only `web_search` and `web_fetch` instead of exposing the full `rpiv-web-tools` surface under `pi-subagents` 0.10. Run `/rpiv-update-agents` to refresh.

## [1.17.0] - 2026-06-01

### Added
- `design` and `blueprint`: new directional-decision tier in the developer checkpoint. Directional findings (extend-vs-replace, propagate-a-pattern, spread-a-convention) get a single batched confirm at Step 4, separate from genuine ambiguities. "Follow the pattern" is offered without a Recommended badge; "move off" promotes the finding to a one-at-a-time genuine question.
- `design` and `blueprint`: mandatory per-slice **Fit** line at Step 6.3 (reused / new surface / convention) renders on every slice regardless of the omit list.

### Fixed
- Clean `npm install @juicesharp/rpiv-pi` no longer crashes when the `@juicesharp/rpiv-workflow` peer is absent. Built-in workflow registration is now deferred behind a guarded dynamic import, so `/rpiv-setup` and the missing-siblings banner always load and can offer to install the missing sibling.

## [1.16.1] - 2026-05-30

## [1.16.0] - 2026-05-30

### Added
- New built-in `polish` workflow: `architecture-review → blueprint (iterate, one pass per review phase) → implement → validate → code-review → commit`. Built on rpiv-workflow's new `iterate` mode — each per-phase blueprint pass sees the plans already produced and builds on them. The implement fanout consumes only the latest blueprint pass, so a corrective re-plan supersedes the stale generation instead of double-implementing it.

### Fixed
- `polish` validate stage now validates every plan from the latest blueprint pass, not just the last one.

## [1.15.0] - 2026-05-28

## [1.14.7] - 2026-05-28

## [1.14.6] - 2026-05-28

## [1.14.5] - 2026-05-28

## [1.14.4] - 2026-05-28

### Fixed
- Missing-siblings banner alignment: prepend a newline before the box so Pi's `"Warning: "` severity prefix sits on its own line; every box row then gets Pi's uniform 1-space continuation indent and the border stays aligned. Before, the top border was pushed right by 9 columns relative to the body.

## [1.14.3] - 2026-05-28

### Changed
- Missing sibling extensions are now reported at session start as a yellow boxed banner (multi-line `notify("warning")`) listing each absent package and pointing at `/rpiv-setup`, instead of a single-line warning that scrolled away with conversation.

## [1.14.2] - 2026-05-28

## [1.14.1] - 2026-05-28

## [1.14.0] - 2026-05-28

> **Upgrade note:** After updating, run `/rpiv-setup` inside a Pi session to install the new `@juicesharp/rpiv-workflow` sibling that provides the workflows below. `pi update` alone won't pick it up — siblings have to be registered with Pi explicitly.

### Added
- `architecture-review` skill for top-down, layer-by-layer architecture reviews (experimental — under test).
- `ship` workflow — fast path with no research or review (blueprint → implement → validate → commit).
- `build` workflow — research-backed feature work with a review loop (research → blueprint → implement → validate → code-review → revise loop → commit).
- `arch` workflow — design-led pipeline for complex changes (research → design → plan → implement → validate → code-review → design loop → commit).
- `vet` workflow — examine existing changes for approval with optional repair (code-review → blueprint → implement → validate → loop → commit).
- Workflow runtime lives in `@juicesharp/rpiv-workflow` sibling package; rpiv-pi contributes these four built-in workflows via the sibling's `registerBuiltIns` API.

### Changed
- `blueprint` skill can now run standalone without a research artifact — accepts a free-text feature description as input.
- `research` and `blueprint` skills trigger `web-search-researcher` on any third-party API, SDK, or library surface, regardless of how the question is phrased.

### Removed
- `outline-test-cases` and `write-test-cases` skills.

### Fixed
- `implement` skill correctly honors phase scoping when dispatched via fanout.
- `validate` skill emits artifacts to the correct path and dispatches named subagents.

## [1.13.0] - 2026-05-25

### Changed
- `getPiAgentSettingsPath()` now delegates the agent-dir lookup to Pi's `getAgentDir()` (`@earendil-works/pi-coding-agent`). Closes a tilde-expansion gap when `PI_CODING_AGENT_DIR=~/...` and keeps the resolution logic in one place across rpiv-pi and Pi.

### Fixed
- Sibling package detection and `/rpiv-setup` legacy pruning now honor `PI_CODING_AGENT_DIR` instead of always reading `~/.pi/agent/settings.json`.

## [1.12.0] - 2026-05-21

## [1.11.0] - 2026-05-20

### Added
- New bundled agents `artifact-code-reviewer` and `artifact-coverage-reviewer` replace the monolithic `artifact-reviewer`, dispatched in parallel by `blueprint`, `design`, and `plan` skills with an aggregator triage step.

### Changed
- `blueprint` skill verification flow tightened and renumbered: clearer slice-verifier handoff and sequential workflow steps.
- `design` and `plan` skills now mirror the `blueprint` review topology — parallel code + coverage reviewers fanned out per artifact, then triaged.
- Skill metadata blocks cleaned across `blueprint`, `code-review`, `create-handoff`, `design`, `discover`, `explore`, `plan`, `research`, `resume-handoff`, `revise`, `validate`, and `write-test-cases` — stray contamination removed for cleaner pre-baked metadata.
- Relocate npm + MIT badges from the cover area to the License section in README.

### Removed
- Legacy `artifact-reviewer` agent (superseded by the code + coverage reviewer pair).

## [1.10.2] - 2026-05-20

### Changed
- Refresh npm cover (`docs/cover.{svg,png}`) to share the unified card layout used across the `@juicesharp/rpiv-*` family.

## [1.10.1] - 2026-05-19

## [1.10.0] - 2026-05-19

### Added
- `code-review` skill gains a `modified` scope that includes uncommitted edits on top of the branch diff.

### Changed
- Fourteen skills (`discover`, `research`, `explore`, `design`, `plan`, `blueprint`, `revise`, `validate`, `changelog`, `commit`, `create-handoff`, `resume-handoff`, `outline-test-cases`, `write-test-cases`) pre-bake runtime metadata via shell execution, eliminating per-invocation `date` and `git` shell commands.
- `commit` skill reads a pre-baked working-tree snapshot instead of issuing `git status` and `git diff` as opening turns, and now infers commit-message style from recent subjects.
- `code-review` is now an LLM-invoked helper script, restoring cross-platform support.

### Fixed
- `resume-handoff` correctly handles 0, 1, or 2+ available handoff files when invoked without arguments.
- `code-review` `working` scope semantics corrected (uncommitted-only).
- Skill template metadata placeholders now reference the Metadata block instead of bare shell expansions.

## [1.9.2] - 2026-05-19

### Fixed
- Status bar no longer prefixes user-supplied or third-party skills with `rpiv:`. The prefix now only appears for skills bundled with rpiv-pi.

## [1.9.1] - 2026-05-19

## [1.9.0] - 2026-05-18

## [1.8.3] - 2026-05-18

### Fixed
- Empty `.rpiv/artifacts/` directory tree no longer appears on session start when no migration source exists (closes #31). The 1.8.2 migration removed `thoughts/` scaffolding but reintroduced the same greedy `mkdir` loop under the new path; artifact subdirectories are now created on first write by the Write tool, as the FRD originally specified.
- Migration is now gated on the source actually containing entries: if `thoughts/shared/` exists but is empty, `.rpiv/artifacts/` is no longer created and the empty source is left in place.
- Loose files at the `thoughts/shared/` root are now copied alongside subdirectories instead of being dropped on `rmSync`.

## [1.8.2] - 2026-05-17

### Changed
- Pipeline artifacts migrated from `thoughts/shared/` to `.rpiv/artifacts/`, with automatic migration of existing content on session start.

## [1.8.1] - 2026-05-17

## [1.8.0] - 2026-05-16

### Changed
- Update README to document the multi-provider web search architecture.
- Bundled `web-search-researcher` agent no longer runs isolated, so it can share context with the calling session.

## [1.7.0] - 2026-05-15

### Changed
- Bundled agents sync to `~/.pi/agent/agents/` globally instead of per-working-directory, with automatic migration of existing per-cwd installs and crash-safe manifest writes.

### Breaking / Upgrade Notes
- Internal: `syncBundledAgents` signature drops the `cwd` parameter (no user action required; only in-package consumers).

## [1.6.1] - 2026-05-14

## [1.6.0] - 2026-05-14

### Added
- `discover` skill frames shape-tier questions as explicit tradeoff tensions with three scope-drift guardrails and a new Suggested Follow-ups section in the FRD output.

## [1.5.2] - 2026-05-13

## [1.5.1] - 2026-05-13

## [1.5.0] - 2026-05-12

### Changed
- `blueprint` skill now uses a dedicated adversarial verifier for per-slice micro-checkpoints, improving output quality.
- Renamed `plan-reviewer` agent to `artifact-reviewer` with generalized vocabulary for any phased artifact.

### Fixed
- `web-search-researcher` agent now runs with a fresh context on each invocation.
- Blueprint skill's slice verification passes the current slice code to avoid false-positive emptiness violations.

## [1.4.2] - 2026-05-11

## [1.4.1] - 2026-05-11

### Fixed
- `blueprint` skill reuses the resolved plan path for `plan-reviewer` dispatch, fixing a path-resolution failure on Windows.

## [1.4.0] - 2026-05-10

### Added
- `codebase-locator` agent now tags definitions with role labels and surfaces a ranked Primary Anchors section for faster code navigation.
- Bundled agents auto-sync on session start — new agents install, unchanged agents update, and stale entries remove automatically without running `/rpiv-update-agents`.

### Fixed
- Hardened bundled-agent sync with crash-safe manifest writes, deterministic migration gating, and surfaced error reporting for sync failures.

### Security
- Reject path-traversal manifest keys in bundled-agent sync, blocking crafted entries that could read or write files outside the agent directory.

### Breaking / Upgrade Notes
- On first session start after upgrade, any local edits to `.pi/agents/*.md` will be overwritten with the bundled version. Copy aside files you want to preserve before upgrading.

## [1.3.1] - 2026-05-10

### Added
- `plan-reviewer` agent with adversarial plan vetting, wired into the `blueprint` skill as a mandatory review gate before developer hand-off.

### Changed
- `blueprint` skill structurally streamlined — Success Criteria inlined into phase definitions and internal steps consolidated, yielding faster plan execution. The latency gain was traded for a gated adversarial review that validates plan quality before hand-off.
- `frontend-design` skill auto-resolves scan findings into empty, near-complete, or partial mode and tailors the interview depth accordingly; checkpoint questions now demand commitment over hedging.
- Research artifacts omit the redundant "Questions Investigated" section (questions are preserved in their own artifact).
- Scope-tracer citations now lead with canonical definition sites, following the definition-first ranking insight from [Entire's agentic search study](https://entire.io/blog/improving-agentic-search-in-coding-agents), yielding faster and higher-quality question generation.

## [1.3.0] - 2026-05-08

### Added
- `frontend-design` skill for creating distinctive, production-grade frontend interfaces.

### Changed
- `/btw` command and `rpiv-btw` package are no longer bundled in the auto-install set. Existing installs keep working; new users install via `pi install npm:@juicesharp/rpiv-btw`.

### Breaking / Upgrade Notes
- `rpiv-btw` is removed from the `/rpiv-setup` auto-install bundle. Users who rely on `/btw` being present after a fresh install must add it explicitly: `pi install npm:@juicesharp/rpiv-btw`.

## [1.2.1] - 2026-05-07

### Changed
- `/skill:code-review` next step now recommends `/skill:design` over the review document instead of `/skill:revise` on an in-flight plan.

## [1.2.0] - 2026-05-07

### Added
- `/skill:changelog` — regenerates the `[Unreleased]` section of every affected CHANGELOG.md from commits since the last release tag, classified by Conventional Commit prefix and written as Keep a Changelog 1.1.0 prose. Idempotent — safe to re-run as work lands.
- `/skill:discover` restored as an interview-driven Feature Requirements Document producer. One question at a time with a recommended answer, grounded by light agent fan-out, writing a timestamped artifact to `thoughts/shared/discover/`. Decision blocks in the FRD chain into `research` as Developer Context entries.
- `scope-tracer` agent: Analyzer-tier specialist that formulates 5–10 numbered research questions inline for `research` to parse in-memory, replacing the former discover question-formulation procedure. Auto-syncs to the agent directory on first session after upgrade.

### Changed
- Standardized printed footer across all skills with a consistent follow-up prompt, next-step command, and `/new` tip. Unified the follow-up handling policy for appending answers, bumping frontmatter, and re-dispatching narrowly.
- Placeholder syntax in templates and agent files changed from `[Verbose]` to `{Verbose}`. Update any custom skills or agents that reference the bracket notation.

### Breaking / Upgrade Notes
- The old `/skill:discover` (codebase-discovery question-formulator) is permanently removed. Its question-formulation role is now handled by `scope-tracer` inside `research`. Custom skills that referenced the old discover for question-formulation should call `/skill:research "<topic>"` directly.

## [1.1.5] - 2026-05-05

### Changed
- Guidance injection now frames the injected `architecture.md` payload as a non-task reference with an explicit "consult only when relevant" trigger, reducing the chance the agent treats it as an instruction to act on.
- Skill descriptions across the skill library rewritten for the Pi matcher's discovery heuristic — clearer trigger phrases and crisper one-line summaries so the right skill surfaces for the right prompt.

## [1.1.4] - 2026-05-03

## [1.1.3] - 2026-05-03

## [1.1.2] - 2026-05-03

## [1.1.1] - 2026-05-03

## [1.1.0] - 2026-05-03

### Added
- Sibling registry entry for `@juicesharp/rpiv-i18n` — `/rpiv-setup` now installs the i18n SDK alongside the rest of the rpiv-* family, surfacing `/languages` and the `--locale` flag. Word-boundary anchored regex (`/rpiv-i18n(?![-\w])/i`) so future `rpiv-i18n-*` packages don't collide.

## [1.0.19] - 2026-05-03

## [1.0.18] - 2026-05-02

## [1.0.17] - 2026-05-02

## [1.0.16] - 2026-05-02

## [1.0.15] - 2026-05-02

## [1.0.14] - 2026-05-01

### Changed
- Cover redesigned as a macOS-style terminal-window screenshot with a horizontal six-stage pipeline rail (DISCOVER → VALIDATE).

## [1.0.13] - 2026-05-01

### Added
- `docs/vertical-cover.{svg,png}` — portrait-orientation hero artwork (1280×800 canvas; PNG downscaled to 320×711).

### Changed
- Cover canvas extended from 1280×640 to 1280×800 with refreshed crop marks/footer.
- README hero swapped from `docs/cover.png` to `docs/vertical-cover.png`, rendered at `width="160"`. The `<a>` wrapper around the `<picture>` was removed so the image is no longer a clickable link to the package directory.

## [1.0.12] - 2026-05-01

### Added
- `docs/cover.png` — package hero (rasterized from `docs/cover.svg` via `rsvg-convert`, 1280×640).

### Changed
- README now opens with a `<picture>`-wrapped `cover.png` hero so pi.dev's package-card image extractor picks the friendly artwork instead of the npm version shield.
- `research` skill now wires the blueprint skill as an explicit downstream path alongside `design`; matches the existing two-track `design` vs `blueprint` flow on the consumer side.

### Fixed
- `research` skill no longer leaks `rpiv-args` invocation tokens into prompts. Tightens the templating boundary so `${args}` substitutions never reach the rendered output.

## [1.0.11] - 2026-04-30

### Changed
- README: added a `## What you get` section above Prerequisites — three-bullet outcome summary (chained AI skills pipeline, named subagents for parallel analysis, session lifecycle hooks) so the elevator pitch lands above the fold.

## [1.0.10] - 2026-04-30

### Added
- **`blueprint` skill** (`packages/rpiv-pi/skills/blueprint/SKILL.md`): single-shot alternative to the `design` → `plan` split. Reads a research or solutions artifact and emits an implement-ready phased plan directly into `thoughts/shared/plans/` using the same vertical-slice decomposition + developer micro-checkpoints as `design`. Lighter on subagent fan-out than `design` — spawns only `codebase-pattern-finder` upfront and trusts the research artifact's `## Integration Points` and `## Precedents & Lessons` sections instead of re-dispatching `integration-scanner` / `precedent-locator` / `codebase-analyzer`. Use when a separable design artifact isn't needed for review or handoff.
- **README Implementation table + Recipes entry** for `blueprint`. New "One-shot plan from research" recipe explains the tradeoff vs `design` → `plan`.

### Changed
- **`research` skill — `## Precedents & Lessons` template restructured** (`packages/rpiv-pi/skills/research/SKILL.md`): replaced the single composite-bullet section with per-precedent blocks (commits, blast radius by layer, follow-up fixes, doc lessons, takeaway) plus a trailing `### Composite Lessons` block. Surfaces blast radius and follow-up history that `blueprint` and `design` consume directly from the artifact.
- **`discover` skill — dropped the post-write rubber-stamp checkpoint** (`packages/rpiv-pi/skills/discover/SKILL.md`): the trailing "Looks good / I want to adjust" `ask_user_question` never pulled new information — research's own guidance forbids exactly that shape. Iteration moves to Step 7 (Handle Follow-ups), where the user reacts to the written artifact.
- **`research` skill — simplified Agent dispatch** (`packages/rpiv-pi/skills/research/SKILL.md`): the free-text branch's Agent dispatch no longer needs the "non-interactive mode" carve-out (moot now that `discover` is uniformly non-interactive at question time). Compresses the dispatch prompt to a single line.

### Removed
- **`design2` and `plan2` skills**: experimental grill-me variants superseded by `blueprint`. Neither was documented in the README; removal is internal cleanup.
- **"CC auto-loads CLAUDE.md files…" note** from `design`, `discover`, and `write-test-cases` SKILL.md `## Important Notes` sections. The note is a Claude Code convention that does not apply to Pi Agent.

## [1.0.9] - 2026-04-30

## [1.0.8] - 2026-04-29

## [1.0.7] - 2026-04-29

## [1.0.6] - 2026-04-29

## [1.0.5] - 2026-04-29

## [1.0.4] - 2026-04-28

## [1.0.3] - 2026-04-28

## [1.0.2] - 2026-04-28

## [1.0.1] - 2026-04-28

### Fixed
- **Stale version labels**: README upgrade banner, `extensions/rpiv-core/siblings.ts` `LEGACY_SIBLINGS` comment + `reason` string, and `extensions/rpiv-core/prune-legacy-siblings.ts` background-comment all referenced "0.14.0" — the working label used while preparing the revert. The actual published major-bump from `0.13.3` was `1.0.0` (semver: 0.x → 1.0 on `npm version major`). All three sites now read `1.0.0`. Documentation-only; no behavior change.

## [1.0.0] - 2026-04-28

### Changed
- **Subagent provider reverted to `@tintinweb/pi-subagents`**: tintinweb resumed active maintenance with `0.6.x` (latest `0.6.3`), tracks `@mariozechner/pi-coding-agent` `^0.70.5`, and ships a simpler `Agent` tool surface (single tool + 3-5 word `description`, no `parallel`/`chain` mode overload, native `general-purpose` / `Explore` / `Plan` defaults). `siblings.ts SIBLINGS[0]` rewritten back to `npm:@tintinweb/pi-subagents` with the scoped-name regex; `LEGACY_SIBLINGS` inverted so `/rpiv-setup` now prunes the unscoped `npm:pi-subagents` (nicobailon fork) entry on upgrade.
- **Pi peer bumped**: root `devDependencies` and `peerDependencies["@mariozechner/pi-coding-agent"]` now pull `^0.70.5` (was `^0.67.68`). `pi-ai`/`pi-tui` bumped in lockstep. `@tintinweb/pi-subagents@0.6.3` requires this floor.
- **TypeBox migrated to `typebox@1.x`**: pi-ai 0.70 dropped `@sinclair/typebox` for the new `typebox` package. All sibling tool-parameter schemas (`rpiv-advisor`, `rpiv-todo`, `rpiv-web-tools`, `rpiv-ask-user-question`) and `rpiv-test-utils` now import from `typebox`. Same API surface for our usage; no behavioral change.
- **`rpiv-args` Pi 0.70 compatibility**: `loadSkills()` now requires the new `agentDir` option (Pi 0.70 dropped the default). `args.ts` passes `getAgentDir()` from `pi-coding-agent`.
- **Agent frontmatter reverted to `isolated: true`**: all 12 bundled agents (`agents/{claim-verifier,codebase-analyzer,codebase-locator,codebase-pattern-finder,diff-auditor,integration-scanner,peer-comparator,precedent-locator,test-case-locator,thoughts-analyzer,thoughts-locator,web-search-researcher}.md`) replaced the explicit three-key recipe (`systemPromptMode: replace` + `inheritProjectContext: false` + `inheritSkills: false`) with the single-key `isolated: true` that tintinweb parses. Behavioral semantics preserved.
- **Skill vocabulary reverted to tintinweb's tool schema**: all skills that fan out (`annotate-guidance`, `annotate-inline`, `code-review`, `design`, `design2`, `discover`, `explore`, `implement`, `outline-test-cases`, `plan2`, `research`, `resume-handoff`, `revise`, `validate`, `write-test-cases`) now reference the `Agent` tool and `subagent_type:` parameter name. Frontmatter `allowed-tools:` entries had `subagent` replaced with `Agent` (Pi enforces this list literally; without the rename, `@tintinweb/pi-subagents@0.6.3` could not dispatch). Call-shape sites rewritten from `subagent({ agent, task, context: "fresh", artifacts: false })` to `Agent({ subagent_type, description, prompt })`. `.rpiv/guidance/agents/architecture.md` and `.rpiv/guidance/skills/architecture.md` updated to cite the new tool name, package name, and call shape.
- **Agent description frontmatter vocabulary**: `agents/{thoughts-analyzer,codebase-pattern-finder,web-search-researcher}.md` `description:` fields use `subagent_type` again (matches the `@tintinweb/pi-subagents@0.6.3` tool vocabulary the dispatching model reads).
- **Concurrency persistence**: README rewritten to drop the `~/.pi/agent/extensions/subagent/config.json` seeding section; the `/agents → Settings → Max concurrency` UI breadcrumb is back. tintinweb 0.6.x persists this setting natively.

### Removed
- **`extensions/subagent-widget/` extension**: the 22-file proxy + live overlay + builtin-filter + agent-catalog package is gone. tintinweb 0.6.x ships its own quiet inline `Agent` card and a 3-default-agent roster, so the proxy and the per-agent description rewrite carried no weight against the simpler upstream surface.
- **`extensions/rpiv-core/claim-pi-subagents.ts`**: stripped `npm:pi-subagents` from `settings.json` so the proxy was the sole loader. With the proxy gone, `@tintinweb/pi-subagents` loads as a normal sibling — no claim required.
- **`extensions/rpiv-core/ensure-builtins-disabled.ts`**: seeded `subagents.disableBuiltins: true` to hide nicobailon's 9 bundled agents from `/agents`. tintinweb's roster is 3 agents (all rpiv skills already use), so no hiding is necessary.
- **`extensions/rpiv-core/ensure-subagent-config.ts`**: seeded `~/.pi/agent/extensions/subagent/config.json` with `parallel.concurrency` + `maxSubagentDepth`. tintinweb persists concurrency via the `/agents` UI; the seeding helper is no longer needed.
- **`agents/general-purpose.md`**: `@tintinweb/pi-subagents@0.6.3` ships `general-purpose` as a default agent (broad tool set, inherits project context). Skills referencing `general-purpose` now resolve to tintinweb's builtin — no rpiv-pi profile required.
- **`pi-subagents` stub d.ts files** (`extensions/subagent-widget/pi-subagents-stubs/*`) and the `tsconfig.base.json` `paths` entries that pointed at them.

### Breaking / Upgrade Notes
- **Upgrading from `0.13.x`**: run `/rpiv-setup` once and restart Pi. It will prune `npm:pi-subagents` from `~/.pi/agent/settings.json` and install `npm:@tintinweb/pi-subagents`. The `Agent` / `get_subagent_result` / `steer_subagent` tools and `/agents` command continue to work — call shape changes from `subagent({ agent, task })` to `Agent({ subagent_type, description, prompt })`, but only your own custom skills/agents need editing; the 12 rpiv-pi specialists are migrated in this release.
- **User-customized bundled agent files**: `/rpiv-update-agents` overwrites edits to rpiv-managed filenames. With 12 agent frontmatters changing in this release (single-key `isolated: true` replaces the three-key recipe), copy your customizations to a different filename before running `/rpiv-update-agents` if you have edits.
- **Pi version floor**: `@mariozechner/pi-coding-agent` `^0.70.5` is now required (was `^0.67.68`). Pi versions older than `0.70.5` will fail peer-dep resolution.
- **Existing `~/.pi/agent/extensions/subagent/config.json`**: harmless leftover. tintinweb does not read this file; you can delete it manually.
- **Existing `subagents.disableBuiltins: true` in `settings.json`**: harmless leftover. tintinweb does not parse this key.
- **Async dispatch (`async: true`) gone**: nicobailon's background-dispatch mode is not part of tintinweb's `Agent` schema. Skills no longer reference it; if you used it in custom skills, switch to `run_in_background: true` (tintinweb's equivalent) or remove the parameter.
- **Rollback**: git revert the release commit and `pi install npm:@juicesharp/rpiv-pi@0.13.3`.

## [0.13.0] - 2026-04-28

## [0.12.7] - 2026-04-26

## [0.12.6] - 2026-04-26

### Changed
- **`general-purpose` agent now inherits project context**: frontmatter switched to `systemPromptMode: append` + `inheritProjectContext: true` so the generalist sees Pi's base system prompt plus the project's `AGENTS.md`/`CLAUDE.md`, matching the delegate-style generalist pattern. Skills catalog (`inheritSkills: false`) stays excluded.
- **`general-purpose` agent now has the full tool surface**: dropped the read-only `tools: read, grep, find, ls, bash` allowlist so the generalist can handle multi-step tasks that require writes or mutating commands. Specialists (Explore, Plan, etc.) remain narrowly scoped.

### Documentation
- README: new code-review recipes section under usage; agent descriptions unified across the 13 specialists; clarified the parallel subagent dispatch one-liner.

## [0.12.5] - 2026-04-24

### Changed
- `/agents` overlay now hides the upstream built-in agents — the list shows only the rpiv-pi specialists you dispatch to.

## [0.12.4] - 2026-04-24

### Changed
- The `subagent` tool now only offers rpiv-pi's 13 specialist agents to the assistant — the disabled built-in agents from the upstream library are no longer presented as dispatch options, so the assistant always lands on a curated rpiv specialist. Each agent's purpose is shown inline when the tool is used, sourced directly from its `agents/<name>.md` file, so editing an agent's description immediately updates what the assistant sees.

## [0.12.3] - 2026-04-24

### Fixed
- **Stats stay visible on long task descriptions**: the overlay's descriptor column is now capped to 40 characters (with an ellipsis), so `⟳N · N tool uses · Nk · Ns` never gets clipped off the right edge of the terminal.
- **Overlay auto-clears across orchestrator turns**: finished subagent rows now age out across `turn_start` events (not just user input), and a new wave purges the prior wave's lingering rows on its `tool_execution_start`. No more stale rows persisting forever when the orchestrator keeps working.
- **Inline subagent card has a pending state from the first frame**: `renderCall` now appends a layout-stable `○ pending` / `◐ running` trailer (coordinated with `renderResult` via shared render-context state) so the card is always 2 lines while non-terminal, eliminating the 1↔2-line oscillation.
- **Consistent ellipsis marker**: the subagent + todo overlays now use a single-char `…` everywhere a line is truncated, matching the descriptor cap. Prior `...` (three dots) from pi-tui's default mixed two styles inside the same widget.
- **Subagents overlay has a trailing blank separator**: one empty row below the tree so the overlay no longer hugs the Todos (or any other) widget sitting directly beneath it.

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
