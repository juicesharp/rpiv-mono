---
template_version: 1
date: {Current date and time with timezone in ISO format}
author: {`author:` from Metadata block}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
topic: "Validation of {plan topic}"
status: ready
verdict: {pass | fail}
parent: "{plan path}"
tags: [validation, {inherit relevant tags from the plan's frontmatter}]
last_updated: {Same ISO timestamp as date: above}
---

## Validation Report: {Plan topic}

### Implementation Status

- ✓ Phase 1: {name} — {Fully implemented | Partially implemented (see Findings) | Not implemented}
- ✓ Phase 2: {name} — {…}
- ⚠️ Phase 3: {name} — {Partial — see Findings}

### Automated Verification Results

- ✓ {1-line label}: `{command from plan}` — {brief outcome, e.g., "368 files, no errors"}
- ✓ {1-line label}: `{command from plan}` — {brief outcome}
- ✗ {1-line label}: `{command from plan}` — {failure summary}
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- {file:line — what matches plan specification}
- {…}

#### Deviations from Plan:

- {file:line — what diverged and why (improvement vs gap)}
- {or:} None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

_Optional subsection — include when the pattern-conformance check surfaced observations worth recording. Omit the whole `#### Pattern Conformance:` block when there is nothing to say._

- ✓ {Imports / test structure / naming / mock patterns / etc.} follow established codebase conventions
- Minor observation: {non-blocking variation worth flagging — explicitly tag as "acceptable variation, not a deviation"}

#### Potential Issues:

_Optional subsection — include when risks not covered by the plan surface (missing indexes, rollback gaps, perf concerns). Omit the whole `#### Potential Issues:` block when there are none._

- {file:line — risk not covered by the plan}

### Manual Verification Results

| Criterion / source | Procedure and expected outcome | Observed outcome | Result | Evidence |
|---|---|---|---|---|
| {plan location or acceptance ID and statement} | {procedure; expected outcome} | {actual observation or missing prerequisite} | {passed / failed / unverified / deferred} | {artifact path, run ID, or conversation decision reference; if unavailable, state why} |

{Repeat for every manual criterion and manual acceptance item. For deferred items, include the existing approved deferral reason. When none exist, replace the table with:}

None — no manual verification criteria apply.

### Verification Blockers

- {Failed or unverified criterion}: {specific blocker}; next action: {required action and responsible party}.
- {Or:} None — no verification blockers remain.

### Recommendations:

- {Actionable bullet — e.g., "Address linting warnings before merge"}
- {…}
- {Or, when `verdict: pass`:} Ready to commit — implementation is complete and validated.
