---
name: migrate-to-guidance
description: Migrate a project's inline CLAUDE.md files to the .rpiv/guidance/ shadow-tree system. Finds every CLAUDE.md, transforms internal references, and creates equivalent architecture.md files under .rpiv/guidance/. Use when the user wants to move from inline CLAUDE.md to the guidance shadow tree, consolidate scattered CLAUDE.md files into one place, or invokes /migrate-to-guidance.
argument-hint: [--delete-originals]
allowed-tools: Bash, Read, fffind
---

# Migrate CLAUDE.md to Guidance

You are tasked with migrating a project's existing `CLAUDE.md` files (typically created by `/skill:annotate-inline`) into the `.rpiv/guidance/` system.

The migration relocates files from in-place `CLAUDE.md` to `.rpiv/guidance/{path}/architecture.md` and transforms internal cross-references.

## Input

`$ARGUMENTS` — optional `--delete-originals` flag to remove the source CLAUDE.md files after migration.

## Steps to follow:

1. **Pre-flight check:**
   - Use fffind to find all `**/CLAUDE.md` files in the project
   - If none are found, inform the user: "No CLAUDE.md files found in this project. Nothing to migrate." and stop
   - If `.rpiv/guidance/` already exists, note this — there may be conflicts

2. **Dry run — preview the migration:**
   - Run the migration script in dry-run mode:
     ```
     node scripts/migrate.js --project-dir "${CWD}" --dry-run
     ```
   - Parse the JSON output from stdout and present a migration plan to the user:
     ```
     ## Migration Plan

     Found {N} CLAUDE.md files to migrate:

     | Source | Target | Lines |
     |--------|--------|-------|
     | CLAUDE.md | .rpiv/guidance/architecture.md | 45 |
     | src/core/CLAUDE.md | .rpiv/guidance/src/core/architecture.md | 78 |
     | ... | ... | ... |
     ```
   - If there are **conflicts** (targets that already exist), list them:
     ```
     ### Conflicts (targets already exist):
     - .rpiv/guidance/src/core/architecture.md

     Use --force to overwrite these.
     ```
   - If there are **warnings** (unresolved prose references), list them:
     ```
     ### Warnings:
     - .rpiv/guidance/architecture.md line 23: Prose reference may need manual update
     ```
   - Ask the user for confirmation before proceeding. Ask whether they want to:
     - Delete the original CLAUDE.md files after migration (`--delete-originals`)
     - Overwrite existing conflicts (`--force`)

3. **Execute the migration:**
   - Build the command based on user choices:
     ```
     node scripts/migrate.js --project-dir "${CWD}" [--delete-originals] [--force]
     ```
   - Run the migration and parse the JSON output
   - Present the results:
     ```
     ## Migration Complete

     | Source | Target | Lines | Refs Updated |
     |--------|--------|-------|--------------|
     | CLAUDE.md | .rpiv/guidance/architecture.md | 45 | 3 |
     | src/core/CLAUDE.md | .rpiv/guidance/src/core/architecture.md | 78 | 1 |
     | ... | ... | ... | ... |

     Total: {N} files migrated
     {Originals deleted: yes/no}
     ```

4. **Post-migration:**
   - If warnings exist about unresolved prose references:
     - Read the affected guidance files
     - Offer to fix the remaining references using contextual knowledge of the project structure
   - Print the closing footer (verbatim, with placeholders filled):
     ```
     Migration complete: {N} files migrated to `.rpiv/guidance/`.
     {Originals deleted: yes/no}
     Verification: run `claude` in the project and read a source file to confirm guidance injection works.

     ---

     💬 Follow-up: describe targeted edits in chat; re-run `/skill:migrate-to-guidance` with different flags (`--force`, `--delete-originals`) for a different migration shape.

     **Next step:** `/skill:annotate-guidance` — refresh or extend annotations now that the guidance tree owns them (skip if no further annotation is planned).

     > 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
     ```

## Important notes:
- The migration script handles all file operations — do not manually copy or move CLAUDE.md files
- Content format is preserved as-is (same markdown structure, same `<important if>` blocks)
- Only cross-references between files are transformed (`CLAUDE.md` paths → `.rpiv/guidance/` paths)
- The script outputs JSON to stdout — parse it for structured results
- Debug logs go to stderr (visible with `claude --verbose`)
