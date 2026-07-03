---
slug: research
tagline: Answers structured research questions about a codebase by formulating trace-quality questions, dispatching parallel analysis agents, and synthesizing a cited research document under `.rpiv/artifacts/research/`.
purpose: |
  Resolves ambiguities about how the existing implementation works *before* deciding how to change it. Subsequent design and planning skills read this artifact instead of re-reading the codebase, so downstream phases are grounded in evidence and start cheap.
when_to_use:
  - You need depth on architecture or behavior questions before a change.
  - A `discover` artifact exists and the team needs file-backed answers to its open questions.
  - You're about to design or plan and want a single citation source.
  - Skip if the area is already well-trodden and the change is a one-line fix.
inputs:
  - name: $ARGUMENTS
    required: true
    source: Free-text research prompt OR path to a `.rpiv/artifacts/discover/*.md` artifact
    notes: A `discover` artifact triggers FRD parsing. Its Decisions become Developer Context.
outputs:
  - artifact: Research document
    path: .rpiv/artifacts/research/
    format: markdown
key_steps:
  - title: Trace the investigation scope
    rationale: The `scope-tracer` agent reads the prompt, sweeps anchor terms, and emits 5–10 dense numbered questions. Locking scope before any deep read prevents agents from chasing a fuzzy target.
  - title: Group related questions
    rationale: Questions that share 2+ file references are grouped into a single agent dispatch so the agent can use cross-question context for deeper, more connected analysis. Fewer agents, more depth per token.
  - title: Dispatch analysis agents in parallel
    rationale: One `codebase-analyzer` per question (or group), plus one `web-search-researcher` for external-doc questions and one `precedent-locator` when git history is available. All run concurrently; sync barrier before synthesis.
  - title: Synthesize findings into a jump table
    rationale: Final document is `file:startLine-endLine` references plus prose, not code blocks, not implementation recipes. Designed for the planner to look up, not re-read.
  - title: Grounded developer checkpoint
    rationale: One question at a time, every question embeds a real `file:line` reference. Pulls only NEW information from the developer; confirmatory questions are explicitly banned.
related:
  upstream: [discover]
  downstream: [design, plan, blueprint, explore]
---
