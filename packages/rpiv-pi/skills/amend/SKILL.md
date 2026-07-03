---
name: amend
description: Surgically fix ONE artifact (research, plan, or any doc) to clear the failing dimensions a grade panel flagged — reads the artifact plus its dimension verdicts, applies only the cited findings' feedback, and re-emits the artifact in place. Single-pass, no subagents, no self-review, no questions. Generalized reviser parameterized by flags; the workflow loops it straight back to the grade panel for re-judging. Use as a gate's revise stage.
argument-hint: "--<channel> <artifact-path> --<channel>-verdicts <verdict-path> [--<channel>-verdicts <verdict-path> ...]"
allowed-tools: Read, Edit, Write, Grep, Glob
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
---

# Amend

You surgically fix **one** artifact so it clears the dimensions a grade panel marked failing. You apply **only** what the failing verdicts cite — you do not rewrite the artifact, expand its scope, or touch dimensions that already pass. One pass, non-interactive. The workflow loops your re-emitted artifact straight back to the grade panel, which re-judges; that is the only validation, so you do **not** self-review or ask for approval.

## Input

`$ARGUMENTS` — flags the orchestrator wires from the gate's channels. Parse them **generically**, agnostic to the channel name:

- **Verdicts** — every flag whose name ends in `-verdicts` (e.g. `--research-verdicts`, `--plan-verdicts`), repeatable. Each value is a verdict JSON path.
- **Artifact** — the single remaining `--<channel>` flag (the one **not** ending in `-verdicts`). Its value is the artifact to fix and re-emit.

If you can't identify exactly one artifact flag and at least one verdicts flag, print an error and stop.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
```

The first tab-separated field is `<iso>` (use as `last_updated`).

## Steps

1. **Read the artifact fully** (no limit/offset) and **read every verdict JSON**.
2. **Select the failing findings.** Group verdicts by `dimension`; for each dimension keep the **latest** (by `graded_at`) — verdicts accumulate across amend loops, so an older failing verdict may already be superseded. From the latest-per-dimension set, take those with `pass: false`. If none fail, the artifact already passes: re-emit it unchanged (only bump `last_updated`) and report — the panel will confirm.
3. **Apply each failing verdict's `feedback`/`findings` surgically.** Use each finding's `where` to locate the exact spot and change only that. Honor `feedback` as the instruction set. Where a finding requires checking the codebase (a `correctness` or `pattern-following` fix), Read/Grep the cited `file:line` to ground the edit — but never edit code, only the artifact.
4. **Confirm coverage** — every failing finding maps to an edit you made. Do not introduce changes no finding asked for.
5. **Re-emit the artifact to the SAME path** (Edit in place; Write only if a structural rewrite of a section is unavoidable). Preserve everything outside the cited findings, keep `status: ready`, and update `last_updated: <iso>` in the frontmatter. Same path ⇒ the artifact's channel updates latest-wins for re-judging.
6. **Print the artifact path**, then a one-line summary: `amended for <dimensions>: <k> findings addressed`.

## Hard rules

- **Surgical, not wholesale.** Touch only what the failing findings cite; leave passing content and untouched sections byte-for-byte.
- **Fix the artifact, never the repo.** Reading repo source to ground an edit is fine; editing files in the codebase is out of scope — `implement` owns that. **Note:** when the artifact is a code-bearing plan (a spliced plan whose phases already embed elaborated code blocks), those embedded code blocks **are part of the artifact** — if a failing finding cites one (a fabricated edit anchor, a wrong snippet, a drifted `file:line`), fix it in place like any other artifact content. The boundary is the repo working tree, not the plan's own fenced code.
- **Re-emit in place.** Same filename so the gate re-judges the same channel; never fork a new artifact path.
- **No subagents. No self-review. No `ask_user_question`.** Apply the verdicts and re-emit; the grade panel is the validation.
