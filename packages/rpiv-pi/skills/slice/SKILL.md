---
name: slice
description: Decompose a research artifact into independent vertical slices — each a self-contained, separately-designable unit — and write a slice map to .rpiv/artifacts/slices/ with a machine-readable `slices:` frontmatter array. A research artifact is required (it is the cut's grounding); confirms the decomposition with you before writing. Also runs in RE-SLICE mode (`--slices <map> --slice-verdicts <v>…`) to STRUCTURALLY re-cut a slice map that failed the design-readiness gate — splitting epics, completing under-cited footings, redistributing frozen coverage units, breaking dependency cycles, renumbering — which a surgical reviser cannot do. Feeds a per-slice design fanout.
argument-hint: "<research-path>  |  --slices <map> --slice-verdicts <verdict>..."
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: slices
    data:
      type: object
      required: [slices, slice_count]
      properties:
        status:
          enum: [in-progress, in-review, ready]
        slice_count:
          type: integer
          minimum: 1
          maximum: 32
        coverage:
          type: array
          items:
            type: object
            required: [id]
            properties:
              id: { type: string }
              brief: { type: string }
        slices:
          type: array
          minItems: 1
          maxItems: 32
          items:
            type: object
            required: [n, title]
            properties:
              n: { type: integer, minimum: 1 }
              title: { type: string }
              deps: { type: array, items: { type: integer } }
              covers: { type: array, items: { type: string } }
  consumes:
    data:
      type: object
      properties:
        status:
          const: ready
    reads:
      slices: {}
      slice-verdicts: {}
    meta:
      artifactKind: [research]
---

# Slice

You decompose a feature into **independent vertical slices** and write a slice map. You do **not** design, plan phases, write implementation steps, or self-review — `design-slice` fills each slice in next. A research artifact grounds the cut (every slice's `Draws on:` cites real `file:line`s from it); you confirm the decomposition with the developer before writing.

## Input

`$ARGUMENTS` takes two forms:

1. **Fresh** — a path to a `.rpiv/artifacts/research/*.md` artifact (no flags). Decompose from scratch via Steps 1–6, grounded in that research. The research artifact is **required**: if the argument is missing, empty, or not a research path, print an error and stop — it's a dispatch error (the workflow runs `research` before `slice`).
2. **Re-slice** (the re-slice loop) — `--slices <map-path> --slice-verdicts <verdict-path> … [--slice-check <structural-verdict-path> …]` (the `--slice-verdicts` and `--slice-check` flags repeat). **Re-cut the existing slice map** to clear the failures its verdicts name. Recognize this form by the `--slices` flag and follow **Re-slice mode** below — NOT the fresh Steps (no confirm). `--slice-check` carries the **deterministic** structural findings (dependency cycles, dropped coverage units, unbacked `file:line` citations) — treat them exactly like a verdict's findings; they are the un-gameable floor and MUST all be cleared.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim — do not reformat the timezone offset. `<iso>` is the first tab-separated field on line 1; `<slug>` is the second.

## What a slice is

A vertical slice is a coherent, independently-buildable capability that cuts through whatever layers it needs (data → logic → surface). Good slices are:

- **Independent** — designable and reviewable on their own; minimize cross-slice coupling.
- **Vertical** — a user- or system-meaningful capability, never a horizontal layer ("all the types", "all the tests").
- **Right-sized** — chewable by a single `design-slice` pass each: one coherent architecture decision resting on a bounded, fully-cited real footing (the `file:line`s the design must read). `design-slice` does NO discovery, so under-citing a slice's `Draws on` does not make it smaller — it starves the design pass. Not measured by clock time.
- **Honest about dependencies** — when slice B genuinely needs slice A first, record it in `deps`. Keep real deps rare; if everything depends on everything, the cut is wrong.
- **Complete and conserved** — the brief decomposes into ID'd `coverage:` units, each claimed by some slice's `covers:`. The set is frozen at the first cut: a re-cut may redistribute units across slices, never drop one to shrink a slice.

## Flow

1. Input → 2. Decompose → 3. Resolve ambiguity → 4. Confirm → 5. Write → 6. Summary

## Steps

1. **Input.** Read the research path FULLY (no limit/offset) and read the key source files it cites — these are your grounding. A missing, empty, or non-research argument is a dispatch error: print an error and stop (the workflow runs `research` before `slice`, so a research artifact is always available).
2. **Decompose.** Identify the capabilities the work delivers, then group them into independent vertical slices — prefer fewer cohesive slices over many tiny ones. First enumerate the brief's **coverage units** — the distinct observable outcomes it asks for, each with a short stable `id` (`c1`, `c2`, …) and a one-line `brief` — then assign every unit to the slice(s) that deliver it via each slice's `covers:`, so every unit is claimed by at least one slice. Every slice's `Draws on:` cites a real `file:line` from the research read in Step 1 — write the **repo-root-relative path** (`packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts:1431`), never a bare basename (`built-in-workflows.ts:1431`): the deterministic `slice-check` floor resolves every citation against the repo root, so a path-prefix omission fails the gate and forces a re-slice loop.
3. **Resolve ambiguity.** Settle from the research/code wherever you can. When a genuine decomposition fork remains (e.g. "combine auth + session into one slice, or split them?"), use `ask_user_question` with 2–4 concrete options — **one at a time**, wait for the answer.
4. **Confirm the decomposition.** Once, before writing: `ask_user_question` — "{N} slices for {topic}. Slice 1: {name}. Slices 2–N: {brief}. Approve?". Header "Slices". Options: "Approve (Recommended)" (write the map); "Adjust slices" (reorder/merge/split); "Change scope" (add/remove). Apply the answer, then write.
5. **Write the slice map** (below) with `status: ready`.
6. **Print the path**, then a one-line summary: `<N> slices: <comma-separated titles>`.

## Re-slice mode (`--slices` present)

You are re-cutting an existing slice map from its verdicts. Unlike a surgical reviser, you have **full structural authority** — split an epic, merge fragments, renumber, redistribute coverage, rewrite `deps`. A surgical "touch only the cited line" edit cannot split a slice; you can.

1. **Read** the `--slices` map FULLY and every `--slice-verdicts` and `--slice-check` JSON. The `coverage:` units are **frozen** — copy them verbatim. Treat the failing findings as **joint constraints**: a fix for one must not regress something that was passing. Each verdict's `feedback` names the exact re-cut (e.g. *"Re-cut Slice 1B along the function-vs-placement seam"*); each `--slice-check` finding's `detail`/`where` names the exact structural break to repair.
2. **Apply the re-cut STRUCTURALLY** — find the seam that fixes the finding without trading it for another:
   - **oversized / under-cited / horizontal layer / overreaching fence / >1 owned contract** → re-cut along a *vertical* seam so each piece is one coherent decision on a bounded, fully-cited footing with standalone value. Prefer a seam that doesn't swap one failure for another (a state-vs-view split usually loses standalone value; a function-vs-placement split usually keeps it).
   - **dependency cycle** (from `--slice-check`) → merge the cycle into one slice, or invert an edge so a shared contract has a single owner.
   - **dropped coverage unit** (from `--slice-check`) → re-attach its `id` to the `covers:` of whichever slice now delivers it; never resolve this by deleting the unit.
   - **unbacked `file:line` citation** (from `--slice-check`) → correct the `Draws on:` reference to a real **repo-root-relative** `file:line` (not a bare basename), or drop the line numbers; never leave a fabricated citation.
3. **Rebuild the invariants** — renumber `n` contiguously `1..N`, recompute `slice_count`, fix `deps`, carry `coverage:` forward verbatim and reassign `covers:` so the union still claims every unit, and keep exactly one `## Slice N:` heading per entry.
4. **Re-emit** the slice map (same Output shape, `status: ready`). **Non-interactive**: the verdict feedback IS the instruction — no confirm step, no `ask_user_question`.
5. **Print** the path, then `re-sliced: <N> slices (was <M>) — addressed <failing dimensions>`.

## Output document

Path: `.rpiv/artifacts/slices/<slug>_<topic>.md` — `<slug>` is the second field of the metadata block; `<topic>` is a brief kebab-case description.

The frontmatter **must** carry a `slices:` array and `slice_count`, and `slice_count` **must equal both** the array length **and** the number of `## Slice N:` headings in the body (a downstream derive-check rejects any mismatch). It **must** also carry a `coverage:` array of `{ id, brief }` units, with every unit's `id` appearing in at least one slice's `covers:`. On a re-slice the `coverage:` array is frozen — carry it forward verbatim.

```markdown
---
date: <iso>
author: <author from metadata>
repository: <repo>
branch: <branch>
commit: <commit>
topic: "<Topic>"
source: <research-path | "brief">
status: ready
slice_count: <N>
coverage:
  - { id: c1, brief: "<an observable outcome the brief asks for>" }
  - { id: c2, brief: "<an observable outcome the brief asks for>" }
slices:
  - { n: 1, title: "<title>", deps: [], covers: [c1] }
  - { n: 2, title: "<title>", deps: [1], covers: [c2] }
tags: [slices]
---

# Slices: <Topic>

## Slice 1: <title>
**Scope:** <what this slice delivers, end to end>
**Draws on:** <research sections / file:line this slice rests on>
**Depends on:** none
**Out of scope:** <what belongs to other slices>

## Slice 2: <title>
**Scope:** ...
**Draws on:** ...
**Depends on:** Slice 1 (<why>)
**Out of scope:** ...
```

## Hard rules

- Exactly one `## Slice N:` heading per `slices:` entry; `slice_count` == array length == heading count. Number `n` contiguously `1..N`.
- Every `coverage:` unit is claimed by ≥1 slice's `covers:`; on a re-slice, conserve the frozen `coverage:` array verbatim — redistribute `covers:`, never drop a unit.
- **Scope boundaries, not designs.** No architecture decisions, no file maps, no implementation steps — `design-slice` fills each slice in next.
- **No subagents, no self-review.** Ground the cut in the supplied research artifact; do not run discovery agents.
- **Read the research before decomposing; confirm the decomposition before writing.**
