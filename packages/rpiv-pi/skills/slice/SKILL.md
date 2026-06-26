---
name: slice
description: Decompose a research artifact (or a free-text brief) into independent vertical slices — each a self-contained, separately-designable unit — and write a slice map to .rpiv/artifacts/slices/ with a machine-readable `slices:` frontmatter array. Runs a lightweight codebase research sweep when no research artifact is provided, then confirms the decomposition with you before writing. Also runs in RE-SLICE mode (`--slices <map> --slice-verdicts <v>…`) to STRUCTURALLY re-cut a slice map that failed the sizing gate — splitting epics, breaking dependency cycles, renumbering — which a surgical reviser cannot do. Feeds a per-slice design fanout.
argument-hint: "[research-path | free-text brief]  |  --slices <map> --slice-verdicts <verdict>..."
shell-timeout: 10
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

You decompose a feature into **independent vertical slices** and write a slice map. You do **not** design, plan phases, write implementation steps, or self-review — `design-slice` fills each slice in next. When no research artifact is provided, you ground the cut with a quick codebase sweep first; you confirm the decomposition with the developer before writing.

## Input

`$ARGUMENTS` takes two forms:

1. **Fresh** — a path to a `.rpiv/artifacts/research/*.md` artifact, or a free-text brief (no flags). Decompose from scratch via Steps 1–7. If empty, ask the user for it and wait.
2. **Re-slice** (the sizing gate's loop) — `--slices <map-path> --slice-verdicts <verdict-path> …` (the `--slice-verdicts` flag repeats). **Re-cut the existing slice map** to clear the sizing dimensions it failed. Recognize this form by the `--slices` flag and follow **Re-slice mode** below — NOT Steps 2 (research) or 5 (confirm).

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
echo
echo "### recent (read only in case of empty user input)"
echo "recent research:"
node "${SKILL_DIR}/../_shared/list-recent.mjs" .rpiv/artifacts/research 4
```

Copy values verbatim — do not reformat the timezone offset. `<iso>` is the first tab-separated field on line 1; `<slug>` is the second.

## What a slice is

A vertical slice is a coherent, independently-buildable capability that cuts through whatever layers it needs (data → logic → surface). Good slices are:

- **Independent** — designable and reviewable on their own; minimize cross-slice coupling.
- **Vertical** — a user- or system-meaningful capability, never a horizontal layer ("all the types", "all the tests").
- **Right-sized** — fits a single focused design pass each; split by **surface area** (the files/symbols/layers it touches and its dependency fan-out), not by clock time.
- **Honest about dependencies** — when slice B genuinely needs slice A first, record it in `deps`. Keep real deps rare; if everything depends on everything, the cut is wrong.

## Flow

1. Input → 2. Research (only if none provided) → 3. Decompose → 4. Resolve ambiguity → 5. Confirm → 6. Write → 7. Summary

## Steps

1. **Input.** Given a research path: read it FULLY (no limit/offset) and read the key source files it cites — these are your grounding. No argument: pick from the `recent research:` listing (ask). Plain free-text: treat it as the topic for Step 2.
2. **Research — only when no research artifact was provided (parallel agents).** A quick DEPTH sweep, not discovery. Spawn in parallel with the Agent tool: `codebase-pattern-finder` (the shape to model) and `integration-scanner` (wiring + the natural slice seams); add `precedent-locator` for risky surfaces (auth, migrations, schema, hot paths) and `web-search-researcher` for external APIs/SDKs. Read the key files they surface. Wait for ALL agents before proceeding. Skip this step entirely when a research artifact already gave you the grounding.
3. **Decompose.** Identify the capabilities the work delivers, then group them into independent vertical slices — prefer fewer cohesive slices over many tiny ones. Every slice's `Draws on:` cites a real `file:line` from Step 1/2.
4. **Resolve ambiguity.** Settle from the research/code wherever you can. When a genuine decomposition fork remains (e.g. "combine auth + session into one slice, or split them?"), use `ask_user_question` with 2–4 concrete options — **one at a time**, wait for the answer.
5. **Confirm the decomposition.** Once, before writing: `ask_user_question` — "{N} slices for {topic}. Slice 1: {name}. Slices 2–N: {brief}. Approve?". Header "Slices". Options: "Approve (Recommended)" (write the map); "Adjust slices" (reorder/merge/split); "Change scope" (add/remove). Apply the answer, then write.
6. **Write the slice map** (below) with `status: ready`.
7. **Print the path**, then a one-line summary: `<N> slices: <comma-separated titles>`.

## Re-slice mode (`--slices` present)

You are re-cutting an existing slice map that **failed the sizing gate**. Unlike a surgical reviser, you have **full structural authority** — split an epic into several slices, merge fragments, renumber, and rewrite `deps`. That structural re-cut is exactly why the sizing loop routes through `slice`: a surgical "touch only the cited line" edit cannot split a slice, so it would loop forever.

1. **Read** the `--slices` map FULLY and every `--slice-verdicts` JSON. Group verdicts by `dimension`; act on those with `pass: false`. Each verdict's `feedback` names the exact re-cut (e.g. *"Re-cut Slice 1B along the chrome-vs-effects seam"*).
2. **Apply the re-cut STRUCTURALLY** — do not just reword the slice:
   - **right-sizing** fail → **split** the named epic along the cited seam into 2+ right-sized slices (an `and`-joined bundle becomes separate slices).
   - **independence** fail → break the cited dependency cycle, or give a shared contract a single owning slice (split / re-assign).
   - **vertical-shape** / **design-readiness** fail → reshape the cited slice per the feedback.
3. **Rebuild the invariants** — renumber `n` contiguously `1..N`, recompute `slice_count`, fix every slice's `deps`, keep exactly one `## Slice N:` heading per entry (the derive-check).
4. **Re-emit** the slice map (same Output shape, `status: ready`). **Non-interactive**: the verdict feedback IS the instruction — no research sweep, no confirm step, no `ask_user_question`.
5. **Print** the path, then `re-sliced: <N> slices (was <M>) — addressed <failing dimensions>`.

## Output document

Path: `.rpiv/artifacts/slices/<slug>_<topic>.md` — `<slug>` is the second field of the metadata block; `<topic>` is a brief kebab-case description.

The frontmatter **must** carry a `slices:` array and `slice_count`, and `slice_count` **must equal both** the array length **and** the number of `## Slice N:` headings in the body (a downstream derive-check rejects any mismatch).

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
slices:
  - { n: 1, title: "<title>", deps: [] }
  - { n: 2, title: "<title>", deps: [1] }
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
- **Scope boundaries, not designs.** No architecture decisions, no file maps, no implementation steps — `design-slice` fills each slice in next.
- **Subagents only for Step 2**, and only when no research artifact was provided; no self-review.
- **Read input before agents; wait for all agents; confirm the decomposition before writing.**
