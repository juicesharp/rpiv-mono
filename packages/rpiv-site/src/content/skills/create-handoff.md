---
slug: create-handoff
tagline: Compresses the current session's task, decisions, in-flight changes, and open questions into a single handoff document that a fresh session can pick up cold.
purpose: |
  Captures in-flight state when stopping mid-feature. The handoff is dense enough that the next session re-enters the work without re-deriving it from scratch: task status, critical references, recent file:line changes, learnings, artifacts, and action items.
when_to_use:
  - Context is filling up and you need to start a fresh session.
  - You're wrapping for the day mid-feature.
  - Work needs to hand off to another agent or person.
inputs:
  - name: description
    required: false
    source: Short free-text description of the work to capture
outputs:
  - artifact: Handoff document
    path: .rpiv/artifacts/handoffs/YYYY-MM-DD_HH-MM-SS_description.md
    format: markdown with structured frontmatter (date, author, commit, branch, topic, tags, status)
key_steps:
  - title: Collect filepath + git/author metadata
    rationale: Repository, branch, commit hash, and author go into frontmatter so the resume agent can verify it's loading the right snapshot before doing anything.
  - title: Write structured sections (Task(s) · Critical References · Recent changes · Learnings · Artifacts · Next Steps)
    rationale: A consistent skeleton means resume agents (and humans) know where to look. Each section has a single job, none of them is "freeform dump".
  - title: Prefer `file:line` references over code blocks
    rationale: Handoffs aren't archives. They're indexes. Pointing at code by path:line keeps the document small and forces resume agents to re-read live source instead of stale snippets.
  - title: Save and emit the resume template
    rationale: Returns the exact path to pass to `resume-handoff`, ready to copy into a new session. Makes the chain frictionless.
related:
  upstream: []
  downstream: [resume-handoff]
---
