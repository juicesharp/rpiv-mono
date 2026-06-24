---
name: slice
description: Decompose a research artifact (or a free-text brief) into independent vertical slices — each a self-contained, separately-designable unit — and write a slice map to .rpiv/artifacts/slices/ with a machine-readable `slices:` frontmatter array. Runs a lightweight codebase research sweep when no research artifact is provided, then confirms the decomposition with you before writing. Feeds a per-slice design fanout. Use to break a feature into parallelizable slices before designing.
argument-hint: "[research-path | free-text brief]"
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
    meta:
      artifactKind: [research]
---

# Slice

You decompose a feature into **independent vertical slices** and write a slice map. You do **not** design, plan phases, write implementation steps, or self-review — `design-slice` fills each slice in next. When no research artifact is provided, you ground the cut with a quick codebase sweep first; you confirm the decomposition with the developer before writing.

## Input

`$ARGUMENTS` — a path to a `.rpiv/artifacts/research/*.md` artifact, or a free-text brief. If empty, ask the user for it and wait.

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
- **Right-sized** — roughly one focused design pass each. Aim for **2–8**; hard cap **32**.
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
