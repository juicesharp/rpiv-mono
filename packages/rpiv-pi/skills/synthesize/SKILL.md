---
name: synthesize
description: Merge N independent per-slice designs (plus the research they rest on) into ONE coherent phased plan in .rpiv/artifacts/plans/ — reconciling cross-slice overlaps, wiring inter-slice integration, and ordering phases by slice dependencies. Single-pass, no subagents, no self-review. The fan-in barrier of a fanout-and-synthesize flow — one phase per slice, plan-compatible so implement/validate consume it unchanged. For large slice maps it also runs hierarchically — as a per-cluster partial (`--as-subplan` turns designs into a subplan) and as the root merge (`--subplans` turns subplans into a plan) — so no single pass must hold every design at once. Use after a per-slice design fanout.
argument-hint: "--designs <path>... [--research <path>] [--as-subplan]  |  --subplans <path>... [--research <path>]"
allowed-tools: Read, Grep, Glob, Write
shell-timeout: 10
disable-model-invocation: true
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
        risks:
          type: array
          items:
            type: object
            required: [id, claim]
            properties:
              id: { type: string }
              claim: { type: string }
  consumes:
    reads:
      designs: {}
      subplans: {}
      research: {}
---

# Synthesize

You merge several independent per-slice designs into **one coherent phased plan**. One pass. You do **not** redesign a slice or write code — you reconcile and sequence what the slice designs already decided. This is the **fan-in barrier**: each design was produced blind to the others, so your job is to make them fit together. No subagents, no self-review — the workflow's grade panel judges the merged plan.

## Input

`$ARGUMENTS` — flags (the orchestrator wires them from the fan-in):

- `--designs <path>` **(repeats)** — per-slice design docs from the design fanout.
- `--subplans <path>` **(repeats)** — partial sub-plans from a cluster fanout (root mode).
- `--research <path>` *(optional)* — the research the slices rest on, for cross-slice constraints.
- `--as-subplan` *(flag)* — emit a **sub-plan** (partial mode) instead of a full plan.

If neither `--designs` nor `--subplans` is present, print an error and stop.

## Modes

Pick the mode from the flags — the work is the same fan-in reconciliation at three scales:

| Mode | Selected by | Reads | Writes to | Output kind |
|---|---|---|---|---|
| **Flat** (default) | `--designs` only | every design | `.rpiv/artifacts/plans/` | full plan |
| **Partial** (per-cluster) | `--designs … --as-subplan` | one **cluster**'s designs | `.rpiv/artifacts/subplans/` | sub-plan |
| **Root** (merge) | `--subplans …` | the cluster sub-plans | `.rpiv/artifacts/plans/` | full plan |

Hierarchical synthesis (partial → root) bounds each pass's context: a **partial** sees only its cluster's designs and exports the seams other clusters integrate with; the **root** merges the compact sub-plans (their `summary` + `exports` + phases), never re-reading every design. Flat mode is the single-pass form for small slice maps.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim. `<iso>` is the first tab-separated field; `<slug>` is the second.

## Steps

1. **Read every input fully** — each `--designs` doc (flat/partial) or `--subplans` doc (root), plus `--research` if given.
   - For a **design** note its `slice_n`, `slice_title`, `depends_on`, File Map, Key Interfaces, Integration Points, Success Criteria.
   - For a **sub-plan** note its `summary`, `exports` (the seams it owns), `depends_on` clusters, and its phases.
2. **Reconcile across the inputs** — this is the whole point of the barrier:
   - **Overlap** — when two inputs touch the same file/symbol, merge them into a single coherent change (or split into ordered phases) rather than emitting contradictory edits.
   - **Integration** — wire the seams: an input that depends on another's interface must reference the real shape the other defines. In root mode, this is where each sub-plan's `exports` get connected.
   - **Conflict** — when two inputs make incompatible decisions, resolve to one, and record the resolution in Synthesis Notes (the grade panel's correctness/architecture-fit members will check it).
   - **Risk flags** — a decision you're not confident is correct (an unverified assumption, an edge case wanting a second opinion) goes in the frontmatter `risks:` array as a `{ id, claim }` entry (stable `id`; `claim` = the one-line assertion to rule on) plus a `## Risk Flags` line — **never** buried in prose. This is the first-class channel grade and validate are REQUIRED to rule on; flag anything you'd otherwise write "flagging this so the grade panel can weigh in" about.
3. **Sequence phases** — one phase per slice (flat/partial) or carry the sub-plans' phases through (root), ordered so a phase never precedes one it `depends_on`. Tightly-coupled units may merge into one phase; note any merge.
4. **Write the output** (below), `status: ready`:
   - **Flat / root** → a standard **plan** in `.rpiv/artifacts/plans/` — phases with concrete changes and Success Criteria that pass through unchanged to `implement`/`validate`.
   - **Partial** (`--as-subplan`) → a **sub-plan** in `.rpiv/artifacts/subplans/` — the same phase shape PLUS a `summary` and an `exports` block naming the seams (files/symbols/interfaces this cluster owns) the root will wire other clusters into. Keep it compact: the root reads it instead of your cluster's designs.
5. **Print the path**, then a one-line summary: `<N> phases from <M> {slices|sub-plans}` (note the mode).

This skill is **non-interactive**: when a conflict can't be cleanly resolved, make the most defensible call, record it in Synthesis Notes, and let the grade panel catch a bad merge. Do not ask the user.

## Output document

**Flat / root mode** → Path: `.rpiv/artifacts/plans/<slug>_<topic>.md`.
**Partial mode** (`--as-subplan`) → Path: `.rpiv/artifacts/subplans/<slug>_cluster-<k>.md`, with the same body shape plus a `summary:` scalar and an `exports:` list in frontmatter, e.g.:

```yaml
summary: "<one-paragraph what this cluster delivers>"
exports:
  - "src/foo.ts:Foo — the interface other clusters call"
depends_on_clusters: []
```

The frontmatter **must** carry a `phases:` array and `phase_count` equal to **both** the array length **and** the number of `## Phase N:` headings in the body (a downstream derive-check rejects a mismatch) — for sub-plans too.

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
risks:
  - { id: r1, claim: "<a decision you want the grade panel + validate to rule on>" }
sources: [<each --designs path>, <--research path>]
tags: [plan, synthesized]
---

# Plan: <topic>

## Synthesis Notes
- <cross-slice overlaps merged, conflicts resolved, integration seams wired — with file refs>

## Risk Flags
<!-- One entry per `risks:` frontmatter id. Omit the section AND the frontmatter array when there are genuinely no risks. -->
- **r1** — <the claim, and what a reviewer should verify to rule it pass or fail>

## Phase 1: <title>
### Changes
- `path/to/file.ts` — <what to do>
  <!-- Every `file:line` uses the repo-root-relative path, never a subdirectory-relative form or a bare basename: the deterministic `plan-cite-check`/`code-cite-check` floor verifies each citation, and an ambiguous or unresolvable path fails the gate and forces a plan-fix loop. -->

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
