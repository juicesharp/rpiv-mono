# Changelog

All notable changes to `@juicesharp/rpiv-pi` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.7.1] - 2026-08-24

### Changed

- **Build's validate loop verifies its own progress — three seams close the futile-lap livelock.** Run 2026-08-22_12-14-12-64eb: validate failed on two whole-plan gates recorded only in report prose (all seven risk rulings passed), so the `remediate` arm — contractually restricted to `pass: false` rulings — drift-escaped without an edit, and the unchanged tree re-validated to the identical verdict four times (~27 minutes of full-suite re-runs) until the backward-jump guard halted the run at `reconcile`, misattributed. (1) The validate gate now classifies a fail before routing (`validateGate`, the ship-gate `setRouteNote` pattern): only a fail carrying a remediable handle — a `pass: false` ruling or a structured `blockers:` entry — reaches `validate-fix`; a prose-only fail STOPs at the gate with a note naming why. (2) The validate skill emits whole-plan/automated-command failures it attributes to in-delta files as `blockers: [{ id, command, file, line }]` frontmatter, and remediate's fixable partition accepts them — the failing command is the procedure, same one-fix-attempt discipline — so the loop can now converge on the failure class that livelocked. (3) `validate-fix` carries a `remediationOutcome` (the `commit`/`gitCommitOutcome` shape): a git-only tree digest snapshotted around the stage publishes `{ changed }` on the `remediation` channel, and the arm's edge — now a decision — STOPs on an explicit unchanged tree (re-validating an unchanged tree is provably futile; a missing signal proceeds, the worktree-digest degrade doctrine). The repair-arm authority rule the slice gate learned the same way: a gate may only loop into an arm whose authority covers the failure classes it emits.

## [2.7.0] - 2026-08-21

### Added

- **A deterministic `scope-quarantine` remedy arm joins build and vet.** When every path the lane scope floor flags is a run-created UNTRACKED file (`git status` `??` — provably absent from the run-start baseline, owned by no phase), the floor's verdict tiers to `untracked-only` and routes to the new stage, which MOVES (never deletes) each file under `.rpiv/tmp/scope-quarantine/<path>`, records every move and refusal in a basename-keyed manifest beside the scope verdict — MERGED across fix-loop rounds and written in a `finally` so a mid-loop fs failure still lands completed moves on disk — and re-enters the floor: a plain non-counted hop with guaranteed progress (quarantined paths leave the dirty set), so at most one quarantine round per gate entry. The manifest is the adjudication record: validate checks it unconditionally (the post-quarantine re-check threads a clean `pass` verdict, so the manifest is the only surviving account of what moved), ruling scratch benign and a moved file the deliverable needs a blocking plan deviation. Nothing is lost: a load-bearing file landing there means its phase forgot to declare it in `files:`, validate fails on the missing file, and the manifest names where it went. Motivated by run 2026-08-20_18-10-39-17e7: a validate-fix round left two scratch scripts in an untracked `.tmp/` and the floor's terminal fail killed a functionally green five-hour run — twice, since the resume re-judged the same dirty tree.

### Changed

