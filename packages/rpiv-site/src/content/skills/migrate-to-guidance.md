---
slug: migrate-to-guidance
tagline: One-shot move from inline `CLAUDE.md` files to the `.rpiv/guidance/` shadow tree, transforming cross-references along the way.
purpose: |
  Converts a project that already uses inline `CLAUDE.md` files into the shadow-tree layout consumed by `annotate-guidance`. The migration relocates every file to `.rpiv/guidance/<path>/architecture.md` and rewrites internal references so links keep working after the move.
when_to_use:
  - A project already has inline `CLAUDE.md` files from `annotate-inline` and you want shadow-tree layout instead.
  - You're consolidating scattered `CLAUDE.md` files into one place.
  - Skip when no `CLAUDE.md` files exist. There is nothing to migrate.
inputs:
  - name: --delete-originals (flag)
    required: false
    source: Pass to remove the original `CLAUDE.md` files after a successful move
  - name: --force (flag)
    required: false
    source: Overwrite conflicting target files
outputs:
  - artifact: Shadow guidance tree
    path: .rpiv/guidance/<path>/architecture.md
    format: markdown (format-preserved from source)
key_steps:
  - title: Pre-flight glob + conflict scan
    rationale: Globs `**/CLAUDE.md` and inspects `.rpiv/guidance/` so the user sees, up-front, what will move and what would collide before any write happens.
  - title: Dry-run preview (file list, conflicts, warnings)
    rationale: The migration script emits a JSON plan; the skill renders it as a table the user signs off on. Catches missed files and dangerous overwrites before the destructive run.
  - title: Decide on `--delete-originals` and `--force`
    rationale: Flags are explicit decisions, not defaults. Forces the user to acknowledge the destructive shape of the run.
  - title: Execute migration script; parse JSON results
    rationale: All file operations stay in the script. The skill never moves files by hand. Keeps the operation reversible and consistent across runs.
  - title: Repair unresolved prose references
    rationale: Some cross-references the script can't rewrite automatically; the skill offers a contextual fix-up pass using project structure knowledge to finish the link rewrites.
related:
  upstream: [annotate-inline]
  downstream: [annotate-guidance]
---
