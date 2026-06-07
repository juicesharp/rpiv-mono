---
template_version: 2
date: {Current date and time with timezone in ISO format}
author: {User from injected git context}
repository: {Repository name}
branch: {Current branch name}
commit: {Current commit hash}
review_type: {commit | pr | staged | working}
scope: "{What was reviewed}"
scope_strategy: {first-parent | explicit-range | working-tree}
in_scope_files_count: {N}
status: ready
severity: { critical: {C}, important: {I}, suggestion: {S} }
verification: { verified: {V}, weakened: {W}, falsified: {F} }
blockers_count: {B}
tags: [code-review, relevant-components]
---

# Code Review — {Scope}

**Commit:** `{hash}` · **Status:** `{status}` · **Findings:** {C}🔴 · {I}🟡 · {S}🔵 · **Verification:** {V}✓ / {W}− / {F}✗

## Top Blockers

1. **{ID}** — {one-line headline}
2. **{ID}** — {one-line headline}

---

## Legend

```text
Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss
ID prefix   I interaction   Q quality   S security   G gap
Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)
Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]
```

---

## 🔴 Critical

### {ID} 🔴 {short headline} `{annotation?}`

**Where**
`{file:line}`

**Code**
```{lang}
{verbatim line(s) from the file}
```

**Why**
{1–2 sentences: mechanism, not symptom}

**Fix**
{one sentence, imperative}

**Alt**
{optional: alternative fix}

---

## 🟡 Important

### {ID} 🟡 {short headline} `{annotation?}`

**Where**
`{file:line}`

**Code**
```{lang}
{verbatim line(s)}
```

**Why**
{mechanism}

**Fix**
{action}

---

## 🔵 Suggestions

### {ID} 🔵 {short headline}

**Where**
`{file:line}`

**Fix**
{action}

---

## 💭 Discussion

### {ID} 💭 {question / architectural concern}

**Where**
`{file:line}`

**Why**
{what the reviewer wants the author to consider}

---

## Pattern Analysis

| Peer            | Mirrored | Missing | Diverged | Intentional |
| --------------- | -------: | ------: | -------: | ----------: |
| `{peer file}`   |      {M} |    {Mi} |      {D} |         {A} |

**Missing/Diverged rows drive:** {finding IDs}

**Key divergences from peer**
- {divergence one}
- {divergence two}

---

## Impact

| Consumer        | Change           | Findings |
| --------------- | ---------------- | -------- |
| `{file:line}`   | {change class}   | {IDs}    |

---

## Precedents

| Commit    | Subject          | Follow-ups                                              |
| --------- | ---------------- | ------------------------------------------------------- |
| `{hash}`  | {commit subject} | {30d follow-ups, or "NOT ancestor of {TIP}", or note}   |

**Recurring lessons (most → least frequent)**

1. {composite lesson}
2. ...

---

## Recommendation

> (advisor prose pasted verbatim here as a blockquote when advisor ran; omit the blockquote otherwise)

| # | ID     | Action                      | Alt / Note        |
| - | ------ | --------------------------- | ----------------- |
| 1 | {ID}   | {action, one sentence}      | {alternative}     |
| 2 | {ID}   | {action}                    | —                 |
| 3 | {ID}   | {action}                    | —                 |
