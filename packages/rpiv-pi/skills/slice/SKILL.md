---
name: slice
description: Decompose a research artifact (or a free-text brief) into independent vertical slices — each a self-contained, separately-designable unit — and write a slice map to .rpiv/artifacts/slices/ with a machine-readable `slices:` frontmatter array. Single-pass, no inner review; asks the user only when a decomposition choice is genuinely ambiguous. Feeds a per-slice design fanout. Use to break a feature into parallelizable slices before designing.
argument-hint: "[research-path | free-text brief]"
allowed-tools: Read, Grep, Glob, Write
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

You decompose a feature into **independent vertical slices** and write a slice map. One pass. You do **not** design, plan phases, write implementation steps, or self-review — the workflow's grade panel judges your output. You **may** ask the user when a slicing decision is genuinely ambiguous.

## Input

`$ARGUMENTS` — a path to a `.rpiv/artifacts/research/*.md` artifact, or a free-text brief. If empty, ask the user for it and wait.

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
- **Right-sized** — roughly one focused design pass each. Aim for **2–8**; hard cap **32**.
- **Honest about dependencies** — when slice B genuinely needs slice A first, record it in `deps`. Keep real deps rare; if everything depends on everything, the cut is wrong.

## Steps

1. **Read the research/brief fully** (no limit/offset).
2. **Identify the capabilities** the work delivers, then group them into independent vertical slices. Prefer fewer cohesive slices over many tiny ones.
3. **Resolve ambiguity:**
   - Settle it from the research wherever you can.
   - When a genuine decomposition fork remains (e.g. "combine auth + session into one slice, or split them?") **and it cannot be settled from the research**, use `ask_user_question` with 2–4 concrete options. **One question at a time**, wait for the answer. This is your **only** interactive surface.
   - Do **not** ask the user to confirm or approve your finished slice map — that is the grade panel's job, not a checkpoint.
4. **Write the slice map** (below) with `status: ready`.
5. **Print the path**, then a one-line summary: `<N> slices: <comma-separated titles>`.

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
- **No subagents. No self-review.** Ask only to resolve a genuine slicing fork; otherwise decide and write.
