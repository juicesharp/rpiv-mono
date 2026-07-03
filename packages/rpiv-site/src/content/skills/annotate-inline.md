---
slug: annotate-inline
tagline: Documents a project's architecture for AI assistants by writing compact `CLAUDE.md` files inline next to the source they describe.
purpose: |
  Same end goal as `annotate-guidance` (onboards AI agents to a brownfield codebase via per-directory architecture notes). This skill places `CLAUDE.md` files next to the source they describe instead of in a shadow tree. Choose this when teams prefer guidance to live beside the code.
when_to_use:
  - The project should keep architecture docs adjacent to source.
  - You need first-time AI onboarding for a codebase that already uses inline `CLAUDE.md` conventions.
  - Pick `annotate-guidance` instead for shadow-tree (`.rpiv/guidance/`) layout.
  - Pick `migrate-to-guidance` when existing inline files need to move into the shadow tree.
inputs:
  - name: target-directory
    required: false
    source: CLI argument or current working directory
  - name: existing CLAUDE.md / READMEs
    required: false
    source: Paths mentioned inline
    notes: Read fully before agents dispatch.
outputs:
  - artifact: Root project guidance
    path: CLAUDE.md (project root)
    format: markdown
  - artifact: Per-layer guidance
    path: <layer>/CLAUDE.md (next to source)
    format: markdown
key_steps:
  - title: Read directly-mentioned files first
    rationale: Existing docs lock in team-level decisions before any subagent runs, so later passes don't contradict what's already documented.
  - title: Pass 1. Map tree and detect architecture (parallel)
    rationale: One locator agent maps the tree; one identifies the architecture from folder shape and manifest files. Running both concurrently halves discovery time.
  - title: Apply guidance-depth rules; propose targets
    rationale: A two-pass selection (top-level layers, then opt-in decomposition) keeps the target list grounded in folder shape and is shown to the user for confirmation before any analysis spend.
  - title: Pass 2. Analyzer + pattern-finder per target (parallel)
    rationale: Per-target `codebase-analyzer` answers "what is this for"; `codebase-pattern-finder` extracts idiomatic code shapes. Both run concurrently for depth per token.
  - title: Developer checkpoint on findings
    rationale: One question at a time surfaces deprecated patterns, undocumented conventions, and migrations-in-progress that code reading alone cannot reveal.
  - title: Batch-write CLAUDE.md files
    rationale: Files are written in a single emission pass after the checkpoint, so the inline-guidance set lands internally consistent.
related:
  upstream: []
  downstream: [research, design, blueprint]
---
