---
name: acceptance
description: "Derive an executable acceptance inventory from the verbatim goal — the ID'd observable outcomes the finished work must exhibit, each with a runnable evidence command where one can be derived — and write it to .rpiv/artifacts/acceptance/ in one non-interactive pass. Authored BEFORE any plan exists so the standard of completion cannot inherit the plan's scope: the plan later addresses or explicitly defers each item, the grade panel's completeness dimension anchors on the inventory, and validate executes the evidence commands against the finished tree. Dispatched by the ship and build presets between research and planning."
argument-hint: "--goal <path> [--research <path>]"
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: acceptance
    data:
      type: object
      required: [items, item_count]
      properties:
        status:
          enum: [ready]
        item_count:
          type: integer
          minimum: 1
          maximum: 24
        items:
          type: array
          minItems: 1
          maxItems: 24
          items:
            type: object
            required: [id, statement]
            properties:
              id: { type: string }
              statement: { type: string }
              command: { type: string }
              expect: { type: string }
              manual: { type: string }
  consumes:
    meta:
      artifactKind: [research]
---

# Acceptance

You derive an **acceptance inventory** from the verbatim goal: the distinct observable outcomes the finished work must exhibit, each with a short stable id (`a1`, `a2`, …) and — wherever one can be derived — a **runnable evidence command** that will exit 0 once the outcome holds. One non-interactive pass, one Write. You do **not** plan, design, or judge feasibility — the inventory is the measure the later stages answer to, not a plan of how to get there.

The inventory exists to keep the standard of completion independent of the work: it is authored before any plan, from the goal alone, so a plan that silently narrows the brief is caught against enumerated items instead of prose re-reading. Downstream: the planner addresses or explicitly defers each item, the grade panel's completeness dimension receives the inventory as `--acceptance`, and validate runs the evidence commands against the finished tree — a failed item with a runnable command becomes a structured, remediable blocker.

## Input

`$ARGUMENTS` — flags (order-independent):

- `--goal <path>` (**required**) — the verbatim brief. Read it FULLY (no limit/offset). Missing/empty ⇒ print an error and stop — a dispatch error (the workflow runs `goal` before `acceptance`).
- `--research <path>` (optional) — the grounding doc. Read it FULLY. Research grounds only the **evidence procedures** (which command, which test path, which grep target); it NEVER adds, drops, or narrows items — the item set derives from the goal alone.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim. `<iso>` is the first tab-separated field (use as `date:`); `<slug>` is the second.

## What an item is

An acceptance item is one **observable outcome** the goal asks for — behavior a reader could check on the finished tree, not an implementation step. Good items are:

- **Goal-traceable** — the `statement` restates one explicit ask (or explicit constraint) from the goal in one line; quote or closely paraphrase the goal's own words. Never invent scope the goal doesn't name (the graders' anti-scope-inflation rule applies here first).
- **Observable** — phrased as a checkable end state ("`/wf ship` halts at the grade gate with a route note"), never as activity ("implement the gate").
- **Singular** — one outcome per item; a goal sentence naming two outcomes yields two items.
- **Right-sized set** — typically 3–12 items; every explicit ask is covered, and nothing is padded. A one-line goal may legitimately yield a single item. The schema's hard ceiling is 24 — deliberately tighter than the plan/slice family's 32, because an inventory that large is re-litigating scope, not enumerating a brief; a goal genuinely that broad belongs in `build`'s slice decomposition, with each slice's asks staying items here only at the observable-outcome grain.

Evidence, per item — exactly one of:

- `command` + `expect` — a **read-only, self-contained, repo-root-relative** command expected to exit 0 once the outcome holds (a test invocation, a grep invariant, a `tsc --noEmit`, a file-existence check), with `expect` naming the observable in one line. Ground it in the research/tree so paths and script names are real. It is **future-tense**: it may (and usually will) fail on today's tree — validate runs it after implement.
- `manual` — a one-line human procedure, ONLY when no read-only command can measure the outcome (visual appearance, real-terminal behavior). Prefer a command whenever one exists; a `manual` item is homework validate can record but not discharge.

## Flow

1. Read goal (+research) → 2. Enumerate items → 3. Attach evidence → 4. Write (`status: ready`)

## Steps

1. **Read.** The goal FULLY — it is the sole source of items. The research doc FULLY when given — it is the sole *grounding* for evidence commands (test layouts, script names, conventions). Spot-check any path a command will cite against the real tree.
2. **Enumerate.** Walk the goal sentence by sentence and extract every explicit ask and explicit constraint as an item (`a1`, `a2`, … in goal order). Ambiguity is resolved toward the goal's own words — restate, don't interpret. Do NOT consult the research for what belongs in the set: a research doc that narrowed the brief must not narrow the inventory.
3. **Attach evidence.** For each item, derive the strongest read-only command the tree supports and one `expect` line; fall back to `manual` only when nothing runnable can measure it. Never write a command that mutates the tree, reaches the network, or depends on state outside the repo.
4. **Write** the inventory in one pass to `.rpiv/artifacts/acceptance/<slug>_<description>.md` (`<description>` a brief kebab-case task summary), `status: ready` directly. Then print the path and `acceptance written: {N} item(s), {M} executable`.

Use this template:

```markdown
---
date: {<iso> from Metadata block}
topic: "{task name}"
tags: [acceptance]
status: ready
item_count: {N}
items:
  - { id: a1, statement: "{one-line observable outcome}", command: "{read-only command}", expect: "{what exit 0 shows}" }
  - { id: a2, statement: "{one-line observable outcome}", manual: "{one-line human procedure}" }
---

# Acceptance Inventory: {Task Name}

Derived from the verbatim goal ({goal path}). Items enumerate the goal's explicit asks; evidence commands are future-tense — run by validate against the finished tree.

## Items

### a1: {statement}
**Evidence**: `{command}` — {expect}

### a2: {statement}
**Evidence (manual)**: {procedure}
```

## Important Notes

- **Consistently counted, always.** `item_count` == `items:` array length == the number of `### aN:` sections — the `phase_count`/`slice_count` discipline, applied here. Ids run `a1…aN` with no gaps or duplicates.
- **Items from the goal ALONE.** Research grounds evidence, never membership — the whole point of this stage is a standard the later narrowing cannot rewrite. If the goal names an ask the research argues against, the item still exists; the PLAN defers it legibly.
- **The inventory is frozen.** No downstream stage re-emits on the acceptance channel; deferral happens in the plan (visibly, per item id), never by editing this artifact.
- **Read-only, self-contained commands.** Validate runs them as written after implement — a command that mutates the tree or depends on external state corrupts the very measurement it exists to make.
- **Future-tense evidence.** Do not run the commands here and do not weaken one because it fails today — failing today is the expected state of a check on unbuilt work.
- **Non-interactive.** No `ask_user_question`, no subagents. Resolve ambiguity toward the goal's own words; the grade panel adjudicates a genuinely contestable reading.
- **NEVER edit source files.** This skill produces an inventory document only.
