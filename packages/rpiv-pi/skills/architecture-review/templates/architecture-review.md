---
template_version: 1
date: {Current date and time with timezone in ISO format}
author: {`author:` from injected git context}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
target: {repo-relative target path — a bare path; if you must add prose or span multiple paths, WRAP THE WHOLE VALUE IN DOUBLE QUOTES so an embedded `:` doesn't break YAML}
target_kind: {module | directory | file}
layer_count: {N}
unresolved_finding_count: {U}    # increments on file, decrements on triage; should be 0 before Step 6
status: {in-progress | ready}
tags: [architecture-review, {target-name}, {relevant components}]
last_updated: {Same ISO timestamp as date: above; bumped on follow-ups}
last_updated_by: {`author:` from Metadata block}
last_updated_note: "{Optional one-line note on follow-ups}"
---

# Architecture review — {target name}

{One-paragraph context: what's being reviewed, the trigger (pre-1.0 release / post-major-refactor / standalone audit), the scope. 2–4 sentences.}

---

## Conventions

### Finding shape

Each finding is a level-3 heading `### L<layer>-<seq> — <title>` followed by the fields below.

| Field | Meaning |
|---|---|
| **Evidence** | `file.ext:lineA-lineB` (+ short quote when useful) |
| **Current state** | what the code does today |
| **Desired state** | what we want it to look like |
| **Proposed improvement** | concrete action (rename, extract, merge, split, delete) |
| **Severity** | Low / Med / High — how wrong this is today |
| **Effort** | S / M / L — bounded changes ship cheaply |
| **Blast radius** | `internal` / `public-API` / `on-disk` / `cross-module` |
| **Class** | `polish` (rename / refactor / DRY) vs `redesign` (structural shift) |
| **Status** | `open` / `accepted` / `rejected` / `deferred` / `withdrawn` |
| **Depends on** | other finding IDs that must land first |
| **Cross-cut tag** | optional — see "Cross-cutting themes" |

### Status legend

- `open` — flagged, not yet triaged
- `accepted` — will land; includes the chosen option summary
- `rejected` — declined with reason inline
- `deferred` — accepted in principle but punted post-release
- `withdrawn` — initial diagnosis turned out incorrect; kept for audit

### Layers (top → down)

{Insert the layer table from Step 3. Large layers: file count + representative names. Sub-layers: dot-numbered rows after the parent.}

| # | Layer | Files |
|---|---|---|
| 0 | {layer name} | `file1.ext`, `file2.ext` |
| 1 | {layer name} | `file3.ext` |
| 3 | Data Access | 80 — `DbContext.cs`, `*Repository.cs`, `*Configuration.cs`, ... |
| 3.1 | DbContext + migrations | `DbContext.cs`, `Migrations/*` |
| 3.2 | Entities | `Domain/*Entity.cs` |
| 3.3 | Repositories | `Infrastructure/*Repository.cs` |

---

## Methodology principles

_Principles emerge during Step 5 triage and are captured at Step 6. Patterns that govern multiple decisions get named here; one block per principle._

{When Step 6 captures principles, append blocks in this shape:}

<!--
### M{N} — {principle name}

**Origin:** {finding ID where it first surfaced + one-sentence quote from the developer's reasoning, if available}.

**Rule.** {One paragraph: what to do, why, when to apply.}

**Apply to (keep):** {bullet list of cases the principle says to preserve.}
**Apply to (drop / change):** {bullet list of cases the principle says to act on.}
-->

---

## Layer 0 — {layer name}

{Files: `file1.ext`, `file2.ext`, ...}

{Optional preamble: 1–2 paragraphs on what the layer owns + any ripple-ins from prior decisions in the same review.}

### L0-01 — {short headline}

**Evidence**

`file.ext:lineA-lineB`

```
{short quote when useful}
```

**Current state**

{What the code does today.}

**Desired state**

{What we want it to look like.}

**Proposed improvement**

{Concrete action — rename, extract, merge, split, delete.}

- **Severity:** {Low | Med | High}
- **Effort:** {S | M | L}
- **Blast radius:** {internal | public-API | on-disk | cross-module}
- **Class:** {polish | redesign}
- **Status:** {open → triaged outcome inline, e.g., **accepted** — {chosen option summary}}
- **Depends on:** {LX-YY, ...}
- **Cross-cut tag:** `T{N}-{theme-name}` _(optional)_

{Repeat for L0-02, L0-03, ...}

### Layer 0 — tally

| Status | Count |
|---|---|
| accepted | {A} |
| rejected | {R} |
| deferred | {D} |
| withdrawn | {W} |

Cross-cutting tags introduced: {list}.
Cross-cutting tags reused: {list}.

Dependency edges within Layer 0:

- L0-XX depends on L0-YY (...)

---

## Layer 1 — {layer name}

{Same structure as Layer 0.}

{... repeat per layer ...}

---

## Cross-cutting themes

Cross-cut threads surfaced during layer-by-layer review. Each thread ties multiple findings together; the polishing plan groups by theme where possible to minimise merge conflicts and review burden.

### T1 — {theme name} ({active | closed by L{X}-{YY}})

**Findings:** L{X}-{YY}, L{Z}-{WW}, ...

{One paragraph: what unifies these findings, what the theme thread delivers when implemented, what the closing finding is (if any).}

{Repeat per theme.}

---

## Consolidated polish plan

{N} phases, ordered top-to-bottom. Each phase is blueprint-consumable; sizing is by agent-relevant signals (file count, finding count, blast-radius mix, coordination need) — never human-days.

### Phase 1 — {phase name}

**Goal:** {one-line goal — what this phase delivers when complete}.

**Findings ({count}):** L{X}-{YY}, L{Z}-{WW}, ...

**Files touched ({count}):** `path/one.ext`, `path/two.ext`, ...

**Blast-radius mix:** {internal: N; public-API: N; on-disk: N; cross-module: N}.

**Class mix:** {polish: N; redesign: N}.

**Coordination:** {none | sibling-package PR required | downstream consumer release required}.

**Risk callouts:** {phase-specific risk, especially when the phase touches on-disk format, public-API shape, or requires cross-module coordination}.

{Repeat per phase.}

### Dependency graph (phase-level)

```
Phase 1 ({name})
   ↓
Phase 2 ({name})
   ↓
   ├──► Phase 3 ({name}) ──┐
   ├──► Phase 4 ({name}) ──┤
   └──► Phase 5 ({name})   │
                           ↓
                Phase 6 ({name})
                           ↓
                Phase 7 ({name})
```

### Phase scope summary

| Phase | Findings | Files | Blast-radius mix | Coordination |
|---|---|---|---|---|
| 1 — {name} | {N} | {N} | {breakdown} | {none / sibling / downstream} |
| 2 — {name} | {N} | {N} | {breakdown} | {...} |
| ... | ... | ... | ... | ... |
| **Total** | **{N}** | **{N}** | — | — |

### Risk callouts (cross-phase)

1. {Cross-phase risk 1 — e.g., "Phase X + Y touch overlapping state. Land X completely before starting Y."}
2. {Cross-phase risk 2 — e.g., "Phase Z needs sibling-module coordination. Plan a paired PR."}
3. ...

### Final tally

| Layer | Findings | Accepted | Withdrawn |
|---|---|---|---|
| L0 — {name} | {N} | {A} | {W} |
| L1 — {name} | {N} | {A} | {W} |
| ... | ... | ... | ... |
| **Total** | **{N}** | **{A}** | **{W}** |

**Cross-cuts closed by completion of this plan:** {T1, T3, T5, ...} ({K} of {Total}).

**Cross-cuts remaining active (by design, post-completion):** {T2, T4, ...} _(rationale per item)_

Plan ready for the implementation phase.
