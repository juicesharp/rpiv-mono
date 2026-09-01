---
title: "v2.1 to v2.9: teaching the pipeline to finish"
description: "Nine releases in six weeks, one direction. v2.0 built a parallel, gated pipeline. Everything since has been about making a long run reach its end: halt less, recover cheaper, judge the work against your words, spend tokens only where they change a verdict, and never let a stop look like success. Version by version, with the reason behind each change."
pubDate: 2026-09-01T12:00:00Z
author: juicesharp
tags: ["release", "rpiv-pi", "rpiv-workflow", "rpiv-ask-user-question", "rpiv-todo", "rpiv-advisor", "rpiv-btw", "rpiv-web-tools"]
draft: false
---

[v2.0](/blog/release-notes-v2-0-0) built the machine. Every `/wf` stage runs
in its own child session, fan-outs run in parallel, a lane dock shows the
run live, and `build` became a sliced, panel-gated pipeline with
deterministic floors under the LLM judges. That was the shape.

The nine releases since then share a single job: **make a long autonomous
run reach its end.** A pipeline that can run is not the same as a pipeline
that finishes. Between v2.0 and v2.9 we watched real runs, kept the trail of
every one, and fixed what stopped them. If you read the changelogs, you will
notice that almost every entry names the run it came from. That is the
method: measure the run, find the waste or the death, close it, keep the
receipt.

> **Upgrade notes, whole arc.**
> 1. **The `/wf` set is `build`, `vet`, `polish`, `ship`.** `ship` and `arch`
>    left in v2.3 and `ship` came back in v2.5 as a rebuilt lightweight
>    preset. Bare `/wf "<task>"` runs `build` unless your config names a
>    `default`.
> 2. **`models.json` presets.** `presets.ship` is a live key again since v2.5.
>    `presets.arch` and `presets["pr-triage"]` warn once and are ignored.
>    Since v2.9, `presets.<workflow>.stages.<stage>` actually applies during
>    a run (it was documented but dead before).
> 3. **Embedders of `rpiv-workflow`:** `resolveModel` now receives
>    `{ workflow, stage, skill }` instead of `{ stage, skill }` (v2.9).
>    `test-utils` replaced the `newSession` mock with `spawnChild` (v2.0).
> 4. **`RPIV_BASH_TIMEOUT_STRIKES`** (v2.2) controls how many times a hung
>    command may be retried in the same session before the stage halts.
>    Default 2.

## The plan behind the releases

Six lines run through every version below. When you read an item, it is
pushing on one of these.

1. **Halt less, recover cheaper.** A deterministic check should produce
   evidence, and a judge should rule on it. A halt is the last resort, and
   when it happens, recovery must cost one command, not a re-run.
2. **Judge the work against your words.** The standard of completion comes
   from the brief you typed, captured verbatim, before research or planning
   has a chance to narrow it.
3. **Spend tokens where they change a verdict.** Grade panels, confirm arms,
   subagent dispatches and citation re-checks all cost real money. Each one
   has to earn its place with measured catches.
4. **Never let a stop look like success.** A run that stopped at a gate must
   say so, say where, and say what to do next.
5. **Fit the pipeline to the task.** One heavy pipeline is not the answer to
   a small task. But skipping research is the wrong economy. `ship` came
   back rebuilt around that lesson.
6. **Smooth the human gate.** The question dialog is where the driver enters
   the loop. Friction there is friction in the whole loop.

Now, version by version.

## v2.1.0 (Jul 23): settling the 2.0 surface

A cleanup release. The big machinery had just landed and its edges needed
sanding.

- **Bundled skills describe `ask_user_question` the way it actually behaves.**
  The runtime had grown a "Type something." free-text row on every question,
  but the skill prompts still described the old rules. A model told one thing
  and shown another wastes turns. *(line 6)*
- **`scope-tracer` stops citing stale package internals.** The agent prompt
  referenced subagent-runtime files that no longer existed. The constraint it
  enforced was fine; the citation was wrong. Run `/rpiv-update-agents` to
  refresh installed copies.
- **rpiv-advisor: the executor must repeat the advisor's key guidance in its
  next visible reply.** In Cursor bridge sessions the advisor's answer was a
  collapsed tool card nobody opened. If the guidance is worth asking for, it
  is worth showing. *(line 6)*
