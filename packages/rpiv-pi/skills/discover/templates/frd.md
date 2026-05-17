---
date: {Current date and time with timezone in ISO format}
author: {User from injected git context}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
topic: "{Feature topic}"
tags: [intent, frd, relevant-component-names]
status: complete
last_updated: {Same ISO timestamp as `date:` above}
last_updated_by: {User from injected git context}
---

# FRD: {Feature topic}

## Summary
{2-3 sentences. The settled feature concept after the interview — what we're building, in the developer's framing.}

## Problem & Intent
{What the developer is trying to solve and why. Capture the underlying motivation, not the proposed solution.}

## Goals
- {Explicit goal — what success looks like}
- {Goal 2}

## Non-Goals
- {Explicit exclusion — surfaced during the interview}
- {Likely scope-creep vector the developer ruled out}

## Functional Requirements
1. {Numbered, independently testable. "The system SHALL …"}
2. {Requirement 2}

## Non-Functional Requirements
- **Performance**: {latency / throughput / load expectations, or "no specific constraint"}
- **Security**: {auth, data handling, threat model edges}
- **UX / Accessibility**: {interaction model, a11y constraints}
- **Reliability**: {error handling expectations, retry/recovery semantics}

## Constraints & Assumptions
- {Technical constraint — runtime, dependency, platform}
- {Schedule / organizational constraint}
- {Assumption being made — explicit so research can verify}

## Acceptance Criteria
- [ ] {Observable pass condition a reviewer can check without reading code}
- [ ] {Criterion 2}

## Recommended Approach
{1-2 sentences. The architectural shape implied by the decisions — e.g., "New command in `packages/rpiv-pi/extensions/`, writes JSON to stdout, no persistence layer." The downstream `research` skill validates this against the codebase and passes this text to `scope-tracer` as the topic.}

## Decisions

### {Decision 1 — short title}
**Question**: {Question as asked during the interview, or "Pre-resolved from codebase evidence"}
**Recommended**: {The recommendation that was offered}
**Chosen**: {What the developer picked, or the evidence-derived answer}
**Rationale**: {1 line — why this was chosen, or `evidence: path/to/file.ext:line` for codebase-derived}

### {Decision 2 — short title}
**Question**: …
**Recommended**: …
**Chosen**: …
**Rationale**: …

## Open Questions
{Only items the developer explicitly deferred. Each becomes an Open Question for `research` to answer or carry forward into Developer Context.}

- {Deferred item 1 — what's deferred, why}

## Suggested Follow-ups
{Related-but-out-of-scope items surfaced during the probe or interview that the developer did NOT add to scope. One line per item: what was observed and where. Omit the entire section if empty — do not leave placeholder text.}

- {Observed item — `file:line`}

## References
- {Input file or ticket}
- {Related artifact, e.g., `.rpiv/artifacts/research/<YYYY-MM-DD_HH-MM-SS>_<topic>.md`}
