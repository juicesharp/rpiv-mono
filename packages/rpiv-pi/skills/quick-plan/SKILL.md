---
name: quick-plan
description: "Produce a single unsliced, consistently-phased implementation plan for a small, well-understood task and write it directly to .rpiv/artifacts/plans/ with status: ready — one non-interactive pass, no slice decomposition, no in-skill review (the workflow's grade and validate stages are the gates). Dispatched by the ship preset's plan stage; also usable standalone for a small task whose research is done or whose shape is obvious. Prefer blueprint for multi-component features needing slice-by-slice micro-checkpoints, and plan when turning an existing design artifact into phases."
argument-hint: "[research artifact path or feature description]"
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
          enum: [ready]
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
    meta:
      artifactKind: [research]
---

# Quick Plan

You produce a **single, unsliced, consistently-phased** implementation plan for a small, well-understood task and write it directly to `.rpiv/artifacts/plans/` with `status: ready`. One non-interactive pass — no slice decomposition, no skeleton-then-fill, no in-skill review. The workflow's `grade` and `validate` stages (or your own review, standalone) are the gates; this skill only emits the artifact those gates parse.

The expected shape is **one phase** (the small-task default). Add a phase only when the task genuinely splits into independently-verifiable units that share no file. This is the trimmed mimic of `blueprint`'s artifact shape minus every step that exists to produce _confidence in_ the artifact.

## Input

`$ARGUMENTS` — one of four shapes (the skill is sound however the caller wires it):

- **Flags (workflow dispatch)** — `--research <path> --goal <path>`. Read BOTH files FULLY (no limit/offset). The research doc is the grounding; the goal file is the verbatim brief — every ask it names is either implemented by a phase or deferred under `## Out of Scope`.
- **Research artifact path** — a `.md` path under `.rpiv/artifacts/research/`. Read it FULLY (no limit/offset); it is the grounding for the plan.
- **Injected research** — when dispatched by a workflow `reads: ["research"]` stage, the research doc is already in context; treat `$ARGUMENTS` as the task description / goal.
- **Free-text** (standalone small task) — `$ARGUMENTS` is the task description; research is done or the shape is obvious.

If `$ARGUMENTS` is empty AND no research doc is in context, print an error and stop — there is nothing to plan from.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim. `<iso>` is the first tab-separated field (use as `date:`); `<slug>` is the second.

## Flow

1. Input → 2. Optional single targeted research → 3. Write plan (`status: ready`)

## Steps

### Step 1: Read the input

