---
name: elaborate
description: Write implement-ready code into ONE phase of a synthesized plan — read the whole plan plus the real code the phase touches, then emit a code-bearing replacement for that single `## Phase N:` section to .rpiv/artifacts/elaborations/. Single-pass, no subagents, no self-review, no questions. Dispatched once per phase by an elaborate fanout after synthesize; the per-phase elaborations are folded back into the plan by the deterministic `stitch-elaborations` script, and the grade panel judges the stitched plan. Use as a fanout unit, not standalone.
argument-hint: "<plan-path> Phase N: <title>"
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: elaboration
    data:
      type: object
      properties:
        status:
          enum: [in-progress, in-review, ready]
  consumes:
    meta:
      artifactKind: [plan]
---

# Elaborate

You write **implement-ready code into one phase** of a synthesized plan, in isolation, and emit it as a per-phase elaboration doc. One pass. You do **not** redesign the phase, write any other phase's code, or self-review — `synthesize` already reconciled the cross-phase seams and the workflow's grade panel judges the spliced result. You turn one phase's contract-level "what to change" into the actual code to apply.

## Input

`$ARGUMENTS` — `<plan-path> Phase N: <title>` (exactly the unit shape a phase fanout dispatches):

- The first token is the path to a plan under `.rpiv/artifacts/plans/`.
- The remainder (`Phase N: <title>`) names the **single** phase to elaborate. Parse `N` from `Phase (\d+)`.

Elaborate **only** that phase. The other phases are owned by sibling lanes — never write their code.

If the plan path is missing or `Phase N` can't be parsed, print an error and stop — it's a dispatch error, not a failing phase.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim. `<iso>` is the first tab-separated field (use as `date`); ignore the second.

## Steps

1. **Read the plan fully** (no limit/offset). Note its `## Synthesis Notes` (the reconciled seams — conflict resolutions, shared locals, integration order) and locate the `## Phase N:` section you own: its `### Changes` (the files/symbols to touch) and its `### Success Criteria`. Skim the **other** phases' sections too — to know what they own and what interfaces they expose — but never implement them.
2. **Ground in the live code.** For every file the phase's `### Changes` names, Read/Grep the cited `path:line` in the **current** tree. The plan may have been written against a slightly older state — anchor the code you write to what is actually there now (signatures, imports, surrounding style).
3. **Write the code for this phase only.** For each file in the phase's Changes, emit a concrete, paste-ready code block: the full function/section to add, or the exact edit (enough that `implement` applies it without guessing). Match the surrounding code's conventions. Where the phase depends on a sibling phase's symbol, reference it by the shape the plan/Synthesis Notes already fixed — do not redefine it.
4. **Carry the success criteria.** Preserve the phase's `### Success Criteria` (Automated + Manual), tightening a check only if your code makes it more concrete. Do not drop or weaken a criterion.
5. **Resolve ambiguity yourself.** Decide from the plan, the Synthesis Notes, and the real code. This skill is **non-interactive** — if a genuine blocker can't be settled from those inputs, make the most defensible call, record it under `## Notes / Deferred`, and let the grade panel catch a bad call. Do **not** ask the user (N lanes run concurrently).
6. **Self-check (probe → revert → guard).** Before emitting, verify the drafted code blocks actually apply and pass the project's checks at their REAL placement — declaration-order / initialization-order and integration defects only surface when a block lands at its true anchor, not an idealized layout. Define **write-scope** = the set of repo-root-relative paths the phase's `### Changes` names (the files below this step's emitted `#### \`...\`` headings); the whole self-check applies and reverts ONLY those paths — sibling phase lanes run concurrently in the same working tree, so touching a file another phase owns corrupts its in-flight edit. The cycle is exactly:
   - **Snapshot.** Capture `git status --porcelain` BEFORE the probe (the byte-identical revert target).
   - **Probe.** Apply each drafted code block via `Edit` at its REAL anchor position in the current file (not a speculative layout). New files named by the phase are written for the probe.
   - **Verify, in order, attributing only write-scope errors.** Take the command vocabulary from the project's guidance `# Commands` table — never substitute a tool the project does not use:
     1. The project's **read-only whole-tree check** (type check, compile, or build — e.g. a no-emit typecheck, `cargo check`, `go build ./...`): attribute ONLY errors whose file path is in `write-scope` (sibling units' in-flight edits surface as cross-file noise and are NOT yours to act on; revert past them). Re-derive and fix drafted blocks from the attributed errors until clean. If the project records no such command, skip — the apply-at-anchor probe still validates placement.
     2. The project's **path-scoped auto-fix lint/format command** (the scoped form from the `# Commands` table), passed ONLY the write-scope paths — it may rewrite only those. Never run an unscoped auto-fixer: it rewrites sibling phases' in-flight edits.
     3. Any **project-specific invariant check** the guidance names for files in your write-scope (some projects register extra validators for load-bearing files) — run it as recorded there.
   - **Revert.** `git restore <tracked write-scope files>` (undo in-place `Edit`s) and `rm -f <newly-created files>` (undo new-file `Write`s) so the tree returns to its pre-probe state. The mutation is a TRANSIENT, reverted probe — the emitted elaboration doc is the only lasting output (`implement` applies the code later, after the splice).
   - **Guard.** `git status --porcelain` MUST equal the pre-probe snapshot byte-for-byte when you emit. ANY residue (a missed revert, an untracked file, a mode change) is a BLOCKING error: fail the elaboration, emit nothing, and surface the residue.
   - **Fix → re-emit.** From the attributed errors, fix the drafted code blocks in the elaboration; re-probe is optional, but emit ONLY blocks that passed every applicable check above. A clean phase still emits unchanged — the self-check is a no-op pass that reverts byte-identical.
