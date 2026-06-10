<!-- pr-triage artifact template. Read at emission time, fill every {placeholder},
apply section-omission (delete a section AND its trailing `---` when its input is
empty), strip this comment, Write once. The artifact LEADS with the decision: a plain
Bottom line, the ranked Top Blockers, and a Legend — so a reader can act in under a
minute without reading every finding. All counts ({*_count}) are computed mechanically
by the skill (Step 5) from the agent rows — never re-counted in prose. Routing fields in
frontmatter are integers the workflow gate reads via Number(); the enums are display
mirrors. -->
---
template_version: 2
date: {Current date and time with timezone in ISO format}
author: {User from injected git context}
repository: {Repository name}
branch: {Current branch name}
commit: {Current commit hash}
pr_number: {N}
pr_url: "{PR URL}"
pr_title: "{PR title}"
head_ref: {PR head branch}
base_ref: {PR base branch}
status: ready
security_flag: {0 SAFE | 1 REVIEW | 2 BLOCK}
blockers_count: {N}
structural_count: {N}
local_count: {N}
intent_undelivered: {N}
scope_creep_count: {N}
risk: {low | medium | high}
convention_drift: {none | local | structural}
tags: [pr-triage, relevant-components]
---

# PR Triage — #{N} {pr_title}

**{head_label} → {base_ref}** · **Security:** {SAFE|REVIEW|BLOCK} · **Drift:** {none|local|structural} · **Recommendation:** {Review|Request changes|Hold|Decline}

## Bottom line

{1–2 plain sentences naming the decision. Lead with the crux — the single thing that
most determines whether/how to engage (e.g. "a focused fix that matches the module's
conventions and delivers its stated intent" → Review; or "a maintainer flagged possible
overlap with existing functionality and the contributor agreed" → Hold). Not a list — the
headline judgment.}

**Recommendation:** {Review | Request changes | Hold | Decline} — {the concrete next step: open a
review / send back to the author with the blockers / comment the scope question / close with a
pointer to where it belongs.}
**rpiv (optional):** `/wf vet "{pr_url}"` runs the review → repair → commit loop on the diff (Review only).  {BLOCK: "— STOP: resolve the security finding before any checkout"}
**Definition of done:** {Request changes → resolve the {blockers_count} blockers, then it is Review-ready. Hold → the question that, once answered, unblocks. Decline → where it belongs instead.}

---

## Top Blockers

{The 3–5 facts that actually drive the decision, ranked most-decisive first. Structural
drift, undelivered intent, and the fit/scope crux only — never the minor nits. Omit this
whole section (and its `---`) when there are none (SAFE + clean + intent fully delivered).}

1. **{headline}** — `{file:line}` — {one-line why it blocks}
2. **{headline}** — `{file:line}` — {…}

---

## Legend

```text
disposition  Review (proceed to the review stage) · Request changes (back to the author) · Hold (settle scope first) · Decline (close/relocate)
security     SAFE · REVIEW · BLOCK (a BLOCK halts before any checkout)
drift        local = contained convention slip · structural = breaks a boundary/contract the standard sets
blockers     structural-drift rows + undelivered-intent claims (minor drift is non-blocking)
rpiv         optional, with Review: `/wf vet "<pr-url>"` runs the review → repair → commit loop on the diff
```

---

## Verdict

| Field | Value |
| ----- | ----- |
| Gates | CI {passing\|failing\|pending\|none}{ (failing: {check names})} · Security {SAFE\|REVIEW\|BLOCK} |
| Security | {tier} — {one-line rationale} |
| Convention drift | {none\|local\|structural} — {structural_count} structural · {local_count} minor, across {M} modules |
| Intent | {D} delivered · {intent_undelivered} undelivered · {scope_creep_count} scope-creep |
| Blockers | {blockers_count} = {structural_count} structural + {intent_undelivered} undelivered intent ({local_count} minor are non-blocking) |
| Fit | {in-scope / needs-scope-decision / possibly-redundant — the consideration that should drive the call, one line} |
| Risk | {low\|medium\|high} — {what drives it; if CI is failing, name which checks} |
| **Recommendation** | **{Review\|Request changes\|Hold\|Decline}** — {one-line why + the next action} |

---

## Security

{SAFE: one-paragraph "no untrusted-input sink reached…" — keep it terse. Otherwise one
row per finding:}

- **{tier}** — `{file:line}` — `{verbatim line}` — {sink class} — confidence {N}/10

---

## Convention Drift

### Structural ({structural_count})

{Per structural finding — full block. Omit this subsection when structural_count is 0.}

#### {file:line}

**Standard** ({doc§ | linter-rule | peer `file:line`})
{what the resolved standard requires, in the module's own terms}

**Diff** — `{verbatim line}`

**Why it blocks** — {one sentence}

**Align** — {one-line action: rename / pin / wire / add}

### Minor ({local_count})

{Collapse local nits to ONE line each — do not give them full blocks. Omit this
subsection when local_count is 0.}

- `{file:line}` — {what's missing/off vs the peer standard}

---

## Intent Gaps

### Stated-but-undelivered ({intent_undelivered})

{Omit when 0.}

| Stated claim (source) | Delivered? | Evidence / gap |
| --------------------- | ---------- | -------------- |
| {claim} ({PR body \| #issue}) | {no \| partial} | `{file:line}` or `<absent>` |

### Scope creep ({scope_creep_count})

{Delivered-but-unstated. Omit when 0.}

| Change | Evidence |
| ------ | -------- |
| {change} | `{file:line}` — not mentioned in the PR |

---

## Unguided Modules

{Omit when every touched module resolved to a standard. Modules with no doc, no linter
rule, AND no readable peers — a standards-coverage hole, not a violation.}

- `{module path}` — no standard source found ({why})

---

## Notes

- Standards source per module: {N doc · N linter · N peer}{; N unguided}
- Triage is read-only: no checkout or mutation was performed.
- {Any cross-cutting context the reader needs — external contributor, maintainer comment, prior-art overlap.}
