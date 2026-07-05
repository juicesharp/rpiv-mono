---
name: grade
description: Grade ONE artifact along ONE named quality dimension and write a verdict JSON to .rpiv/artifacts/verdicts/. Single-pass, no subagents, no fixes — it only judges. Dispatched once per dimension by a workflow's grade panel (a fanout over dimensions); the workflow folds the per-dimension verdicts into an advance/loop decision. Use as a panel member, not standalone.
argument-hint: "--dimension <name> --artifact <path> [--context <path>] [--goal <path>]"
allowed-tools: Read, Grep, Glob, Write
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: verdict
    data:
      type: object
      required: [dimension, pass, severity]
      properties:
        dimension:
          type: string
        pass:
          type: boolean
        score:
          type: integer
          minimum: 0
          maximum: 100
        severity:
          type: string
          enum: [none, low, medium, high]
        risk_rulings:
          type: array
          items:
            type: object
            required: [id, pass]
            properties:
              id: { type: string }
              pass: { type: boolean }
  consumes:
    meta:
      artifactKind: [research, slices, design, plan]
---

# Grade

You grade ONE artifact against ONE quality dimension and emit a verdict JSON. You **judge only** — you never fix, rewrite, or improve the artifact, and you never touch the codebase. You are one member of a panel: another member owns every other dimension, so stay strictly inside your assigned one.

## Input

`$ARGUMENTS` — flags (order-independent):

- `--dimension <name>` **(required)** — one of:
  - **artifact dimensions** (any artifact): `completeness`, `correctness`, `actionability`, `architecture-fit`, `pattern-following`.
  - **slice-breakdown dimension** (a slice map): `design-readiness`. (Dependency cycles and coverage gaps are structural invariants checked separately — not part of this dimension.)
- `--artifact <path>` **(required)** — the artifact under review.
- `--context <path>` *(optional)* — a supporting artifact (e.g. the research doc). **Required for `architecture-fit`.**
- `--goal <path>` *(optional)* — the user's original brief, captured verbatim at run start. **Read it only for `completeness` and `correctness`** — every other dimension ignores it. Absent, or the file is empty → grade the artifact on its own content as usual.

