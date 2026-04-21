<!-- Emitted by code-review SKILL.md Step 7. Placeholders in [brackets] are filled at emission; section-omission rules live inline in SKILL.md. -->
---
template_version: 1
date: [ISO 8601 w/ tz]
reviewer: [User]
repository: [Repo]
branch: [Branch]
commit: [Short hash]
review_type: [commit | pr | staged | working]
scope: "[What was reviewed]"
status: [approved | needs_changes | requesting_changes]
counts: "[C]🔴 · [I]🟡 · [S]🔵"
verification: "[V] verified · [W] weakened · [F] dropped"
tags: [code-review, relevant-components]
---

# Code Review — [Scope] ([commit])

Status: **[status]**   ·   [C]🔴 · [I]🟡 · [S]🔵   ·   verification: [V]✓ [W]− [F]✗

Top blockers:
1. [ID] — [one-line headline]
2. [ID] — [one-line headline]

───────────────────────────────────────────────────────────────────

## Legend
🔴 fix before merge  ·  🟡 fix soon  ·  🔵 nice to have  ·  💭 discuss
IDs: I=interaction  Q=quality  S=security  G=gap
verification: ✓ verified  − weakened (demoted)  ✗ falsified (dropped)
annotations: [precedent-weighted]  [cascade: <kind>]  [subsumed-by <ID>]

───────────────────────────────────────────────────────────────────

## 🔴 Critical

🔴 [ID] [annotation?]  [short headline]
    - where  file:line
    - code   `<verbatim line from the file>`
    - why    [1–2 lines: mechanism, not symptom]
    - fix    [one sentence, imperative]
    - alt    [optional: alternative fix]

(one block per 🔴 finding; interaction findings may add a `peer` or `cites` line listing the ≥2 file:line facts)

───────────────────────────────────────────────────────────────────

## 🟡 Important

🟡 [ID] [annotation?]  [short headline]
    - where  file:line
    - code   `<verbatim line>`
    - why    [mechanism]
    - fix    [action]

───────────────────────────────────────────────────────────────────

## 🔵 Suggestions

🔵 [ID]  [short headline]
    - where  file:line
    - fix    [action]

───────────────────────────────────────────────────────────────────

## 💭 Discussion

💭 [ID]  [question / architectural concern]
    - where  file:line
    - why    [what the reviewer wants the author to consider]

───────────────────────────────────────────────────────────────────

## Pattern Analysis
Peer: `<peer file>`  ·  Mirrored [M] · Missing [Mi] · Diverged [D] · Intentionally-absent [A]
Missing/Diverged rows drive: [finding IDs]

───────────────────────────────────────────────────────────────────

## Impact

  consumer                           change           findings
  ────────────────────────────────   ──────────────   ────────
  [file:line]                        [change class]   [IDs]

───────────────────────────────────────────────────────────────────

## Precedents
  [hash]   "[commit subject]"                           [30d follow-ups | NOT ancestor of [TIP] | note]

Recurring lessons (most → least):
  1. [composite lesson]
  2. ...

───────────────────────────────────────────────────────────────────

## Recommendation
> (advisor prose pasted verbatim here when advisor ran; omit the blockquote otherwise)

1. [ID]  [action, one sentence]  |  Alt: [alternative]
2. [ID]  [action]
3. [ID]  [action]
