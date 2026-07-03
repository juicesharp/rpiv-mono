---
slug: annotate-guidance
tagline: Documents a project's architecture for AI assistants by writing compact architecture.md files into a .rpiv/guidance/ shadow tree alongside the source.
purpose: |
  Onboards Claude, Cursor, or any Pi-aware AI agent to a brownfield codebase by emitting a parallel `.rpiv/guidance/` tree of small, scannable `architecture.md` files. The guidance system later injects these on demand when an agent touches the matching directory, so context cost stays proportional to what the agent actually reads.
when_to_use:
  - The project should keep `CLAUDE.md` out of the source tree (shadow-tree layout).
  - You need first-time AI onboarding or want to refresh stale guidance after a refactor.
  - Pick `annotate-inline` instead if you want `CLAUDE.md` files next to the code.
  - Pick `migrate-to-guidance` instead if inline `CLAUDE.md` files already exist and only need to be moved.
inputs:
  - name: target-directory
    required: false
    source: CLI argument or current working directory
    notes: Defaults to CWD when omitted.
  - name: existing architecture docs
    required: false
    source: Any `README.md`, `CLAUDE.md`, or `architecture.md` the user mentions inline
    notes: Read fully before agents are dispatched.
outputs:
  - artifact: Root overview
    path: .rpiv/guidance/architecture.md
    format: markdown
  - artifact: Per-layer guidance
    path: .rpiv/guidance/<sub>/architecture.md
    format: markdown
  - artifact: Decomposed sub-layer guidance
    path: .rpiv/guidance/<sub>/<child>/architecture.md
    format: markdown
key_steps:
  - title: Read directly-mentioned files first
    rationale: Locks domain knowledge from existing docs into the main context before any subagent runs, so later passes do not contradict what the team already wrote down.
  - title: Pass 1. Map tree and detect architecture in parallel
    rationale: Two locator agents (one tree-mapper, one architecture-sniffer) run side by side so layout discovery costs one round-trip instead of two.
  - title: Apply guidance-depth rules; propose targets
    rationale: A two-pass selection (top-level layers, then opt-in decomposition of composite layers) keeps the target list grounded in folder shape rather than guesswork. The list is shown to the user for confirmation before any analysis spend.
  - title: Pass 2. Analyzer + pattern-finder per target (parallel)
    rationale: One `codebase-analyzer` answers the "what is this layer for" questions; one `codebase-pattern-finder` extracts idiomatic code shapes. Running both per target in parallel produces the deepest signal per token.
  - title: Developer checkpoint on findings
    rationale: Surfaces deprecated patterns, migrations-in-progress, and cross-layer rules that code reading alone cannot reveal. Asked one question at a time so each answer can steer the next.
  - title: Batch-write architecture.md files
    rationale: All files are written in a single emission pass after the checkpoint, so the guidance tree is internally consistent and never left half-populated mid-session.
related:
  upstream: []
  downstream: [research, design, blueprint]
---