**Plan-authored risk flags (the `correctness` dimension only).** When your `--dimension` is `correctness` and the `--artifact` carries a `risks:` frontmatter array (each `{ id, claim }`, described in the plan's `## Risk Flags` section), you are REQUIRED to rule on every flag — this is a first-class channel, not an optional prose aside. For each flag, verify its `claim` against the real codebase / the plan (Read/Grep the relevant `file:line`) and decide `pass` (the concern is unfounded or already handled) or `fail` (the risk is real and unaddressed). Emit these as a `risk_rulings: [{ id, pass }]` array in your verdict — one ruling per declared flag, none omitted. A `fail` ruling blocks the gate (the workflow folds these across the panel), so an assumption the plan flagged for review cannot ride a green pass into commit. Other dimensions ignore `risks:`.

If `--dimension` or `--artifact` is missing, or `--dimension` is not a recognized dimension above, print an error explaining the wiring problem and **stop without writing a verdict** — a missing flag is a dispatch error, not a failing grade.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
```

The first tab-separated field is `<iso>` (use as `graded_at`); the second is `<slug>` (a filesystem-safe timestamp, e.g. `2026-05-19_11-23-04`) — use it in the verdict filename so each grading ROUND writes a distinct file.

## Rubrics

Grade against the row matching `--dimension`. "Pass bar" is the line; meet it → `pass: true`.

| Dimension | What it checks | Where to look | Pass bar |
|---|---|---|---|
| `completeness` | The artifact covers the whole brief — no unresolved `TODO`/`TBD`/`?`/"unknown"/"figure out later" markers; every area it names is addressed; open questions are resolved or explicitly deferred with a reason. **When `--goal` is given, the brief IS the goal file**: every explicit ask and constraint in it is addressed or explicitly deferred with a reason — a requirement present in the goal but absent from the artifact is a blocking gap. | The artifact's own content, cross-checked against `--goal` when given. | No blocking gap — nothing a downstream stage would need is left undefined, and no explicit `--goal` ask is silently dropped. |
| `correctness` | Claims match reality — `file:line` references resolve and say what the artifact claims; described current behavior matches the actual code; no internal contradictions. When `--goal` is given, no claim or decision contradicts an explicit constraint stated in it. | **Spot-check the live codebase**: resolve a sample of the artifact's references with Read/Grep; check decisions against `--goal` when given. | No false claim found in the sample; references resolve; no explicit `--goal` constraint contradicted. |
| `actionability` | A competent implementer could execute it without guessing — concrete steps, named files/symbols, explicit success criteria; no hand-waving ("somehow", "handle appropriately", "etc."). | The artifact's own content. | Every section/slice is executable as written. |
| `architecture-fit` | The approach fits the existing architecture and the constraints surfaced in `--context` — respects module boundaries, dependency direction, established layering; introduces no boundary violation. | The artifact **and** `--context`, cross-checked against real module boundaries via Grep/Read. | No architectural conflict with the codebase or the research's constraints. |
| `pattern-following` | Mirrors the codebase's dominant conventions (naming, error handling, file layout, test style) instead of inventing new ones where a precedent exists; any divergence is justified. | **Spot-check** comparable existing code via Grep/Read for the local convention. | Aligns with the dominant local pattern, or names a reason to diverge. |
| `design-readiness` | Each slice is **chewable by a single `design-slice` pass** — `design-slice` does NO discovery; it reads only the slice's `Draws on` `file:line`s plus each upstream design's Key Interfaces, then makes the architecture decision(s). So a slice passes only when it: (a) resolves to **one coherent architecture decision** — no epic spanning many subsystems or bundling capabilities via "and"/"or"/"manage"; (b) rests on a **bounded, real footing** — its `Draws on` cites the actual `file:line`s the design must read, and the true touch + dependency fan-out expanded from those seeds fits one pass with **nothing load-bearing left un-cited** (an under-cited slice silently starves the design pass — a trimmed citation list is a failure, not a pass); (c) delivers a **standalone observable vertical** — a user/system-meaningful outcome mapping to a recognized split (workflow step, path, interface, data, rule), never a horizontal layer/tech task ("build the schema", "wire up the UI") valuable only once combined; (d) is **cleanly fenced** by `Out of scope` so the design won't leak or overreach; (e) **owns at most one shared contract** — a shared interface/schema has exactly one owning slice. Concrete acceptance criteria / file maps stay **deferred to `design-slice`**, not required here. | Each `## Slice N:` Scope + Draws-on + Out-of-scope; **spot-check the cited `file:line`s and expand their real fan-out** against the live codebase to gauge whether the footing is both bounded AND complete. | Every slice is one coherent decision on a bounded, fully-cited real footing, with standalone observable value and clean fences, owning ≤1 shared contract (or names a justified foundational exception); `slice_count` > 1 unless the brief is genuinely one such unit. |

## Steps

1. **Parse + validate flags.** Bail per the Input rules above if malformed.
2. **Read fully** (no limit/offset): `--artifact`, and `--context` / `--goal` if given (skip `--goal` unless your dimension is `completeness` or `correctness`).
3. **Select the single rubric row** for `--dimension`. Ignore every problem outside it.
4. **Evaluate.** For `correctness` / `architecture-fit` / `pattern-following` / `design-readiness`, spot-check against the real codebase — resolve references, compare conventions, check boundaries, expand each slice's true touch + dependency fan-out from its cited seeds to gauge whether the footing is bounded AND complete, and check each shared contract has a single owning slice. For `completeness` / `actionability`, judge the artifact's own content. **On `correctness`, also rule every plan-authored risk flag** (see "Plan-authored risk flags" above) — verify each `risks:` claim against the code and record a `risk_rulings` entry. Collect findings — each is `{ detail, where }` (`where` = `path:line` or a section heading; for slice dimensions, cite the offending `## Slice N`). Where a `design-readiness` finding fires, the `feedback` must name the exact re-cut (which slice to split and along which seam, which under-cited grounding to add, or which overlap to separate) so the re-slice can act on it.
5. **Decide** `pass` (against the pass bar), `score` (0–100), `severity` (`none` | `low` | `medium` | `high` = the worst finding), and `feedback`. **`severity` is gate-load-bearing: the workflow treats any verdict whose worst finding is `low`/`none` as passing, even on `pass: false`, and only a `medium`+ finding blocks the gate.** So set `severity` to honestly reflect blocking weight — `low`/`none` for a cosmetic nit (a line-number off by one or two, a stylistic phrasing, a naming quibble that doesn't change behavior), `medium`+ for a finding a downstream stage genuinely cannot proceed past (a reference that won't resolve, a missing step, an executable edit that would fail as written, a boundary violation). Do **not** mark a real blocker `low` to be lenient, and do **not** mark a cosmetic nit `medium`+ to force a re-run — the gate reads `severity`, so mis-rating it either ships a defect or stalls the loop. **Every string you emit (`feedback` and each `findings[].detail` / `where`) MUST be JSON-safe: a single line, no literal newlines or tabs, no backticks or code fences, double-quotes escaped as `\"`. Put `path:line` citations in `findings[].where` — never paste code snippets into `feedback`.**
   - `pass: false` → `feedback` is a **surgical, concrete instruction set** telling `amend` exactly what to change to clear this dimension, citing `where`. This field is the only thing `amend` reads — make it sufficient but concise (≤ ~500 chars; lean on `findings[]` for specifics).
   - `pass: true` → `feedback` is **one short sentence, or empty** — never a multi-sentence essay. A long free-text value on a pass is pure JSON-malform risk with no consumer.
6. **Write the verdict** with the Write tool to `.rpiv/artifacts/verdicts/<artifact-basename-without-ext>__<dimension>__<slug>.json` (`<slug>` from the Metadata block). Do **not** overwrite a prior round's verdict for this `(artifact, dimension)` pair — the round-distinct `<slug>` preserves each round's findings, so the round-1 findings that drove a fix stay in the trail instead of being clobbered by round 4. The panel folds by latest-per-dimension, so the newest round still decides the gate. **Always write it, even on pass** — the panel collects this file to score the gate. **Emit machine-valid JSON only**: every string single-line with quotes escaped, no literal newlines, no backticks/code fences, no raw control characters. **After writing, re-read the file and confirm it parses as JSON; if it doesn't (an unescaped quote, a stray comma, a code fence in a value), rewrite it minimally until it parses.**
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
  "risk_rulings": [
    { "id": "r1", "pass": true }
  ],
  "feedback": ""
}
```

Include `risk_rulings` **only** on a `correctness` verdict when the artifact declares `risks:` — one entry per flag. Omit the key entirely on every other dimension and when the artifact declares no risks.

## Hard rules

- **One dimension only.** Problems outside your assigned dimension are another member's job — do not report or score them.
- **Goal findings quote the goal.** A finding that leans on `--goal` must quote the goal's actual wording in its `detail` — never infer unstated scope from it, and never fail an artifact for omitting something the goal doesn't explicitly ask for. Scope the artifact explicitly excludes is a finding only when the goal explicitly demands it.
- **Read-only**, except writing your one verdict JSON. Never edit the artifact or any code.
- **No subagents. No `ask_user_question`.** A grader is non-interactive — render a verdict from what you can read.
- **Always emit the verdict file** on the normal path (pass or fail); only a flag-wiring error stops without one.
- **Machine-valid JSON.** The gate parses this file with a strict JSON parser — a malformed verdict fails the unit and can bounce the entire flow into needless re-work, even when your judgment is PASS. Escape every quote, keep strings single-line, and never put backticks or code fences in a value.
