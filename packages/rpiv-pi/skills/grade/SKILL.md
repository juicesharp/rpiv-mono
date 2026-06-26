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

- `--dimension <name>` **(required)** — one of:
  - **artifact dimensions** (any artifact): `completeness`, `correctness`, `actionability`, `architecture-fit`, `pattern-following`.
  - **slice-breakdown dimensions** (a slice map — the sizing gate): `right-sizing`, `independence`, `design-readiness`, `vertical-shape`.
- `--artifact <path>` **(required)** — the artifact under review.
- `--context <path>` *(optional)* — a supporting artifact (e.g. the research doc). **Required for `architecture-fit`.**

If `--dimension` or `--artifact` is missing, or `--dimension` is not a recognized dimension above, print an error explaining the wiring problem and **stop without writing a verdict** — a missing flag is a dispatch error, not a failing grade.

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
| `right-sizing` | Each slice fits a **single design+implementation pass**, sized by **surface area — not wall-clock hours**: the count of files/symbols/layers its Scope + Draws-on implies, plus its dependency fan-out (downstream callers of any interface it changes — the real driver of single-pass context exhaustion). No epic (spans many subsystems, or bundles capabilities via "and"/"or"/"manage") and no noise fragment that should merge. | Each `## Slice N:` Scope + Draws-on; **spot-check** the cited `file:line`s to gauge true surface area & fan-out. | Every slice's surface area fits one focused pass (or names a justified foundational exception), and `slice_count` > 1 without being over-atomized. |
| `independence` | Slices form a **DAG with minimal, explicit dependencies** — every cross-slice need is declared in `Depends on`, there is **no dependency cycle** (A→B→A; the true defect → merge or re-slice), and any genuinely shared interface/schema is owned by exactly one slice (contract-first). **Shared files and linear sequencing edges are fine** — perfect any-order independence is not the bar. | Each slice's `Depends on` + `Out of scope`, **cross-referenced across all slices** for cycles and for shared contracts with no single owner. | No `deps` cycle; every dependency is explicit and acyclic; every shared contract has a single owning slice. |
| `design-readiness` | Each slice is **designable in isolation in one pass** — its `Scope` states a verifiable outcome *in principle* (an observable capability), its `Draws on` cites real `file:line` grounding so the design agent need not re-discover context, and `Out of scope` fences it cleanly so the design won't leak into sibling slices or overreach. Concrete acceptance criteria / file maps are **deferred to `design-slice`**, not required here. | Each slice's `Scope`, `Draws on`, `Out of scope`. | Every slice names an observable outcome, cites real grounding, and has clean out-of-scope boundaries — enough for a one-pass design with no rediscovery or overreach. |
| `vertical-shape` | Each slice delivers an **observable, user/system-meaningful outcome** that maps to a recognized split (workflow step, path, interface, data, rule), not a horizontal layer/tech task ("build the schema", "wire up the UI", "set up X") valuable only once combined with sibling slices. | Each `## Slice N:` title + Scope. | No slice is a pure single-layer/technical task with no standalone observable value, or the divergence is justified (e.g. one foundational slice). |

## Steps

1. **Parse + validate flags.** Bail per the Input rules above if malformed.
2. **Read fully** (no limit/offset): `--artifact`, and `--context` if given.
3. **Select the single rubric row** for `--dimension`. Ignore every problem outside it.
4. **Evaluate.** For `correctness` / `architecture-fit` / `pattern-following` / `right-sizing` / `independence`, spot-check against the real codebase — resolve references, compare conventions, check boundaries, gauge each slice's surface area & dependency fan-out, and cross-check the slices for dependency cycles & unowned shared contracts. For `completeness` / `actionability` / `design-readiness` / `vertical-shape`, judge the artifact's own content. Collect findings — each is `{ detail, where }` (`where` = `path:line` or a section heading; for slice dimensions, cite the offending `## Slice N`). Where a `right-sizing` / `independence` finding fires, the `feedback` must name the exact re-cut (which slice to split and along which seam, or which overlap to separate) so `refine` can act on it.
5. **Decide** `pass` (against the pass bar), `score` (0–100), `severity` (`none` | `low` | `medium` | `high` = the worst finding), and `feedback`. **Every string you emit (`feedback` and each `findings[].detail` / `where`) MUST be JSON-safe: a single line, no literal newlines or tabs, no backticks or code fences, double-quotes escaped as `\"`. Put `path:line` citations in `findings[].where` — never paste code snippets into `feedback`.**
   - `pass: false` → `feedback` is a **surgical, concrete instruction set** telling `refine` exactly what to change to clear this dimension, citing `where`. This field is the only thing `refine` reads — make it sufficient but concise (≤ ~500 chars; lean on `findings[]` for specifics).
   - `pass: true` → `feedback` is **one short sentence, or empty** — never a multi-sentence essay. A long free-text value on a pass is pure JSON-malform risk with no consumer.
6. **Write the verdict** with the Write tool to `.rpiv/artifacts/verdicts/<artifact-basename-without-ext>__<dimension>.json`, overwriting any prior verdict for this `(artifact, dimension)` pair. **Always write it, even on pass** — the panel collects this file to score the gate. **Emit machine-valid JSON only**: every string single-line with quotes escaped, no literal newlines, no backticks/code fences, no raw control characters. **After writing, re-read the file and confirm it parses as JSON; if it doesn't (an unescaped quote, a stray comma, a code fence in a value), rewrite it minimally until it parses.**
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
- **Machine-valid JSON.** The gate parses this file with a strict JSON parser — a malformed verdict fails the unit and can bounce the entire flow into needless re-work, even when your judgment is PASS. Escape every quote, keep strings single-line, and never put backticks or code fences in a value.
