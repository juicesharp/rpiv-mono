---
name: design-review
description: One consolidated developer checkpoint over EVERY per-slice design a carve fanout produced — present the proposed shape (approach, data types, key interfaces, file map, scope) as a compact cross-slice summary and let the developer accept or adjust via ask_user_question, then surgically apply any adjustment in place (cascading a changed contract to its dependent slices) before synthesis. Single fan-in pass; the accept↔adjust loop lives inside the skill. Dispatched once by the carve workflow between the design fanout and synthesize — not standalone.
argument-hint: "--designs <design-path> [--designs <design-path> ...] --slices <slices-path>"
allowed-tools: Read, Edit, Write, Grep, Glob
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
---

# Design Review

You run **one** developer checkpoint over **all** the per-slice designs a carve `slice-design` fanout produced. You present the proposed design — across every slice — as a compact summary, and let the developer **accept** it or **adjust** a slice. On adjust you apply the change **surgically in place** to the cited design doc and **cascade** a changed contract into the slices that depend on it, then re-present. One fan-in pass; the accept↔adjust loop is internal. You do **not** decompose, re-design from scratch, synthesize, or touch the repo working tree — `synthesize` merges these designs next, and the plan gate grades the merge.

## Input

`$ARGUMENTS` — flags the carve orchestrator wires from the `designs` and `slices` channels. Parse generically:

- **Designs** — every `--designs <path>` flag (repeatable). Each is a per-slice design doc under `.rpiv/artifacts/designs/`. Its frontmatter carries `slice_n`, `slice_title`, and `depends_on`.
- **Slices** — the single `--slices <path>` flag: the slice map under `.rpiv/artifacts/slices/` the designs were cut from (authoritative `deps`, Scope, Out of scope).

If you can't identify at least one `--designs` flag and exactly one `--slices` flag, print an error and stop — it's a dispatch error.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
```

The first tab-separated field is `<iso>` (use as `last_updated` when you edit a design).

## Steps

1. **Read every design doc fully** (no limit/offset) and **read the slice map**. From each design note `slice_n`, `slice_title`, `depends_on`, `## Approach`, `## Key Interfaces`, `## File Map`, `## Success Criteria`. Build the dependency graph from the designs' `depends_on` (cross-checked against the slice map's `deps`): for any slice you can reach its **transitive dependents** (slices that list it, directly or transitively, in `depends_on`).

2. **Present the consolidated design summary** — the whole proposed shape in one view, dependency-ordered. Keep it scannable; the developer reviews the design shape, not every line:

   ```
   Design review — {N} slices, {F} files total

   Slice 1: {title}  (foundation)
     Approach: {1-line architecture decision}
     Key interfaces: {the types/signatures/exports this slice introduces — data types named}
     Files: {k} ({a} new, {b} change) | Criteria: {m}

   Slice 2: {title}  (depends on 1)
     Approach: {1-line}
     Key interfaces: {…, referencing slice-1 contracts it builds on}
     Files: {k} | Criteria: {m}
   ...
   ```

   Lead with the data types and interface surface — that is the contract the developer is signing off on.

3. **Ask the developer to accept or adjust** with the `ask_user_question` tool. Question: "Proposed design across {N} slices ({F} files). Accept, or adjust a slice?". Header: "Design". Options: "Accept (Recommended)" (Proceed to synthesis — merge the per-slice designs into the plan); "Adjust a slice" (Change a slice's approach, interfaces, data types, or scope before synthesis — describe which slice and what). The developer's "Other"/adjust answer names the slice(s) and the change.

4. **On Adjust — apply surgically and cascade, then re-present (loop back to Step 2).** Classify the change:

   - **Contract-local** — touches only the slice's internal approach / file map, NOT a `## Key Interfaces` entry another slice depends on. Edit that one design doc in place; no cascade.
   - **Contract-changing** — touches the slice's `## Key Interfaces` (the published contract its dependents built against). Edit the cited slice's design **top-down**, then for each **transitive dependent** patch every reference to the changed symbol in its `## Key Interfaces` / `## Integration Points` and append a one-line note to its `## Notes / Deferred` (e.g. `upstream slice-1 contract changed: User.id is now UUID`). This keeps the designs mutually consistent so `synthesize` reconciles them with the developer's choice as the authority, not a coin-flip.

   Apply **only** what the developer asked — touch nothing else (the `amend` discipline). Read the cited `file:line` in the repo to ground an interface edit, but never edit repo source. Bump each edited design's `last_updated: <iso>`. Re-present the updated summary (Step 2) and re-ask (Step 3) until the developer accepts.

   **Escape hatch.** If an adjustment is too deep to reconcile by patch — a dependent needs a fundamentally different approach, not a renamed contract — do **not** fake it. Say so plainly and tell the developer this needs a re-slice (carve's `slice-fix` → re-slice → re-design path), then stop; that structural authority lives upstream, not here.

5. **On Accept** — print **every** design doc path you reviewed, each on its own line (edited or not, all N of them — not just the ones you adjusted). The `designs` channel journals what you announce, so a path you omit vanishes from the audit trail and from `synthesize`'s fan-in; every reviewed artifact must be journaled. Then a one-line summary: `design accepted: {N} slices, {adjusted} adjusted`. The carve workflow routes to `subplan`/`synthesize` next.

## Hard rules

- **One consolidated prompt, not one per slice.** You see every design at once and ask once (re-asking only after an adjustment). Per-slice approval is exactly what the design fanout forbids — don't reintroduce it.
- **Surgical, not wholesale.** Apply only what the developer's adjustment cites; leave every other design and every untouched section byte-for-byte. You are a reviser, not a re-designer.
- **Cascade a changed contract.** When an adjustment changes a slice's `## Key Interfaces`, its transitive dependents are stale — reconcile them in place in the same pass, or the developer's choice silently loses the merge.
- **Re-emit in place.** Edit each design at its SAME path so the `designs` channel updates latest-wins for `synthesize`; never fork a new design path.
- **Fix designs, never the repo.** Reading repo source to ground an edit is fine; editing files in the codebase is out of scope — `implement` owns that.
- **No subagents, no decomposition, no synthesis.** Read, present, apply the developer's call, re-emit. `synthesize` merges next; the plan gate grades it.