- If a research artifact path was given, read it FULLY. Extract the task, the Code References (`file:line`), the Integration Points, and any Open Questions already resolved.
- If a `--goal` file was given, read it FULLY and enumerate every ask it names; each is either implemented by a phase or deferred under `## Out of Scope` with a reason (when the research narrowed the brief, its rationale is the deferral reason).
- Read the key source files the research points at — the anchors the plan will cite — so the phase's code blocks and `file:line` references are real and current.
- Determine the goal (the `--goal` brief, the task description, or the research's stated goal).

### Step 2: Optional single targeted research (at most ONE dispatch)

You may dispatch **at most one** `codebase-pattern-finder` agent to find the implementation pattern to model the code after — only if the research did not already surface one. **Never parallel, never `run_in_background`**: a background completion cannot re-drive this session, so the skill would end its turn before writing the plan and the stage would fail with no artifact.

Spawn the agent using the Agent tool:

- subagent_type: `codebase-pattern-finder`
- Prompt: "Find the implementation pattern I should model after for {task}. Single pass."

If the research already gave you the pattern (Code References + Integration Points), **skip this step entirely** — most small, well-understood tasks need no dispatch.

### Step 3: Write the plan (`status: ready`)

Write the plan **in one pass** to `.rpiv/artifacts/plans/<slug>_<description>.md` (`<slug>` from the Metadata block; `<description>` is a brief kebab-case summary). Set frontmatter `status: ready` directly — there is no `in-progress`/`in-review` transition. **Do not author a `risks:` frontmatter array** (see Important Notes).

The artifact MUST be **consistently phased**: frontmatter `phases:` array length == number of `## Phase N:` headings == scalar `phase_count`. Any drift and `planPhaseRecords` halts the workflow at plan time. Single phase is the default.

Use this template (single-phase shown; replicate the `## Phase N:` block per phase only when genuinely multi-phase):

```markdown
---
date: {<iso> from Metadata block}
author: {`author:` from Metadata block}
commit: {Current commit hash}
branch: {Current branch name}
repository: {`repo:` from Metadata block}
topic: "{task name}"
tags: [plan]
status: ready
phase_count: 1
phases:
  - { n: 1, title: {Phase 1 title}, files: [{every repo-root-relative path Phase 1 creates/edits}], depends_on: [] }
last_updated: {same <iso> as date:}
---

# {Task Name} Implementation Plan

## Overview

{1-3 sentences: what this plan implements and why.}

## Out of Scope

{One line per goal ask this plan does not implement — "- {ask} — deferred: {reason}". Omit the section when every named ask is covered.}

## Phase 1: {Descriptive Title}

### Overview
{One sentence: what this phase delivers.}

### Changes Required:

#### 1. {repo-root-relative/path/to/file.ext}
**File**: `repo-root-relative/path/to/file.ext`
**Changes**: {NEW | MODIFY} — {one-line summary}

```{language}
// Copy-pasteable code — the full function/section to add, or the exact edit,
// grounded in the current tree. implement applies this without guessing.
```

### Success Criteria:

#### Automated Verification:
- [ ] {One self-contained command that exits 0 when the criterion holds, write-scoped to THIS phase's `files:` set — e.g. `npm run check:files -- <this phase's paths>`}
- [ ] {Read-only whole-tree check — e.g. `npx tsc --noEmit -p tsconfig.base.json`}
- [ ] {Phase-scoped test — e.g. `npx vitest run <this phase's test path>`}

#### Manual Verification:
- [ ] {Human check — UI, real-conditions behavior, edge case}
```

Populate each `phases[].files:` from that phase's `#### N.` / `**File**:` paths — every repo-root-relative path the phase creates or edits — or the plan-time coverage floor (`planCitationCheck`) flags a gap. Make every `#### Automated Verification:` command write-scoped to its own phase's `files:` set; phases may run concurrently under implement, so an unscoped command that rewrites the wider tree corrupts a sibling phase's edit.

Populate `## Out of Scope` from the Step 1 goal-ask enumeration: one one-line deferral with a reason per goal ask no phase implements.

Then print the path and a one-line summary: `quick-plan written: {N} phase(s), {M} files`.

## Important Notes

- **Consistently phased, always.** `phases:` length == `## Phase N:` heading count == scalar `phase_count`. A half-phased plan throws at plan time. Single phase is the small-task default — only split when units are independently verifiable and share no file.
- **No `risks:` frontmatter — this is the correctness lightening.** The `grade` skill's `correctness` risk-flag adjudication (the heaviest correctness sub-check, with its mechanics-evidence and verify-at-implement duties) fires **only** when the artifact carries `risks:`. With none declared, `risk_rulings` is omitted and adjudication auto-skips — the grade runs the cheap spot-check path. Do NOT invent a `"correctness-simplified"` dimension (grade does not recognize it and would deadlock the gate); the lightening is realized by the plan's shape, not by a new dimension.
- **One Write, `status: ready` directly.** No skeleton-then-fill, no progressive `Edit`, no 3-state status machine. The artifact is gated externally (the workflow's `grade` + `validate`, or your own review standalone).
- **At most ONE `codebase-pattern-finder` dispatch.** Never parallel, never `run_in_background` — a background completion cannot re-drive this session and the stage fails with no artifact. Skip the dispatch when research already surfaced the pattern.
- **Non-interactive.** No `ask_user_question` checkpoint. A checkpoint without blueprint's dimension sweep is pure latency on a fast-path preset whose output is immediately grade-gated. Resolve ambiguity from the research and the real code; if a genuine fork can't be settled, make the most defensible call and let the grade panel catch it.
- **Defer explicitly, never silently.** Every goal ask no phase implements gets a one-line `## Out of Scope` deferral with a reason — the completeness gate blocks on a named ask that is neither addressed nor deferred.
- **Ground every citation.** Every `file:line` in prose or code comments uses a repo-root-relative path and is verifiable at the current revision — the plan passes the deterministic `plan-cite-check` floor.
- **NEVER edit source files.** This skill produces a plan document, not implementation. Source editing is `implement`'s job.
- **Drops blueprint's ceremony by design:** multi-slice decomposition, skeleton-then-fill, the per-slice `slice-verifier` loop, the dual post-finalization review (`artifact-code-reviewer` + `artifact-coverage-reviewer`), the 6-dimension sweep, and parallel research are all absent here — the workflow's own gates own that confidence.
