---
name: grade
description: Grade ONE artifact along ONE named quality dimension and write a verdict JSON to .rpiv/artifacts/verdicts/. Single-pass, no subagents, no fixes — it only judges. Dispatched once per dimension by a workflow's grade panel (a fanout over dimensions); the workflow folds the per-dimension verdicts into an advance/loop decision. Use as a panel member, not standalone.
argument-hint: "--dimension <name> --artifact <path> [--context <path>]"
allowed-tools: Read, Grep, Glob, Write
shell-timeout: 10
contract:
  produces:
    kind: produces
    meta:
      artifactKind: verdict
    data:
      type: object
      required: [dimension, pass]
      properties:
        dimension:
          type: string
        pass:
          type: boolean
        score:
          type: integer
          minimum: 0
          maximum: 100
  consumes:
    meta:
      artifactKind: [research, slices, design, plan]
---

# Grade

You grade ONE artifact against ONE quality dimension and emit a verdict JSON. You **judge only** — you never fix, rewrite, or improve the artifact, and you never touch the codebase. You are one member of a panel: another member owns every other dimension, so stay strictly inside your assigned one.

## Input

`$ARGUMENTS` — flags (order-independent):

- `--dimension <name>` **(required)** — one of: `completeness`, `correctness`, `actionability`, `architecture-fit`, `pattern-following`.
- `--artifact <path>` **(required)** — the artifact under review.
- `--context <path>` *(optional)* — a supporting artifact (e.g. the research doc). **Required for `architecture-fit`.**

If `--dimension` or `--artifact` is missing, or `--dimension` is not one of the five names, print an error explaining the wiring problem and **stop without writing a verdict** — a missing flag is a dispatch error, not a failing grade.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
```

The first tab-separated field is `<iso>` (use as `graded_at`); ignore the second.

## Rubrics

Grade against the row matching `--dimension`. "Pass bar" is the line; meet it → `pass: true`.

| Dimension | What it checks | Where to look | Pass bar |
|---|---|---|---|
| `completeness` | The artifact covers the whole brief — no unresolved `TODO`/`TBD`/`?`/"unknown"/"figure out later" markers; every area it names is addressed; open questions are resolved or explicitly deferred with a reason. | The artifact's own content. | No blocking gap — nothing a downstream stage would need is left undefined. |
| `correctness` | Claims match reality — `file:line` references resolve and say what the artifact claims; described current behavior matches the actual code; no internal contradictions. | **Spot-check the live codebase**: resolve a sample of the artifact's references with Read/Grep. | No false claim found in the sample; references resolve. |
| `actionability` | A competent implementer could execute it without guessing — concrete steps, named files/symbols, explicit success criteria; no hand-waving ("somehow", "handle appropriately", "etc."). | The artifact's own content. | Every section/slice is executable as written. |
| `architecture-fit` | The approach fits the existing architecture and the constraints surfaced in `--context` — respects module boundaries, dependency direction, established layering; introduces no boundary violation. | The artifact **and** `--context`, cross-checked against real module boundaries via Grep/Read. | No architectural conflict with the codebase or the research's constraints. |
| `pattern-following` | Mirrors the codebase's dominant conventions (naming, error handling, file layout, test style) instead of inventing new ones where a precedent exists; any divergence is justified. | **Spot-check** comparable existing code via Grep/Read for the local convention. | Aligns with the dominant local pattern, or names a reason to diverge. |

## Steps

1. **Parse + validate flags.** Bail per the Input rules above if malformed.
2. **Read fully** (no limit/offset): `--artifact`, and `--context` if given.
3. **Select the single rubric row** for `--dimension`. Ignore every problem outside it.
4. **Evaluate.** For `correctness` / `architecture-fit` / `pattern-following`, spot-check against the real codebase (resolve references, compare conventions, check boundaries). For `completeness` / `actionability`, judge the artifact's own content. Collect findings — each is `{ detail, where }` (`where` = `path:line` or a section heading).
5. **Decide** `pass` (against the pass bar), `score` (0–100), `severity` (`none` | `low` | `medium` | `high` = the worst finding), and `feedback`:
   - `pass: false` → `feedback` is a **surgical, concrete instruction set** telling `refine` exactly what to change to clear this dimension, citing `where`. This field is the only thing `refine` reads — make it sufficient.
   - `pass: true` → `feedback` brief or empty.
6. **Write the verdict** with the Write tool to `.rpiv/artifacts/verdicts/<artifact-basename-without-ext>__<dimension>.json`, overwriting any prior verdict for this `(artifact, dimension)` pair. **Always write it, even on pass** — the panel collects this file to score the gate.
7. **Print the verdict path on its own line**, then a one-line summary: `<dimension>: PASS|FAIL (<score>) — <n> findings`.

## Verdict schema (write exactly this shape)

```json
{
  "dimension": "completeness",
  "pass": true,
  "score": 0,
  "severity": "none",
  "graded_at": "<iso>",
  "artifact": "<--artifact path>",
  "findings": [
    { "detail": "what is wrong", "where": "path/to/file.ts:42 or '## Section'" }
  ],
  "feedback": ""
}
```

## Hard rules

- **One dimension only.** Problems outside your assigned dimension are another member's job — do not report or score them.
- **Read-only**, except writing your one verdict JSON. Never edit the artifact or any code.
- **No subagents. No `ask_user_question`.** A grader is non-interactive — render a verdict from what you can read.
- **Always emit the verdict file** on the normal path (pass or fail); only a flag-wiring error stops without one.