7. **Write the elaboration doc** (below), `status: ready`. Its filename pairs to the plan so the splice can fold it back deterministically — see Output document.
8. **Print the path**, then a one-line summary: `Phase N elaborated: <k> files, <m> code blocks`. **Your path must be the LAST full `.rpiv/artifacts/...` path in your reply** — refer to any other artifact (a sibling phase's elaboration, the plan) by basename only, never by full path. The workflow collector takes the last full artifact path in your final message as YOUR artifact; a full sibling path after yours misattributes the stage's output.

## Output document

Path: `.rpiv/artifacts/elaborations/<plan-basename>__phase-<N>.md`, where `<plan-basename>` is the plan filename **without** the `.md` extension. Example: for `.rpiv/artifacts/plans/2026-06-24_17-13-09_full-width-boxed-workflow-preview.md`, Phase 2 → `.rpiv/artifacts/elaborations/2026-06-24_17-13-09_full-width-boxed-workflow-preview__phase-2.md`.

The body **must** contain exactly one `## Phase <N>: <title>` section — verbatim heading text matching the plan (same `N`, same title). The `stitch-elaborations` script swaps the plan's `## Phase N:` section for this one, so the heading is the splice anchor: do not rename it or change `N`.

```markdown
---
date: <iso>
author: <author>
repository: <repo>
branch: <branch>
commit: <commit>
topic: "<phase title>"
source: <plan-path>
phase_n: <N>
phase_title: "<title>"
status: ready
tags: [elaboration]
---

## Phase <N>: <title>

### Changes

#### `path/to/file.ext`
<one line: what and why>
```<lang>
<implement-ready code — the function/section to add, or the exact edit, grounded in the current file>
```

#### `path/to/other.ext`
<one line>
```<lang>
<code>
```

### Success Criteria
#### Automated Verification:
- [ ] <command / assertion, carried from the plan>
#### Manual Verification:
- [ ] <check>

## Notes / Deferred
<only if a blocker forced an assumption — otherwise omit this section>
```

## Hard rules

- **One phase only.** Never write code for a file another phase owns; reference its interfaces by the shape `synthesize` already fixed.
- **Implement-ready code, grounded in the current tree.** Read the cited files first; emit code blocks, not prose hand-waving ("handle appropriately", "etc.").
- **Repo-root-relative, verifiable citations.** Every `file:line` your elaboration emits — in prose or in code comments — uses the **repo-root-relative** path (`packages/billing/src/invoice.ts:NN`), never a subdirectory-relative form (`src/invoice.ts:NN`) or a bare basename, and must be verifiable at the current revision: cite what you actually read; if you can't verify a line number, cite the path alone and omit the `:line`. Your elaboration is spliced into the plan and passes the deterministic `code-cite-check` floor — one unbacked or ambiguous citation fails the gate and buys the whole run a code-fix loop.
- **Body is exactly one `## Phase N: <title>` section** with the verbatim heading — the deterministic splice folds it back by phase number. Don't rename the heading or change `N`.
- **Write the doc, not the code.** You only write your elaboration artifact; reading the codebase to ground the code is required, editing it is out of scope — `implement` applies the code later, after the splice. The Self-check step's tree mutation is the ONE exception: a transient, reverted probe that applies drafted blocks to verify them, then reverts byte-identical — it never leaves the edit for `implement` (the elaboration doc carries the code; the tree returns clean).
- **Byte-identical self-check revert (the sole parallel-safety contract).** The Self-check `git restore <tracked> + rm -f <new>` MUST return the tree to a `git status --porcelain` byte-identical pre-probe snapshot; any residue is a blocking error and the unit emits nothing. Under the parallel phase fanout a sibling unit's in-flight edit can surface as cross-file check noise — attribute ONLY errors in YOUR write-set and revert past the rest.
- **Per-phase write-scope.** Each unit applies and reverts ONLY the files its phase's `### Changes` names — the same write-scope discipline `implement`'s single-phase mode follows. Never probe, edit, or revert a file another phase owns. A declared production file's co-located test twin (e.g. `x.ts` → `x.test.ts`) is inside the phase's write-scope automatically — the scope floor and the implement DAG both twin-expand `files:` — so a mechanical twin follow-up (mock arity, call-site signature) needs no scope-addition note; only a NON-twin file outside the phase's `files:` is a scope change worth flagging.
- **No subagents. No self-review. No `ask_user_question`.** Decide, record any deferral in Notes, write — the grade panel is the validation.