- **The scope floor no longer halts on its own findings — tracked excess is demoted and adjudicated by validate.** `implement-scope-check`'s verdict is now tiered (`pass` / `untracked-only` / `excess`): tracked excess continues to reconcile/validate with the findings recorded at severity `high`, and build's validate dispatch threads the verdict JSON via a new `--scope` flag (the `--cite-check` pattern — the deterministic floor produces evidence, the LLM judge rules). The validate skill rules on each finding: explained churn (a lockfile or generated artifact a declared phase's own commands produce) is a non-blocking note; an out-of-scope write it cannot explain forces `verdict: fail` into the existing validate-fix loop. A deterministic floor cannot tell a benign lockfile touch from a real cross-phase stomp — the citation-floor overhaul's audit logic applies verbatim. Only a missing/corrupt verdict remains terminal at the gate (the integrity clause every de-halting change has preserved), and ship deliberately keeps its stop-on-fail route (no fix loops is its contract). Vet wires the same tiered route; its review loop sees the whole diff and adjudicates there. Ship's validate dispatch also carries `--scope` (it shares `VALIDATE_GOAL_PROMPT`) — by construction the verdict there is always `pass` when validate runs (a non-pass stops at the gate), so the skill's adjudication step short-circuits on empty findings; consistent evidence plumbing, not a behavior change.
- **The artifact collector recovers a prefix-mangled announcement via a disk-corroborated basename fallback.** When the full-path transcript scan misses (run 2026-08-21_12-15-19-ec5e: the agent wrote its elaboration to the correct path but announced it as `.elaborations/<file>.md` — directory prefix mangled in prose, stage fataled while a verified-green 38KB artifact sat on disk), the collector now scans the transcript for bare `<file>.md` tokens (tempered — an elided `...__phase-N.md` still never resolves) and accepts a candidate ONLY when it names exactly one existing file under `.rpiv/artifacts/` (the collector's own bucket for the bucket-narrowed form). The agent's announcement still drives collection — disk existence corroborates it, so a stray prose mention or an ambiguous basename never collects; with no unique resolution the original fatal stands.
- **The artifact collector no longer mistakes a prose ellipsis for an announced path.** `RPIV_ARTIFACT_PATTERN` (and `rpivBucketCollector`'s filename segment) now reject `..` anywhere in a path segment via a tempered class. Regression from the same run: the phase-5 elaborate agent announced its real artifact, then referred to a sibling's as `` `.rpiv/artifacts/elaborations/...__phase-4.md` `` — a valid `[\w.-]+` string, so the last-match scan collected the elided path, fataled on a file that never existed, and silently dropped the real 30KB elaboration from the splice. The elaborate skill additionally pins the announcement contract: the artifact path must be the LAST full `.rpiv/artifacts/...` path in the reply; siblings are referenced by basename only.
- **Skills that shell out learn the scratch-space contract, and plans stop promising unachievable whole-plan gates.** remediate, implement, and validate now carry the rule the scope floor enforces: repo-located scratch (probe scripts, fixtures, captured payloads) lives under `.rpiv/tmp/` — exempt from the floor — or outside the repo, and is deleted when done; the floor counts untracked files (`-uall`), so scratch anywhere else is an undeclared write. synthesize and plan gain the whole-plan gate achievability rule: repo-wide style gates (lint/format) default to the delta-scoped form over the plan's file union, and an absolute repo-wide "exits 0" is reserved for build/test commands or gates evidenced green at base — run 17e7's plan promised `npm run lint` exits 0 against 95 pre-existing errors in files it never touched, an unpassable criterion that burned all three validate rounds. validate closes the loop from the judging side: a whole-plan command failure attributable ENTIRELY to files outside the run's delta (proven per file with `git diff --quiet <base> -- <file>`) is ruled pre-existing debt — reported, non-blocking — instead of forcing `verdict: fail`.
- **The validate skill drops its two subagent dispatches; the pattern check runs inline.** Validate no longer spawns `codebase-analyzer` + `codebase-pattern-finder` (`Agent` leaves its `allowed-tools`). A run-history audit of 64 validate runs (127 dispatches, ~4.8M tokens) found 80% pure rubber stamps and only 2 verdict-affecting catches — both stale references and invalidated statements left in comments and docs. That one earning class is now an inline step: compare new files against established siblings for shape, grep for renamed/removed terms lingering in comments, docs, or test descriptions. Generic checks only — the skill ships to every rpiv-pi project.

## [2.6.4] - 2026-08-20

### Changed

- **The citation floor's last blocking citation category is demoted — every citation-resolution finding is now advisory.** 2.6.3 kept a resolves-to-nothing citation `high`/blocking as the one fabrication-shaped category; `verifyCitations` now marks all four finding shapes ADVISORY (`advisory: true` on the finding): unresolved path, ambiguous bare/suffix citation, post-resolution read failure, and line range past end-of-file. An advisory-only structure verdict rates `severity: low` (still `pass: false`, findings persisted), which the gates' `allDimensionsPass` severity floor rides through. Only the `files:` coverage floor (an undeclared write corrupts implement's dependency derivation) still rates `high` and blocks. Forced by the run-history audit: across three months, 71 distinct flagged paths yielded ZERO fabrications — the whole no-match population was resolver gaps, meta-plan fixture prose, and one garbled-but-real path — while blocking on them cost ~8 hours of fix rounds, two dead ship runs, and one four-round identical-findings churn loop. A genuinely wrong path is still caught: the grade correctness unit receives the findings via `--cite-check`, and its citation-resolution rule treats a file that exists nowhere as a real finding.
- **The citation resolver closes its three worst false-positive gaps.** The suffix walk now carves `.rpiv/guidance` back in (the guidance shadow tree is a routinely-cited and routinely-edited target; skipping it made every suffix-form `architecture.md` citation a false "does not exist") while `.rpiv/artifacts` stays invisible; a no-match citation is rescued by a unique whole-segment suffix match in the plan's own declared `files:` (verified against the file when it exists, skipped as a forward reference when the declaration is a planned CREATE); and the file-existence probes no longer race a concurrent delete into a `FAIL_SCRIPT_THREW` halt.
- **The plan-time coverage floor stops flagging non-writes.** Backticked list-item paths count as declared writes only inside a Changes section (`### Changes` heading or `**Changes**:` field) — a reference bullet elsewhere ("mirror `x/state.ts`") no longer reads as an undeclared write; `isPathLike`'s extension is bounded to 1–5 chars mirroring the citation regex, so a dotted identifier (`deps.finalize` — a live run's blocking finding and wasted code-fix round) never reads as a file; and a body form citing a declared file by bare basename or partial path is covered via whole-segment suffix match instead of demanding the bare name be added to `files:` (which would have corrupted the very dep-derivation the floor protects).

## [2.6.3] - 2026-08-20

### Changed

- **The deterministic citation floor no longer halts a run over ambiguity or line drift — findings are severity-tiered.** `verifyCitations` now marks resolver-limitation shapes ADVISORY (`advisory: true` on the finding): an ambiguous bare/suffix citation whose every candidate is a real tree file, a post-resolution read failure, and a line range past end-of-file. An advisory-only structure verdict rates `severity: low` (still `pass: false`, findings persisted), which the gates' `allDimensionsPass` severity floor rides through — so `ship`'s loop-less `plan-cite-check` gate no longer terminates a full goal→research→plan run over a path-prefix omission, and `build`/`vet`'s fix loops stop burning `plan-fix`/`code-fix` rounds on them. A citation that resolves to NOTHING by any strategy — the one fabrication-shaped category — and a phase-body edit missing from `files:` (the coverage floor implement's dep fanout relies on) still rate `high` and block exactly as before. Motivated by the run-history audit: every terminal ship cite-stop on record was an advisory shape, and none was a fabrication.
- **Ship's grade panel now adjudicates the citation floor's advisory findings.** When the latest `plan-cite-check` verdict carries findings (advisory by construction at that point — a blocking finding stops before grade), `SHIP_DIMENSION_FANOUT` threads the verdict JSON to the correctness unit as the `grade` skill's new optional `--cite-check <verdict-path>` flag. The grader folds each finding into its live-codebase spot-check — resolving the citation by file + symbol per the citation-resolution rule — and reports a finding only when the underlying claim is actually wrong, so advisory findings are read and ruled on instead of rotting on the trail. The flag is correctness-only, never triggers confirm mode, and produces no `finding_rulings`.

- **Standalone iterative design now crosses a hard session boundary after every approved non-final slice.** The exact verified code and Success Criteria are written to the design artifact and re-read to confirm they match the approved payload, then the run stops with a fresh-session `/skill:design --resume <artifact>` command. Resume mode reads locked slices and the first pending slice from the artifact instead of trusting conversational or compaction summaries. This bounds verifier-heavy slice work to one slice per Pi context.

### Fixed

- **Overflow recovery no longer answers RPIV's hidden pipeline/Git messages instead of resuming the interrupted task.** `session_compact` previously called `pi.sendMessage` separately for root guidance, the pipeline pointer, and Git context. Pi correctly treated them as queued steering items; default one-at-a-time delivery then produced one assistant acknowledgement per control message and displaced the active task. Compaction now only marks the exact SessionManager identity. Overflow retry proceeds directly from the compaction summary, and the session's next real user turn receives one merged hidden context block from `before_agent_start`.

## [2.6.2] - 2026-08-18

## [2.6.1] - 2026-08-17

### Added

- Package card cover on pi.dev: `package.json` now declares `pi.image` pointing at the package's `docs/cover.png`.

## [2.6.0] - 2026-08-15

### Added

- Support Pi's `max` thinking level in `models.json` and the `/rpiv-models` picker when the selected model advertises it.

### Fixed

- **The plan citation floor now disambiguates against the plan's own declared write-set.** An ambiguous bare/suffix citation (`messages.ts:18` matching several tree files) resolves deterministically when exactly one candidate is in the union of the plan's frontmatter `files:` arrays; a tie inside the declared set, or an empty intersection, still fails the floor. Previously such a citation always failed `plan-cite-check`/`code-cite-check` — terminal for the loop-less `ship` preset, which halted a full run over a mechanical path-prefix omission the plan itself had already resolved.

## [2.5.2] - 2026-08-14

## [2.5.1] - 2026-08-14

## [2.5.0] - 2026-08-13

### Added

- **Each lane now shows an end-of-run recap.** When a run reaches a terminal
  state, the lane surfaces a one-line summary — the newest artifact, a
  `+N more` count when more landed, and the `⚠ <reason>` segment for a
  non-completed outcome — projected from the run's on-disk JSONL trail via
  rpiv-workflow's new `summarizeRun`. Auto-shown, no toggle; the entries under
  Changed/Fixed below refine this feature's storage and presentation.

- **The `ship` workflow is back — rebuilt as a lightweight `/wf` preset.** A single forward pass for a small, well-understood task: `goal → research → plan → plan-cite-check → grade → implement → implement-scope-check → reconcile → validate → commit`, stop-on-fail at every gate — no fix loops, confirm panels, snapshots, or code-elaboration lane. Research is front-loaded and trimmed (a custom prompt stage with at most two `codebase-analyzer` dispatches, not a full `/skill:research` pass), the plan comes from the new `quick-plan` skill, and one tier-independent grade (correctness, completeness, architecture-fit) gates it before `implement`. This inverts the removal calculus of 2.3.0's no-research subset: the old `ship` skipped research to save latency and paid for it in grounding; the new one keeps research but trims it to scale.

- **New `quick-plan` skill — the lightweight plan producer `ship` dispatches.** Consumes a `research` artifact and writes one implement-ready `status: ready` plan: at most a single targeted `codebase-pattern-finder` dispatch, then the plan — no slice decomposition, no per-slice verification loop, no risk frontmatter, no interactive checkpoints. Workflow-dispatched only (`disable-model-invocation: true`).

### Changed

- **A gate-stopped run now says so — end-of-run toast and lane recap carry the stop reason.** A stop-on-fail gate routing to `stop` (ship's citation floor and grade gate, any `match`/`gate` no-match) used to surface exactly like a full pass: a `✓ finished` toast and a completed recap, with the failing verdict unread on disk — observed on ship's first run, which silently stopped at a failed completeness gate. rpiv-workflow's recap now refines that shape to outcome `stopped` (see its changelog), ship's two bespoke gates attach a stop-reason note naming the blocking dimensions and severity (via the new `setRouteNote`), and the lane toast becomes `⚠ <name> stopped at <gate>: <reason> — /lanes to view` while the lane console's recap line picks up the `⚠` segment unchanged.

- **`ship`'s plan stage now hands `quick-plan` the verbatim goal, and `quick-plan` must defer narrowed-out asks explicitly.** The stage declares `reads: ["research", "goal"]` (dispatching `--research <path> --goal <path>`) instead of falling to the rolling primary, so the planner anchors on the same verbatim brief the grade panel's completeness dimension judges against — previously it saw only the research doc, whose grounding routinely narrows a broad brief. `quick-plan` gains a matching obligation: an `## Out of Scope` template section plus a "defer explicitly, never silently" rule — every ask the goal names that no phase implements gets a one-line deferral with a reason, the exact form the completeness grade already accepts. Closes the gap where a research-stage narrowing was silently inherited by the plan and then failed ship's stop-on-fail completeness gate (observed on the preset's first run).

- **Artifact paths on lane rows and the recap line drop the canonical
  `.rpiv/artifacts/` root.** Every collector-produced artifact shares it, so the
  16 columns carried no information; the `→` segment now reads
  `<bucket>/<file>.md` (e.g. `→ validation/2026-08-05_….md`). Display-only —
  stored values (`lastArtifact`, `RunRecap.artifacts`) keep the full path, and a
  non-canonical path (url/opaque handles, out-of-tree files) passes through
  untouched.

- **Recap storage collapsed to a single source of truth.** The redundant
  `retireRun` 5th-arg recap path is removed; `setRecap` is now the sole recap
  writer (no behavior change — the ungated `setRecap` was already the
  load-bearing write on both the normal and abort paths). `retireRun` returns to
  a 4-arg shape `(runId, status, error?, lastArtifact?)`.

- **Published skill-count prose corrected: 27 → 29 (and 18 → 20 model-hidden).** `remediate` (2.4.0) already declared a contract the prose never caught up to; `quick-plan` adds one more. Every "27 skills" / "18 of the 27 skills" site across `package.json`, the README, and `docs/` now reads 29 / 20 of the 29, and the published description names four built-in `/wf` workflows. Alongside, `models.json` `presets.ship` is a live key again — the warn-on-miss validator builds its known-workflow set from the live `builtInWorkflows`, so the returning `ship` silently un-warns it (only `presets.arch` and `presets["pr-triage"]` remain stale).

### Fixed

- **The end-of-run recap is now a single summary line, not a per-artifact
  report.** `renderRecap` no longer emits the outcome-glyph + workflow header (a
  duplicate of the lane chip's status) nor one `→ <path>` line per artifact — it
  renders exactly one line: the NEWEST artifact (trail-order last, partial
  artifacts included), a `+N more` count when more landed, and the `⚠ <reason>`
  segment for a non-completed outcome, joined with ` · ` and each omitted when
  empty (a recap with nothing to add beyond the chip renders nothing at all).
  The original multi-line block was both redundant — the lane row above it
  already carries status, short reason, and the primary artifact — and a
  belowEditor ghost-block source: as artifact count grew it pushed the lane block
  past its budget, so the console's total height grew with it. A ≤1-line summary
  keeps `laneBlock.length` constant w.r.t. artifact count by construction, so the
  transcript flex region absorbs it and the total stays exactly `maxRows` (the
  static-lanes + ghost-block invariant). The full artifact list remains available
  in the run's JSONL trail (`summarizeRun` still projects it — the `RunRecap`
  data shape is unchanged; this is presentation-only).

- **A resumed lane is no longer re-retired and re-capped by its aborted
  predecessor's stale terminal `onWorkflowEnd`.** Resume reuses the `runId` and
  reactivates the retained lane back to `"running"` via `recordRun`, which re-arms
  `retireRun`'s first-retire-wins gate — so the aborted predecessor's late terminal
  `onWorkflowEnd` (still on the event loop after a cooperative abort) passed both
  the status check and the re-armed gate and stamped the resumed lane with the
  predecessor's outcome + recap. The lifecycle bridge now registers an
  `onWorkflowStart` listener that captures `ctx.state` (the runner's `run.state`,
  threaded by reference) keyed by `runId`, and `onWorkflowEnd` early-returns when
  the recorded instance exists and differs from the event's `ctx.state` — a resume
  builds a fresh `state` via `reconstructState`, so object identity distinguishes
  the two instances. Fail-open by design (no instance recorded → no block), so
  existing `onWorkflowEnd` paths are unchanged. A microtask-scale residual window
  (between `recordRun` re-arming the gate and the resumed `onWorkflowStart`
  overwriting the captured instance) is accepted and documented in the guard — it
  shrinks the old race window, which spanned the predecessor run's entire remaining
  stage, to microtask scale.

## [2.4.0] - 2026-08-03

### Added

- **A failing `validate` now repairs instead of stopping.** The `build` gate on
  validate's published `verdict` splits: `pass` ⇒ `commit` (unchanged), `fail` ⇒
  the new `validate-fix` arm, which re-enters at `implement-scope-check` so a fix
  flows back through scope-check → reconcile → validate and the gate re-folds on
  a fresh verdict. Previously a `fail` was terminal STOP, leaving the report on
  disk for the user to act on by hand. Deliberately still not a `fallback`: a
  missing or unexpected verdict stays terminal STOP, so un-anticipated data can
  route neither into `commit` nor into the repair arm, and the sole path to
  commit remains an explicit `pass`. The re-entry edge is deterministic and
  non-counted; the budget-consuming edge is the gate's `fail` branch, bounded by
  the runner's per-destination backward-jump budget.

- **New `remediate` skill — the repair arm's body.** The tools/contract twin of
  `implement` (`Bash(*)` + `side-effect`/`code-mutation`, so it owns no outcome
  and emits no artifact) and the body-discipline twin of `amend` (single pass,
  surgical, no subagents, no self-review, no questions). Reads `--plans` and
  `--validation`, re-runs each failed `verify-at-implement` risk ruling's own
  prescribed procedure, applies the minimal localized fix grounded in the
  failing report, and confirms the procedure passes. It is workflow-dispatched
  only (`disable-model-invocation: true`) — the workflow loops it straight back
  to the validate gate, which is the only re-judgement.

### Fixed

- **`reconcile` no longer fails on its own prior successful deletion.** A
  directive whose `replace` is empty and whose `find` is absent is now the
  idempotent-re-run no-op for a deletion (find-absent *is* a deletion's success
  condition), not a stale-directive finding. Without this the `validate-fix`
  loop could not re-run `reconcile` after a repair pass. An absent `find` whose
  non-empty `replace` is also absent is still a finding — reconcile does not
  guess.

- **`remediate` registered where the bundled-skill guards read.** It is now
  listed among the workflow-internal skills in the pipeline pointer, so the
  suggestion surface never offers it directly, and it is counted in the bundled
  skill-contract guard (27 → 28).

## [2.3.1] - 2026-07-31

## [2.3.0] - 2026-07-31

### Removed

- **`ship` and `arch` built-in `/wf` workflows removed.** Both were subsets of
  the now-mature `build` pipeline (`build` is the parallel, panel-gated
  generalization of `arch`; `ship`'s fast blueprint → implement → validate →
  commit spine is `build` with the research/slice/design/plan gates skipped),
  so the curated set is `build` / `vet` / `polish`. The dead `IMPLEMENT_PHASE_FANOUT`
  const (the serial twin only `ship`/`arch` used) is removed as dead code.

### Changed

- **`build` is now the default `/wf` workflow** when no project/user config sets
  one (it is first in the `builtInWorkflows` export array, which `resolve-default.ts`
  reads via `Map.keys().next().value`). `build` is heavier and more interactive
  than the removed `ship` — research → slice → design-checkpoint → gated plan/code
  → validate — so bare `/wf "<task>"` now resolves to the full pipeline.

- **`models.json` `presets.ship` / `presets.arch` entries now warn, not error.** The
  warn-on-miss validator builds its known-workflow set from the live
  `builtInWorkflows`, so once `ship`/`arch` leave the array an existing
  `presets.ship`/`presets.arch` entry self-heals to a soft warn-on-miss (unknown
  workflow) and falls through the cascade rather than failing `/rpiv-models`.

### Added

- **Declared write-sets carry their co-located test twins.** A phase declaring
  `x.ts` in `files:` implicitly covers `x.test.ts` (likewise tsx/js/jsx) at
  both consumers of the declared set: the implement DAG's conflict fold (so a
  phase declaring the production file now serializes against one declaring the
  test — closing a latent race where they counted as disjoint) and the
  `implement-scope-check` floors (so the mechanical twin follow-up a signature
  change forces — mock arity, call-site matchers — is no longer an "undeclared
  write" that STOPs the run; a live run halted one stage short of validate on
  exactly this). Asymmetric: declaring a test file licenses nothing extra, and
  a non-twin write still fails the floor. Elaborations no longer need
  prose scope-addition notes for twin edits.

- **AV lint rule 5: wrap/case-fragile prose greps.** The plan gate's
  Automated-Verification contract floor now flags a grep-family command whose
  positional pattern is a multi-word literal and whose file operands are all
  markdown — prose re-wraps under ordinary editing (splitting the phrase
  across lines, invisible to a line-based grep) and sentence-cases it
  (defeating a case-sensitive match), so such a line can fail at `reconcile`
  (whose fail route is STOP) while the asserted text is present. Both classes
  false-failed a live run. `-e`/`-f` patterns, code-file targets, single
  tokens, and directory operands fail open, matching the floor's posture.

- **Cite-only discharge on the build slice gate.** A `design-readiness` fail
  whose every finding is pure citation bookkeeping — a missing `Draws on`
  seed, or a `path:line` whose line numbers drifted — no longer buys a second
  LLM grade panel. The `grade` skill classifies such a fail `remedy: "cite"`
  with a per-finding `requires` seed (plus `stale`, copied verbatim, on a
  line-drift refresh), and `slice-check` discharges it deterministically: the
  re-cut map must satisfy every finding (seed path present; on a refresh, the
  grader-verified citation present exactly and the stale one gone) with the
  slice structure unchanged (`slices` + `coverage` frontmatter identical to
  the judged round). The fix is witnessed by publication order — the latest
  `slices` round must postdate the verdict — so an in-place map edit counts,
  and occurrences inside fenced spans or `old→new` arrow pairs (a re-slice
  note's quotations; the note format is contracted in the slice skill) do not
  count as live citations. The `citeDischarged` stamp is earned only on a
  green structure floor and honored by `sliceGatePasses` only for the current
  map's basename — the skip stays provably equivalent to "re-grade, then
  pass", and a fix that also restructured (or any finding without a concrete
  `requires`) takes the normal re-grade.

## [2.2.0] - 2026-07-29

### Added

- **Dependency citations resolve in the cite checks.** `file:line` citations
  into installed dependency source (lockfile-pinned) now verify: the checker
  probes `node_modules/<path>` and `node_modules/@<path>` before failing a
  citation, so research/design/plan artifacts citing host-package internals
  (e.g. `node_modules/@earendil-works/pi-coding-agent/dist/...`) no longer
  trip the deterministic floor as unbacked. The suffix-fallback walk still
  never resolves a bare basename into `node_modules`.
- **`BashWatchdog.reset()`.** The per-command bash watchdog gains a `reset()`
  that clears its `fired` flag and pending timers WITHOUT unsubscribing the
  live `tool_execution_start` listener — so a resumed turn's new bash call
  re-arms a fresh per-`toolCallId` timer on the same watchdog handle. Wired onto
  the workflow-execution host port as `resetToolTimeout` beside the existing
  `toolTimeout` verdict channel, enabling strike-based recovery in
  `rpiv-workflow`.
- **`readSessionBranch` host enablement.** The workflow-execution host exposes
  a `readSessionBranch(file)` reader backed by `SessionManager.open(file).getBranch()`,
  narrowed to `BranchEntry[]` and wrapped to fail soft (returns `undefined` on
  any throw). The death-scene artifact writer consumes it to render a failed
  stage's last tool calls + final assistant text + session-file path purely from
  the persisted session JSONL, with no live-session re-query.

## [2.1.0] - 2026-07-23

### Changed
- Bundled skills' `ask_user_question` guidance now matches the runtime's custom-answer behavior: the "Type something." row appears on every question and reserved labels are rejected in every mode.
- Published package description corrected to the current inventory: 27 skills, 15 agents, and five built-in workflows.
- README rewritten to follow the documentation standard shared across all packages.
- npm tarball now includes the versioned `docs/` reference and no longer ships cover or screenshot art.

### Fixed
- The `scope-tracer` agent prompt no longer cites stale subagent-runtime package internals for its sequential-sweep constraint; the constraint itself is unchanged. Run `/rpiv-update-agents` to refresh installed copies.

## [2.0.0] - 2026-07-21

### Added
- Detached parallel execution: every `/wf` stage runs in its own child session with bounded parallel fan-out, while the interactive session stays a launcher and observer.
- Always-on lane dock below the editor showing each run's live progress, streaming thinking, per-unit fan-out sub-rows, token usage, failure reasons, and the run's resume handle.
- Lane browser: step in via `↓` on an empty prompt, `^Q`, or `/lanes` to navigate runs, replay faithful transcripts with full tool rendering, and stop runs.
- Questions from detached runs park in a per-lane queue with a needs-input badge; `⏎` on a flagged lane arms the question inline, and the console backs out to the dock once the queue drains.
- The lane browser auto-closes when the last running lane finishes, and `esc` clears completed lanes from the dock.
- Workflow runs that park a question raise Warp's Blocked badge per run when the optional Warp integration is installed.
- New `build` workflow: a sliced pipeline — verbatim goal capture, research, gated slicing with a deterministic structure floor, dependency-aware per-slice design fan-out, a consolidated `design-review` checkpoint, synthesis, and gated plan/code/validate/commit loops — superseding the seven-stage build.
- New pipeline skills `slice`, `design-slice`, `synthesize`, `grade`, `amend`, and `elaborate` back the sliced flow; `implement` gains a single-phase fan-out mode.
- Risk-scaled gates: a light/standard/strict tier sizes each grade panel to the task, and a dimension's first blocking verdict gets one independent confirmation — ruling on the prior round's findings — before it buys a fix round.
- Deterministic citation floor verifies every file:line citation in slice maps, plans, and code-bearing plans against the tree, backing unique path suffixes and routing fabrications to a surgical amend instead of a blind halt.
- Synthesized plans declare structured risk flags that `grade` and `validate` must rule on; a failed ruling blocks the gate.
- Per-run commit baseline: `validate` judges scope against the run's own changes and `commit` fences pre-existing dirty files out of the run's commit.
- Per-command bash watchdog on child sessions (default 3 minutes, overridable via `RPIV_BASH_TIMEOUT_MS`) aborts wedged commands instead of freezing the run.
- `code-review` skill supports tree-scoped reviews.
- Model configuration honors `XDG_CONFIG_HOME`, reading the legacy `~/.config` location only when the XDG file is absent.
- Pipeline-stage skills are gated to explicit `/skill:<name>` invocation or workflow dispatch, with a compact stage-command index injected at session start for discoverability.

### Changed
- The lane dock replaces the legacy status line and per-stage completion toasts as the live progress surface.

### Removed
- Remove the `pr-triage` `/wf` preset; its skills remain standalone-invokable.
- Remove the one-shot `thoughts/shared` to `.rpiv/artifacts` auto-migration; migrate any remaining content manually.

### Fixed
- Skill invocations carry their arguments as an explicit labeled trailer, so skills no longer misread supplied input as empty.
- Malformed YAML frontmatter in an artifact degrades to empty metadata instead of halting the whole workflow.
- Phase, slice, and review heading counts ignore fenced code blocks, so plans embedding example headings no longer trip the staleness guard.
- Declare typebox as a runtime dependency so tools register under installers that do not materialize peer dependencies.
- Exclude test files from the published tarball.

### Performance
- The build workflow converges without redoing settled work: fixes that clear only the deterministic citation floor skip the re-grade, and re-grades rerun only the failing dimensions, carrying passing verdicts forward.

### Breaking / Upgrade Notes
- `/wf` stages now run in detached child sessions instead of swapping the interactive session; monitor and answer runs through the lane dock.
- Run state trails move to schema v2 — runs recorded by an earlier version refuse to resume, so finish or restart in-flight runs before upgrading.
- The `pr-triage` workflow preset is removed; invoke its skills standalone instead.

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
