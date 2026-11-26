---
name: commit
description: Create structured git commits by analyzing staged and unstaged changes and grouping them logically into one or more commits with clear, descriptive messages. Use when the user asks to commit, says "commit this" or "commit my changes", wants help writing a commit message, or has finished a chunk of work that needs committing.
argument-hint: "[message] [--baseline <path>]"
allowed-tools: Bash(git *), Bash(jj *), Bash(node *), Read, Glob, Grep
shell-timeout: 10
contract:
  produces:
    kind: side-effect
    meta:
      effect: git-commit
  consumes:
    meta:
      world: dirty-tree
---

# Commit Changes

You are tasked with creating git commits for repository changes.

## Input

`$ARGUMENTS` — optional commit message hint, optionally with `--baseline <path>` (a workflow's run-start snapshot of paths that were already dirty before the run began). Peel the `--baseline` flag first; the remainder (if any) is the message hint. Empty/literal → infer from history and `git diff` (under `vcs: jj`: `jj diff --git`).

## Metadata

```!
node "${SKILL_DIR}/../_shared/git-changes.mjs"
echo "---recent-subjects---"
git log --pretty=%s -n 20 2>/dev/null || true
```

`---recent-subjects---` — up to 20 most recent commit subject lines, used in Step 2 to match the repository's existing commit-message style. Empty on a no-HEAD initial repo.

**When `--baseline <path>` was provided**, the Metadata block above was rendered WITHOUT the baseline (render-time substitution cannot capture `$ARGUMENTS` — same reason code-review's scope helper is LLM-invoked). Before anything else, re-run the snapshot with the baseline threaded and use ITS output as the authoritative `---status---` / `---diffstat---` for the rest of this skill:

```
node "${SKILL_DIR}/../_shared/git-changes.mjs" --baseline <path>
```

`---pre-existing (do NOT commit — dirty before this run)---` — present in that re-run's output when some listed files were already dirty before the run began. These are **out of scope**: they are not this run's work. **Never `git add` a path in this section** — a workflow commits only the changes it produced. The re-run's `---status---` block already excludes them; they are shown purely so you know they exist and must be left uncommitted.

## VCS backend

One decision governs every command in this skill:

1. `jj root` succeeds → backend `jj`.
2. Otherwise `git rev-parse --show-toplevel` succeeds → backend `git`.
3. Neither → this skill's repository gate applies, unchanged.

When the Metadata block prints a `vcs:` line, it carries the same decision.

| Purpose | `git` | `jj` |
|---|---|---|
| working-copy state | `git status --short --untracked-files=all` | `jj diff --summary` — an `A` line is a new file, not untracked |
| change against the parent | `git diff HEAD` | `jj diff --git` |
| recent commits | `git log --oneline -n 20` | `jj log -r '::@-' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'` |
| one commit | `git show <id>` | `jj show <id>` — a change id and a commit id both resolve |
| one file in one commit | `git show <id>:<path>` | `jj file show -r <id> <path>` |
| changed paths between two revisions | `git diff <a> <b> --name-only` | `jj diff --from <a> --to <b> --name-only` |
| path-filtered history | `git log -- <path>` | `jj log -r '::@' -- <path>` |
| parent revision | `<id>^` | `<id>-` |
| ancestry proof | `git merge-base --is-ancestor <a> <b>` | `jj log -r '<a> & ::<b>' --no-graph -T commit_id` prints `<a>` when `<a>` is an ancestor of `<b>` |
| undo a local edit | `git restore <path>` | `cp` the captured bytes back — never `jj restore --from @-`, which also discards pre-existing uncommitted edits |
| never run | `git reset` | `jj abandon`, `jj op restore` |

## Context:
- **In-session**: If there's conversation history, use it to understand what was built/changed
- **Standalone**: If no context available, rely entirely on git state and file inspection

## Process:

0. **Check VCS availability:**
   - If `vcs:` in the Metadata block is `none`, tell the user: "This directory is neither a git repository nor a jj repository. Initialize one for the VCS you intend to use, then re-run this skill." Stop — do not proceed.
   - Use the `jj` column of the VCS backend table for every command when `vcs: jj`.

1. **Think about what changed:**
   - **If in-session**: Review the conversation history to understand what was accomplished.
   - The Metadata block gives you the file list and per-file diffstat (insertions/deletions). For files with a small diffstat (≲5 lines), the line counts alone are enough to write the message — skip `git diff`. Run `git diff <path>` (`vcs: jj`: `jj diff --git <path>`) only for files where the change is large or the intent isn't obvious from filename + line counts.
   - For untracked directories shown in status (e.g. `?? path/`), assume their contents are the change unless the directory has many files; do NOT `cat`/`head` files to verify obvious purpose.
   - Consider whether changes should be one commit or multiple logical commits.

2. **Plan your commit(s):**
   - Identify which files belong together
   - Draft clear, descriptive commit messages
   - Use imperative mood in commit messages
   - **Match the subject style observed in `---recent-subjects---`** — same prefix convention (e.g. `feat:` / `fix(scope):` / `docs:` for Conventional Commits, gitmoji, bare sentence-case, ticket-prefixed, etc.), same length budget, same casing. If the sample is empty (initial repo) or mixed, default to imperative sentence-case with no prefix.
   - Focus on why the changes were made, not just what
   - Check for sensitive information (API keys, credentials) before committing

3. **Present your plan to the user:**
   - List the files you plan to add for each commit
   - Show the commit message(s) you'll use
   - Use the `ask_user_question` tool to confirm the commit plan. Question: "{N} commit(s) with {M} files. Proceed?". Header: "Commit". Options: "Commit (Recommended)" (Create the commit(s) as planned); "Adjust" (Change the grouping or commit messages); "Review files" (Show me the full diff before committing).
     - `Header` is capped at ≤16 characters (`MAX_HEADER_LENGTH = 16` — longer values are rejected).

4. **Execute upon confirmation:**
   - Under `vcs: git` use `git add` with specific files — never `-A` or `.` — and stage **only** files from the `---status---` block. Any path under `---pre-existing (do NOT commit …)---` is out of scope: leave it dirty, never stage it. Under `vcs: jj` there is nothing to stage: jj snapshots the working copy, so commit only the paths from the `---status---` block.
   - Under `vcs: jj` the commit itself is `jj split <run-paths> -m "<msg>"`, then `jj new` so the next change starts clean. `jj split` puts the listed paths in the parent change (`@-`) and the remainder in `@`, so the message lands on the run's work and the `---pre-existing (do NOT commit …)---` paths stay uncommitted. When every dirty path is the run's own work, `jj describe -m "<msg>"` then `jj new` is equivalent. Committing without the split puts the pre-existing paths in the run's commit, so the message labels work the run did not do. The `wip-intact` guard accepts a path the run committed, so it will NOT catch this — the split is the only thing that keeps the commit honest.
   - Create commits with your planned messages
   - Show the result with `git log --oneline -n X` (`vcs: jj`: `jj log -r '::@-' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'`) (where X = number of commits you just created)

## Important:

- **NEVER add co-author information or Claude attribution**
- Commits should be authored solely by the user
- Do not include any "Generated with Claude" messages
- Do not add "Co-Authored-By" lines
- Write commit messages as if the user wrote them

## Remember:

- Adapt your approach: use conversation context if available, otherwise infer from git state
- In-session: you have full context of what was done; Standalone: infer from git analysis
- Group related changes by purpose (feature, fix, refactor, docs)
- Keep commits atomic: one logical change per commit
- Split into multiple commits if: different features, mixing bugs with features, or unrelated concerns
- The user trusts your judgment - they asked you to commit
