---
name: synthesize
description: Merge N independent per-slice designs (plus the research they rest on) into ONE coherent phased plan in .rpiv/artifacts/plans/ — reconciling cross-slice overlaps, wiring inter-slice integration, and ordering phases by slice dependencies. Single-pass, no subagents, no self-review. The fan-in barrier of a fanout-and-synthesize flow — one phase per slice, plan-compatible so implement/validate consume it unchanged. Use after a per-slice design fanout.
argument-hint: "--designs <path> [--designs <path> ...] [--research <path>]"
allowed-tools: Read, Grep, Glob, Write
shell-timeout: 10
contract:
  produces:
    kind: produces
    meta:
      artifactKind: plan
    data:
      type: object
      required: [phases, phase_count]
      properties:
        status:
          enum: [in-progress, in-review, ready]
        phase_count:
          type: integer
          minimum: 1
          maximum: 32
        phases:
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
    reads:
      designs: {}
      research: {}
---

# Synthesize

You merge several independent per-slice designs into **one coherent phased plan**. One pass. You do **not** redesign a slice or write code — you reconcile and sequence what the slice designs already decided. This is the **fan-in barrier**: each design was produced blind to the others, so your job is to make them fit together. No subagents, no self-review — the workflow's grade panel judges the merged plan.

## Input

`$ARGUMENTS` — flags (the orchestrator wires them from the fan-in):

- `--designs <path>` **(repeats, ≥1)** — every per-slice design doc from the design fanout.
- `--research <path>` *(optional)* — the research the slices rest on, for cross-slice constraints.

Recognize the repeated `--designs` flags and the single `--research`. If no `--designs` are present, print an error and stop.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim. `<iso>` is the first tab-separated field; `<slug>` is the second.

## Steps

1. **Read every `--designs` doc fully** (and `--research` if given). For each design note its `slice_n`, `slice_title`, `depends_on`, File Map, Key Interfaces, Integration Points, Success Criteria.
2. **Reconcile across slices** — this is the whole point of the barrier:
   - **Overlap** — when two slices touch the same file/symbol, merge them into a single coherent change (or split into ordered phases) rather than emitting contradictory edits.
   - **Integration** — wire the inter-slice seams: a slice that depends on another's interface must reference the real shape the other slice defines.
   - **Conflict** — when two designs make incompatible decisions, resolve to one, and record the resolution in Synthesis Notes (the grade panel's correctness/architecture-fit members will check it).
3. **Sequence phases** — one phase per slice, ordered so a phase never precedes a slice it `depends_on`. Tightly-coupled slices may merge into one phase; note any merge.
4. **Write the plan** (below), `status: ready`. It is a standard plan artifact — phases with concrete changes and Success Criteria that pass through unchanged to `implement`/`validate`.
5. **Print the path**, then a one-line summary: `<N> phases from <M> slices`.

This skill is **non-interactive**: when an inter-slice conflict can't be cleanly resolved, make the most defensible call, record it in Synthesis Notes, and let the grade panel catch a bad merge. Do not ask the user.

## Output document

Path: `.rpiv/artifacts/plans/<slug>_<topic>.md`. The frontmatter **must** carry a `phases:` array and `phase_count` equal to **both** the array length **and** the number of `## Phase N:` headings in the body (a downstream derive-check rejects a mismatch).

```markdown
---
date: <iso>
author: <author>
repository: <repo>
branch: <branch>
commit: <commit>
topic: "<topic>"
status: ready
phase_count: <N>
phases:
  - { n: 1, title: "<title>", slice: 1 }
  - { n: 2, title: "<title>", slice: 2 }
sources: [<each --designs path>, <--research path>]
tags: [plan, synthesized]
---

# Plan: <topic>

## Synthesis Notes
- <cross-slice overlaps merged, conflicts resolved, integration seams wired — with file refs>

## Phase 1: <title>
### Changes
- `path/to/file.ts` — <what to do>
### Success Criteria
#### Automated Verification:
- [ ] <command / assertion>
#### Manual Verification:
- [ ] <check>

## Phase 2: <title>
...
```

## Hard rules

- Exactly one `## Phase N:` heading per `phases:` entry; `phase_count` == array length == heading count. Number `n` contiguously `1..N`.
- **Reconcile, don't redesign.** Preserve each slice's decisions; only resolve where slices collide or must connect.
- **Plan-compatible output.** Phases + Success Criteria in the standard plan shape so `implement` and `validate` consume it with no changes.
- **No subagents. No self-review. No questions.** Merge, record open risks in Synthesis Notes, write.
