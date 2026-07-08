---
name: design-slice
description: Design ONE vertical slice from a slice map in isolation — its architecture decisions, file map, key interfaces, integration points, and success criteria — and write a per-slice design doc to .rpiv/artifacts/designs/. Single-pass, no research subagents, no self-review; asks the user only when a genuine design fork blocks the slice. Dispatched once per slice by a design fanout; the per-slice designs are later merged by synthesize. Use as a fanout unit, not standalone.
argument-hint: "<slices-path> Slice N: <title> [--upstream <design-path>]..."
allowed-tools: Read, Grep, Glob, Write
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: design
    data:
      type: object
      properties:
        status:
          enum: [in-progress, in-review, ready]
  consumes:
    meta:
      artifactKind: [slices, design]
---

# Design Slice

You design **one** vertical slice from a slice map, in isolation, and write its design doc. One pass. You do **not** decompose (the slice is already cut), implement, or self-review — the workflow's grade panel judges your output. You **may** ask the user only when a genuine design fork blocks this slice.

## Input

`$ARGUMENTS` — `<slices-path> Slice N: <title>`:

- The first token is the path to a slice map under `.rpiv/artifacts/slices/`.
- The remainder (`Slice N: <title>`) names the **single** slice to design. Parse `N` from `Slice (\d+)`.
- `--upstream <path>` *(repeats, optional)* — a direct dependency's per-slice design doc,
  injected by the design fanout once that dependency completes. Read each one's
  `## Key Interfaces` (the decided contract this slice builds on) and `## Notes / Deferred`
  (to detect an undecided fork). Absent ⇒ this slice is a root (no upstream dependency).

Design **only** that slice. Respect its `Out of scope` — anything there belongs to another slice's design.

If the slices path is missing or `Slice N` can't be parsed, print an error and stop — it's a dispatch error.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim. `<iso>` is the first tab-separated field; `<slug>` is the second.

## Steps

1. **Read the slice map fully** and locate the `## Slice N:` section — its Scope, Draws on, Depends on, Out of scope.
2. **Read the slice's footing**: the `Draws on` references (research sections + the source `file:line`s it rests on). Read those files fully. This is **targeted** — read what the slice names, do **not** run discovery/analysis subagents.
3. **Read each `--upstream` dependency design** (if any were passed): from each, read its `## Key Interfaces` (the decided contract this slice depends on — build against it, do **not** redesign it) and its `## Notes / Deferred`. If a contract this slice **depends on** is still an undecided fork there (the dependency parked options rather than deciding), escalate — see Step 5. Read **only** the direct upstreams you were handed; do not chase their transitive dependencies (synthesize reconciles the rest).
4. **Design this slice** — decide its shape and record:
   - **Approach** — the architecture decision(s) for this slice and why.
   - **File map** — each file to add/change and what changes (`path — add|change — what`).
   - **Key interfaces** — the types/signatures/exports the slice introduces or touches.
   - **Integration points** — where this slice wires into existing code (and into sibling slices it depends on, by file/symbol — referencing the real shapes from the upstream `## Key Interfaces`).
   - **Success criteria** — concrete `- [ ]` checks that prove the slice works.
5. **Resolve ambiguity:** decide from the slice map, the upstream designs, research, and code wherever you can. Use `ask_user_question` (2–4 concrete options, one at a time) ONLY when you can't settle it from those inputs — either a genuine design fork within this slice, **or** a contract this slice depends on is still an undecided fork in an upstream's `## Notes / Deferred`. Do **not** ask the user to approve the finished design — the grade panel owns that.
6. **Write the design doc** (below), `status: ready`.
7. **Print the path**, then a one-line summary: `Slice N design: <k> files, <m> success criteria`.

## Output document

Path: `.rpiv/artifacts/designs/<slug>_slice-<N>_<topic>.md` (`<topic>` = kebab-case of the slice title).

```markdown
---
date: <iso>
author: <author>
repository: <repo>
branch: <branch>
commit: <commit>
topic: "<slice title>"
source: <slices-path>
slice_n: <N>
slice_title: "<title>"
depends_on: [<slice numbers this slice depends on>]
status: ready
tags: [design, slice]
---

# Design — Slice <N>: <title>

## Approach
<the architecture decision(s) for this slice, grounded in file:line>

## File Map
- `path/to/file.ts` — add|change — <what and why>

## Key Interfaces
<signatures / types / exports — code shape, not full implementation>

## Integration Points
- `path:line` — <how this slice wires in; name sibling slices it couples to>
  <!-- `path` is the repo-root-relative path (`packages/.../foo.ts:42`), never a subdirectory-relative form or a bare basename: the plan's deterministic cite-check floor verifies it, and an ambiguous or unresolvable path fails. -->

## Success Criteria
- [ ] <concrete, checkable>

## Notes / Deferred
<assumptions made in lieu of a blocker question; anything pushed to another slice>
```

## Hard rules

- **One slice only.** Never design or touch work that the slice map assigns to a different slice.
- **Code shape, not implementation.** Interfaces, file map, decisions — `implement` writes the actual code later.
- **No discovery/analysis subagents. No self-review.** Read the files the slice names; decide; write. Ask only to clear a genuine blocking fork.
- **Build against decided upstream contracts.** When `--upstream` designs are provided, consume their `## Key Interfaces` as fixed — never redesign a dependency's contract. If a contract you depend on is undecided (parked in the upstream's `## Notes / Deferred`), escalate (Step 5), don't guess.