- **rpiv-advisor: completions route through Pi's auth-aware runtime.** Models
  behind an OAuth proxy (GitHub Copilot, for example) have a credential-derived
  base URL. The static catalog URL was wrong for them.
- **rpiv-ask-user-question: notes on every tab.** Press `n` on any question,
  not only on options that carried a preview. Also: an in-progress note is no
  longer lost when the editor reopens; collapse toggles ignore key-repeat and
  key-release events (a single tap in cmux or Ghostty used to reopen the
  dialog immediately); and a missing collapse-key value after a mid-session
  package update no longer crashes the host. The dialog also emits
  `rpiv:ask-user:blocked` so status surfaces can show *blocked* instead of
  *working*. *(line 6)*
- **rpiv-todo: the overlay follows theme changes live** and its colors now
  mean something: in-progress subjects highlighted, metadata dimmed, done
  tasks muted.

## v2.2.0 (Jul 29): a run that survives its own accidents

Here the first line of the plan becomes concrete. A detached run has nobody
watching it turn by turn, so it has to survive the small accidents on its
own.

- **rpiv-workflow: a hung bash command gets strikes, not a halt.** v2.0 added
  a three-minute watchdog per command. When it fired, the stage died. Now the
  same child session is re-prompted with a diagnostic (the killed command,
  the ceiling, strikes left, and "this looks hung, do not rerun it verbatim")
  and gets to try again. Two strikes by default (`RPIV_BASH_TIMEOUT_STRIKES`,
  1 to 5). Only when the budget is spent does the stage halt, exactly as
  before. Strike history lands on the stage row so you can see it later.
  *(line 1)*
- **rpiv-workflow: a re-dispatched stage is told what killed it last time.**
  A bounded failure memo rides as a prompt suffix. Without it, a stage that
  failed and was re-run started with zero memory of the failure and often
  repeated it. *(line 1)*
- **rpiv-workflow: a death-scene artifact for every failed stage.** When a
  stage or unit fails, a Markdown file lands in
  `.rpiv/artifacts/failures/` with the last tool calls, the final assistant
  text, and the path of the session file. Post-mortems used to mean digging
  through JSONL by hand. *(line 4)*
- **rpiv-workflow: no blind retries against an unchanged tree.** A stage whose
  output fails schema validation was retried even when the agent had edited
  nothing. Now a worktree digest is taken around the attempt; if nothing
  changed, the retry is skipped and the failure is recorded. Retrying the
  same input to get a different output is hope, not engineering. The digest
  itself is hardened: each git call is bounded to ten seconds and a wedged
  git degrades the check to "proceed" instead of hanging the runner.
  *(line 1)*
- **rpiv-pi: citations into dependencies resolve.** A `file:line` into
  `node_modules/@scope/pkg/...` used to fail the citation floor as unbacked.
  Research artifacts legitimately cite host-package internals. *(line 1)*
- **rpiv-advisor: an empty response is retried once.** A normal stop that
  carried no text is usually a provider hiccup, not an answer.
- **rpiv-btw: `/btw` side calls fit the context window.** When the full
  request would overflow, the `/btw` history is capped and the conversation
  branch is trimmed to fit. A fitting request is sent byte-identical to
  before. Long sessions had started failing `/btw` outright.
- **rpiv-ask-user-question: real multiline editing.** `Shift+Enter` inserts a
  newline, pasted line breaks survive, `Ctrl+G` opens your external editor,
  `Ctrl+U` clears the draft. Custom-answer drafts also survive browsing other
  options instead of vanishing. *(line 6)*
- **rpiv-todo: the overlay loads lazily** (session start got cheaper), a
  transient overlay-load failure no longer surfaces as an extension error,
  and a model that forgets `status` on an `update` after compaction gets an
  error message that names the mutable fields and a prompt recipe with the
  literal call shape, instead of looping on the same mistake (#137).

## v2.3.0 and v2.3.1 (Jul 31): fewer presets, sharper floors

- **`ship` and `arch` removed; `build` is the default `/wf`.** Both were
  subsets of the now-mature `build`. Carrying three graphs for one pipeline
  meant three places to fix every bug. `presets.ship`/`presets.arch` in
  `models.json` warn instead of failing `/rpiv-models`. *(line 5; and read
  v2.5 for the second half of this story)*
- **Declared write-sets include their test twins.** A phase that declares
  `x.ts` implicitly covers `x.test.ts`. Rationale: a signature change forces
  a mechanical edit in the test file, and the scope floor was halting runs
  over exactly that as an "undeclared write". A live run stopped one stage
  short of validate on it. The same twin rule closes a latent race in the
  implement DAG where a production file and its test counted as disjoint
  and could be edited in parallel. *(line 1)*
- **AV lint rule 5: prose greps are flagged at plan time.** A plan that
  promises `grep "some multi word phrase" docs/x.md` will fail when the
  prose re-wraps or gets sentence-cased, even though the text is present.
  Two live runs false-failed at `reconcile` this way. The floor now flags
  the shape; `-e`/`-f` patterns, code targets, and single tokens fail open.
  *(line 1)*
- **Cite-only discharge on the slice gate.** When a `design-readiness` fail
  consists only of citation bookkeeping (a missing seed, a drifted line
  number), the fix no longer buys a second full LLM grade panel. The grader
  marks it `remedy: "cite"`, and a deterministic check confirms the re-cut
  map satisfies every finding with the slice structure unchanged. The skip is
  provably equivalent to "re-grade, then pass". *(line 3)*
- **v2.3.1: readability pass in rpiv-workflow.** The longest methods and
  condition-heaviest guards were decomposed into named predicates. Behavior
  preserved, full suite unchanged, plus first-ever test coverage for the four
  abort-disposition arms. Housekeeping, but it made the next six releases of
  runner changes possible.

## v2.4.0 (Aug 3): a failing validate repairs instead of stopping

- **`validate` fail routes to a new `validate-fix` arm.** Before, `fail` was a
  terminal stop: the report sat on disk and you fixed it by hand. Now the fix
  re-enters at `implement-scope-check`, flows through reconcile and validate
  again, and the gate re-folds on a fresh verdict. Deliberately, a missing or
  malformed verdict still stops. The only path to `commit` is an explicit
  `pass`. *(line 1)*
- **New `remediate` skill.** The body of the repair arm. Single pass,
  surgical, no subagents, no self-review. It re-runs each failed risk
  ruling's own procedure, applies the minimal fix, and confirms the procedure
  passes. Workflow-dispatched only.
- **`reconcile` tolerates its own earlier deletion.** A directive with an
  empty `replace` and an absent `find` is a deletion that already happened,
  not a stale directive. Without this, the new fix loop could not re-run
  reconcile after a repair pass.
- **rpiv-ask-user-question: preview questionnaires rebalance after a terminal
  resize**, and the notes hint no longer clips when a locale string is wider
  than the preview box (French hit this exactly). *(line 6)*
- **rpiv-workflow docs:** the backward-jump budget is `3` per destination
  stage, as the code has said since v2.2. The docs said `2`.

## v2.5.0 to v2.5.2 (Aug 13 to 14): `ship` returns, and a stop says so

- **`ship` is back, rebuilt as a lightweight preset.** One forward pass:
  `goal → research → plan → plan-cite-check → grade → implement →
  implement-scope-check → reconcile → validate → commit`, stop on fail at
  every gate. No fix loops, no confirm panels, no code-elaboration lane. This
  inverts the v2.3 removal on purpose. The old `ship` skipped research to
  save time and paid for it in bad grounding. The new one keeps research but
  trims it: a custom prompt stage with at most two `codebase-analyzer`
  dispatches. Research is where the pipeline earns its correctness; it is
  the wrong thing to cut. *(line 5)*
- **New `quick-plan` skill.** Consumes the research doc and writes one
  implement-ready plan. At most one pattern-finder dispatch, no slicing, no
  per-slice loop, no checkpoints.
- **`ship`'s plan stage receives the verbatim goal, and `quick-plan` must
  defer explicitly.** On the preset's very first run, research narrowed the
  brief, the plan inherited the narrowing, and the completeness gate failed
  on asks nobody had consciously dropped. Now the planner sees the same brief
  the grader judges against, and every ask it does not implement gets a
  one-line reason under `## Out of Scope`. Silence never defers. *(line 2)*
- **A gate-stopped run no longer looks finished.** That same first `ship` run
  stopped at a failed completeness gate and showed `✓ finished`. The failing
  verdict was on disk, unread. Now rpiv-workflow's new `summarizeRun` refines
  a routed stop to outcome `stopped`, gates attach a stop-reason note via
  `setRouteNote`, and the toast reads
  `⚠ ship stopped at grade: <reason> — /lanes to view`. *(line 4)*
- **Each lane shows a one-line end-of-run recap:** the newest artifact, a
  `+N more` count, and the `⚠ <reason>` segment when the run did not
  complete. It started as a multi-line block and was cut to one line in the
  same release: the block duplicated the lane chip and grew the console with
  every artifact, breaking the fixed-height layout. *(line 4)*
- **Artifact paths on lane rows drop `.rpiv/artifacts/`.** Every artifact
  shares that prefix, so its sixteen columns carried no information.
- **A resumed lane is no longer stamped by its aborted predecessor.** A late
  `onWorkflowEnd` from the aborted run could arrive after the resume and
  overwrite the resumed lane's status. The bridge now distinguishes the two
  instances by identity.
- **rpiv-todo: terminal control characters are stripped from task text**
  (#151, #152). Task text is model-controlled and was rendered raw. ANSI
  escapes, newlines and bidi overrides in it could corrupt the terminal.
- **v2.5.1, rpiv-ask-user-question: long pasted text arrives in full** (#160).
  The agent used to receive the editor's compact `[paste #N +L lines]` marker
  instead of the content. *(line 6)*
- **v2.5.2, rpiv-ask-user-question: a remapped submit key works everywhere**
  (#156). A Slack-style keymap (Enter for newline, `Ctrl+Enter` to submit)
  left the dialog with no confirm key, and pressing submit silently wiped the
  draft. *(line 6)*

## v2.6.0 to v2.6.4 (Aug 15 to 20): the citation floor learns humility

This is the release group where line 1 of the plan gets its clearest
statement: **a deterministic floor produces evidence; the LLM judge rules.**
The citation floor had been the strictest gate in the pipeline, and the run
history said it was strict about the wrong things.

- **v2.6.0: Pi's `max` thinking level is supported** in `models.json`,
  `/rpiv-models`, `/advisor`, and workflow model selection, offered only when
  the model advertises it. The `/advisor` effort picker now derives its
  levels from the model's own capability report, so levels a model disables
  are hidden. `Esc` in the picker keeps the model selection (it used to
  abort the whole flow), and session restore overwrites the in-memory effort
  instead of merging, closing a case where a stale effort was silently sent
  on every call.
- **v2.6.0: an ambiguous citation resolves against the plan's declared
  write-set.** `messages.ts:18` matching several tree files used to fail the
  floor outright, which was terminal for the loop-less `ship`. A full run
  halted over a path-prefix omission the plan had already resolved in its
  own `files:`. *(line 1)*
- **v2.6.0, rpiv-ask-user-question: a terminal bell when the dialog waits**
  (#140). One BEL, TTY only. Your terminal decides whether that is a sound,
  a flash, or nothing. *(line 6)*
- **v2.6.1: OAuth-backed models work in `/advisor` and `/btw`** (#166). A
  missing literal API key is only an error on hosts without Pi's auth-aware
  runtime. `rpiv-ask-user-question` gains `guidance.description` to replace
  the whole tool description from config. `rpiv-web-tools` config now degrades
  per field on a schema violation instead of wiping the entire config: one
  wrong-typed leaf used to erase provider, keys and base URLs for the session
  and on the next save.
- **v2.6.2, rpiv-todo: the overlay follows Pi's tool-output expansion mode**
  (#174), and the `in_progress` guideline is scoped to "a task from the todo
  list" (#154). The old wording ("any task") overrode Pi's "skip it for single
  trivial tasks" rule and pushed models into one-item todo lists for every
  request.
- **v2.6.3: citation findings are severity-tiered.** Ambiguity where every
  candidate is a real file, a read failure after resolution, and a line
  range past end-of-file become *advisory*. They are still recorded and still
  count as `pass: false` on the structure verdict, but they rate `low` and
  the gates' severity floor rides through them. The run-history audit found
  that every terminal `ship` cite-stop on record was one of these shapes,
  and none was a fabrication. `ship`'s grade panel now receives the advisory
  findings via a new `--cite-check` flag and rules on each one against the
  live code, so nothing rots on the trail. *(lines 1 and 3)*
- **v2.6.3: standalone iterative `design` crosses a hard session boundary
  after every approved slice.** Verified code and Success Criteria are written
  to the artifact, re-read to confirm they match, and the run stops with a
  `/skill:design --resume <artifact>` command. Verifier-heavy slice work is
  bounded to one slice per context, and resume reads the artifact rather than
  trusting a compaction summary.
- **v2.6.3: overflow recovery resumes the task instead of answering hidden
  messages** (#162). After compaction, three separate hidden control messages
  (root guidance, pipeline pointer, Git context) were queued as steering
  items, so the model acknowledged each one and lost the task. They are now
  one merged block delivered on the next real turn.
- **v2.6.4: the last blocking citation category is demoted. Every
  citation-resolution finding is advisory.** The numbers: across three
  months, 71 distinct flagged paths yielded zero fabrications. The whole
  no-match population was resolver gaps and fixture prose. Blocking on it
  cost about eight hours of fix rounds, two dead `ship` runs, and one
  four-round loop of identical findings. Only the `files:` coverage floor
  still blocks, because an undeclared write corrupts implement's dependency
  derivation. A genuinely wrong path is still caught, by the correctness
  grader reading the findings. *(line 1)*
- **v2.6.4: the resolver closes its three worst false-positive gaps** (the
  `.rpiv/guidance` tree is citable again; a no-match is rescued by a unique
  suffix match in the plan's own `files:`; existence probes no longer race a
  concurrent delete into a halt), and **the coverage floor stops flagging
  non-writes**: a reference bullet outside a Changes section is not a
  declared write, and a dotted identifier like `deps.finalize` is not a file.
  That one had cost a live run a blocking finding and a wasted fix round.

## v2.7.0 and v2.7.1 (Aug 21 to 24): the scope floor stops killing green runs

Same principle, next floor. The scope floor checks that a run only wrote
the files its plan declared. It is a good check with a fatal habit.

- **New `scope-quarantine` arm in `build` and `vet`.** When every flagged path
  is an untracked file the run itself created (provably absent from the
  run-start baseline), the floor routes to a deterministic stage that
  *moves* each file under `.rpiv/tmp/scope-quarantine/` (never deletes),
  records a manifest, and re-enters the floor. `validate` reads the manifest
  and rules: scratch is benign; a moved file the deliverable needs is a
  blocking plan deviation, and the manifest says where it went. Motivation:
  run `17e7`, a functionally green five-hour run, killed by two scratch
  scripts in `.tmp/`. Twice, because the resume re-judged the same tree.
  *(line 1)*
- **Tracked excess no longer halts either.** The floor's verdict is tiered
  (`pass` / `untracked-only` / `excess`), tracked excess continues to
  validate with findings at severity `high`, and `validate` receives the
  verdict via `--scope` and rules on each finding. A lockfile a declared
  phase's own commands regenerated is a note; an unexplained cross-phase
  write forces `fail` into the fix loop. A floor cannot tell those two apart.
  A judge with the diff in front of it can. `ship` keeps stop-on-fail by
  contract. *(line 1)*
- **The artifact collector recovers a mangled announcement.** Run `ec5e`: the
  agent wrote a verified 38 KB elaboration to the right path and announced it
  as `.elaborations/<file>.md` in prose. The stage fataled with the artifact
  on disk. The collector now falls back to a bare basename, accepted only
  when exactly one such file exists under `.rpiv/artifacts/`. In the same
  run, a sibling reference written as `...__phase-4.md` (a prose ellipsis)
  matched the path regex and was collected as a real path; `..` is now
  rejected inside a segment. *(line 1)*
- **Skills that shell out learn the scratch contract, and plans stop
  promising gates they cannot pass.** Scratch lives under `.rpiv/tmp/` or
  outside the repo. Repo-wide style gates default to the delta-scoped form.
  Run `17e7` had a plan promising `npm run lint` exits 0 against 95
  pre-existing errors in files it never touched, an unpassable criterion
  that burned all three validate rounds. `validate` closes the loop from the
  judging side: a whole-plan failure attributable entirely to files outside
  the delta is pre-existing debt, reported, non-blocking. *(line 1)*
- **`validate` drops its two subagent dispatches.** An audit of 64 validate
  runs: 127 dispatches, about 4.8M tokens, 80% pure rubber stamps, two
  verdict-affecting catches. Both catches were stale references left in
  comments and docs after a rename. That one earning class is now an inline
  grep step. *(line 3)*
- **rpiv-ask-user-question: a global note on the Submit tab** (#182). Press
  `n` there to attach a note to the whole questionnaire. A global note alone
  counts as an answer, so "none of the above, here is what I actually want"
  is a first-class reply. Notes are terminal-only; RPC hosts' native dialogs
  carry no note field. *(line 6)*
- **v2.7.1: `build`'s validate loop verifies its own progress.** Run `64eb`:
  validate failed on gates recorded only in report prose, the remediate arm
  (restricted to failed risk rulings) found nothing it was allowed to fix,
  and the unchanged tree re-validated to the identical verdict four times,
  27 minutes of full-suite runs, until the backward-jump guard killed it at
  the wrong stage. Three seams close it. The gate classifies a fail before
  routing: only a fail with a remediable handle reaches `validate-fix`, a
  prose-only fail stops with a note naming why. `validate` emits automated
  command failures as structured `blockers:` that remediate accepts. And
  `validate-fix` publishes whether the tree changed; an unchanged tree stops
  the loop, because re-validating it is provably futile. The rule that
  falls out: a gate may only loop into an arm whose authority covers the
  failure classes it emits. *(line 1)*

## v2.8.0 (Aug 29): judge against the goal, recover with one command

The biggest release of the arc. Lines 2, 3 and 4 all get their main
delivery here.

- **A goal-derived acceptance inventory joins `ship` and `build`.** This
  closes the pipeline's one structural gap against its own goal channel.
  `validate`'s executable checks were all plan-authored (the plan's own
  `Automated Verification` commands re-run as written), so a plan that
  narrowed the brief validated green. Both observed completeness catches
  before this were expensive late grading saves, not measurements. A new
  `acceptance` skill runs *before* planning, between research and slice or
  plan. It enumerates observable outcomes (`a1…`) from the verbatim goal
  alone, with research grounding only the evidence procedure, never the
  membership. Each item gets a read-only `command` + `expect`, or a `manual`
  procedure. Then it threads: `quick-plan` records a disposition per item
  (`implemented` or `deferred` with a reason; silence never defers), every
  completeness grader walks the items by id instead of re-deriving the ask
  list from prose, and `validate` *executes* each non-deferred command
  against the finished tree. A failing item is a structured blocker the fix
  arm can act on. *(line 2)*
- **Garbage briefs are refused before anything runs.** Fewer than twelve
  non-whitespace characters ("do something") can only be placeholder text,
  and it used to ground a full multi-stage run against nothing. `vet` is
  exempt, since its brief is a scope token like `staged`. Worth noting: this
  change was itself implemented by a `ship` run, and that run's acceptance
  inventory could not have caught the `vet` regression, because the
  implementing brief never mentioned `vet`. A goal-derived standard
  faithfully inherits its brief's blind spots. The carve-out came from a
  human reviewing the diff. *(line 2)*
- **Re-grade economics: the fix-loop grading stack sheds three measured
  wastes.** Grading was 20 to 25% of tokens and about a quarter of clean-run
  wall time; every fix loop re-graded all five dimensions; confirm arms went
  onward-to-fix roughly 13:1 against overturning; the correctness unit was 40
  to 60% of panel cost, mostly re-resolving citations the deterministic floor
  had already checked. Three coordinated changes. (1) The surgical-fix
  guard can finally fire: findings now cite the section they are in, so an
  amend touching `## Risk Flags` is no longer structurally guaranteed
  "broad", and every guard decision is persisted as a `.decision.json` so it
  can be diagnosed afterwards. That instrumentation's first live firing, on
  a third-party run, immediately exposed two more normalization gaps, and
  its second exposed that `## ` lines inside fenced code blocks were being
  indexed as sections. Both fixed. (2) The confirm arm is severity-gated: a
  fresh blocker gets a second opinion only when that opinion has real
  expected value, meaning a HIGH-severity blocker, a risk-ruling blocker, or
  a flap. A first-time MEDIUM goes straight to the sub-minute surgical fix.
  (3) Citation resolution is a settled fact for the correctness grader:
  `--cite-check` now reaches every correctness unit, including on a clean
  verdict, so the grader samples citations only for the semantic claim,
  never to re-check existence. *(line 3)*
- **All-failed fan-out generations halt at the fan-out's own close.** Observed
  shape: four dead `slice-design` units still fell through to
  `design-review`, which dispatched twice over an empty `designs` channel,
  burning checkpoint sessions on nothing. rpiv-workflow gains
  `fanout({ haltWhenAllFailed: true })`, and rpiv-pi flags exactly seven
  stages (slice-design and the five grade panels plus `ship`'s), pinned by an
  inventory test so nobody flags implement lanes by accident. *(line 3)*
- **`ship`'s validate gate gets one bounded remediation hop.** Run `7299`:
  52 minutes through a fully implemented, fully verified tree, then validate
  failed solely over a docs gap and the stop-on-fail edge stranded 50 minutes
  of correct work uncommitted. Ship now uses build's classifying gate capped
  at one `validate-fix` round. The cap is deterministic (the remediation
  channel's length is the rounds spent), so ship's identity survives as "at
  most one sanctioned hop", not a loop. *(lines 1 and 5)*
- **`ship`'s research right-sizes to the brief.** A brief that already names
  the root cause and the files paid the same two mapping dispatches as a
  symptom-only brief. Now the prompt classifies first: a pre-chewed brief
  gets at most one verify-only dispatch (or zero, when the anchors are plain
  paths the stage can read itself); a symptom-only brief keeps the two-dispatch
  mapping. The grounding doc is bounded under 150 lines, leaving its two full
  readers headroom. *(line 5)*
- **Research narrates its progress.** Runs were dying inside the research
  stage's silent agent-batch window with no transcript trace of where they
  stood, and the lane tail reads as a stall. The research skill and ship's
  grounding prompt now emit one-line markers: `[Questions]:`,
  `[Dispatched]:`, `[Returned]:`, `[Synthesizing]:`. Transcript only, never
  artifact content, never naming an artifact path before it is written.
  *(line 4)*
- **rpiv-workflow: resuming a gate-halted run re-measures instead of
  replaying the stale verdict.** The 2026-08-13 to 08-20 corpus showed that
  a red gate's biggest cost was recovery: after a halt, people re-ran the
  whole workflow from scratch, including a full research and plan for a
  one-line citation fix. Now a routed stop closes the fan-out generation, so
  resuming a halted grade panel dispatches a fresh judgment; a halt on a
  remediation arm resumes at the gate's onward target rather than re-running
  the arm against a hand-fixed tree (which would no-op and re-trip the same
  gate forever); and the halt toast says the remedy out loud: *fix and
  resume with `/wf @<runId>`*. The old wording, "fix and re-run", read as
  "start over", which is exactly what people did. *(lines 1 and 4)*
- **rpiv-workflow: a side-effect stage with a named outcome publishes onto
  its channel.** A review found that `validate-fix`'s `remediation` digest
  existed on the stage output but no code path ever wrote it to the channel
  the gates read. The fix-round cap and the unchanged-tree stop from v2.7.1
  had been inert since they shipped, bounded only by the backward-jump guard.
  Now covered at unit, e2e loop and e2e halt-plus-resume levels.
- **Lane navigation survives pi 0.84.4.** The host update re-wraps every
  extension's `ctx.ui` by spread, which dropped the lane relay's brand (it
  lived only in a Proxy `get` trap). Every ↓/⏎/`/lanes` step-in then parked
  the console in a queue instead of mounting it, and the needs-input badges
  inflated. Observed minutes after the update, fixed the same morning. The
  brand is now also an own enumerable key, pinned by a suite modeling pi's
  wrapper byte-for-byte.

## v2.9.0 (Sep 1): the measured cost of a build run, trimmed

With the runs finishing reliably, this release reads two full `build`
trails from 2026-08-31 and cuts what they show.

- **`presets.<workflow>.stages` in `models.json` is live on the run path.**
  It had been documented as the top rung of the cascade since the axis
  shipped, and the resolver implemented it, but the execution seam handed
  `resolveModel` only `{ stage, skill }`, so the rung could never match
  during a run. Per-preset entries silently fell through to the flat rungs.
  rpiv-workflow widens the seam to `{ workflow, stage, skill }` (required,
  not optional, so the same silent omission cannot come back) and rpiv-pi
  threads the workflow name. Why it matters: a build run dispatches 10 to 21
  grade sessions, and in run `f00e` the grading stages consumed more output
  tokens than implement itself. This rung is the knob that right-sizes
  them, and now it turns. *(line 3)*
- **Elaborate's probe verifies at the narrowest scope, and sibling-phase
  files are never read from disk.** The code fan-out is the pipeline's
  biggest compute block (run `57d0`: eight phases, 15 to 20 minutes each,
  about 37 minutes wall). Most of it was every unit running the project's
  whole-tree check repeatedly while up to `maxConcurrency` siblings mutated the same
  working tree, then filtering out the noise the siblings caused. The probe
  now runs the narrowest recorded check covering its write-scope
  (`tsc -p <package>`, `cargo check -p <crate>`), whole-tree only when no
  scoped form is recorded. And sibling-phase files are explicitly never
  read: phase 7 in that run hit ENOENT on three not-yet-created sibling
  files, waited eleven minutes, and retried the identical reads, while the
  interfaces it needed were in the Synthesis Notes all along. Trade
  accepted: a cross-package break the whole-tree form would have caught at
  probe time now surfaces at implement or validate, the same routing the
  pipeline already relies on. *(line 3)*
- **Citation prose slims to the happy path.** Session data from the two runs
  showed the deterministic cite floors ran in milliseconds with zero
  findings, zero fix rounds were citation-driven, and the grade sessions'
  only citation work was one small verdict read. The expensive labor had
  already been retired by `--cite-check`. What remained was prompt weight
  and loop risk. `research` drops its end-of-stage "confirm every
  `file:line` resolves" duty; `grade`, loaded 10 to 21 times per run,
  compresses its citation contract to a few lines. Same rules, same gates,
  fewer tokens per judge session. No machinery changed. *(line 3)*
- **Reconcile write authority is plan-derived; the JS/TS-only test-path rule
  is retired.** Directive eligibility was a filename convention
  (`*.test.{ts,tsx,js,jsx}`), which made the whole reconcile channel inert
  in any other language and left golden masters undeliverable. Eligibility
  now derives from the plan's declared write-set, the same authority the
  scope floor enforces, so reconcile can never write a path the floor would
  flag, in any language. The gate's parser also becomes a pre-flight lint
  (`reconcile-lint.mjs`) the implement skill runs right after recording a
  directive. Run `57d0` lost 42 minutes to exactly the class of error this
  catches locally: one `/skill:amend` repair session plus a gate re-entry
  that now never happens. *(lines 1 and 3)*
- **The default lane cap rises from 4 to 6.** The widest built-in fan-out is
  the five-dimension grade panel, and under the shipped default of 4 it
  split 4+1 on every panel occurrence, the tail dimension landing about a
  minute and a half behind its batch, with elaborate and implement phases
  queuing behind the same cap. Neither run recorded a single rate-limit
  event at 4 lanes. Since `models.json` is absent on every fresh install, the
  shipped constant *is* the fleet default. Six clears the panel in one batch
  with one lane of headroom. A configured `maxConcurrency` still wins.
  *(line 3)*

## Housekeeping across the arc

Every package README was rewritten to one shared documentation standard, and
the versioned `docs/` reference now ships in the npm tarball while cover and
screenshot art do not (v2.1). Every package declares a `pi.image` cover for
its pi.dev card (v2.6.1). Configuration is read from `XDG_CONFIG_HOME` with a
fallback to `~/.config` (v2.0, via `rpiv-config`'s `resolveConfigDir`).
`rpiv-web-tools` gains `WEB_SEARCH_PROVIDER` to pin the search backend from
the environment (v2.0). Test files are excluded from every published tarball,
and `rpiv-warp` no longer loads inside detached child sessions; it observes
from the launching session only.

## Where this leaves the pipeline

Every floor in the pipeline now behaves the same way: it produces evidence,
and a judge with the goal in hand rules on it. Every halt names its remedy,
and the remedy is one command. The standard of completion is derived from
your brief before a plan can narrow it. And the tokens a run spends are
tracked against the verdicts they change, with the two biggest blocks (the
grade panels and the code fan-out) both measured and trimmed in the last two
releases.

The next cycle starts from those trails. If you want to see what a run
looks like today, `/wf build "<brief>"` and step into the lane with `↓`.
