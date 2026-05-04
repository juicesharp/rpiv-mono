---
name: commit
description: Create structured git commits by analyzing staged and unstaged changes and grouping them logically into one or more commits with clear, descriptive messages. Use when the user asks to commit, says "commit this" or "commit my changes", wants help writing a commit message, or has finished a chunk of work that needs committing.
argument-hint: [message]
allowed-tools: Bash(git *), Read, Glob, Grep
---

# Commit Changes

You are tasked with creating git commits for repository changes.

## Commit hint

`$ARGUMENTS` (empty/literal → infer from history and `git diff`)

## Context:
- **In-session**: If there's conversation history, use it to understand what was built/changed
- **Standalone**: If no context available, rely entirely on git state and file inspection

## Process:

0. **Check git availability:**
   - Run `git status --short` to determine whether the current directory is a git repository
   - If not a git repo, tell the user: "This directory is not a git repository. Run `git init` to initialize one."
   - Stop — do not proceed with commit.

1. **Think about what changed:**
   - **If in-session**: Review the conversation history to understand what was accomplished
   - **Always**: Run `git diff` to understand the modifications in detail
   - If needed, inspect file contents to understand purpose and scope
   - Consider whether changes should be one commit or multiple logical commits

2. **Plan your commit(s):**
   - Identify which files belong together
   - Draft clear, descriptive commit messages
   - Use imperative mood in commit messages
   - Focus on why the changes were made, not just what
   - Check for sensitive information (API keys, credentials) before committing

3. **Present your plan to the user:**
   - List the files you plan to add for each commit
   - Show the commit message(s) you'll use
   - Use the `ask_user_question` tool to confirm the commit plan. Question: "[N] commit(s) with [M] files. Proceed?". Header: "Commit". Options: "Commit (Recommended)" (Create the commit(s) as planned); "Adjust" (Change the grouping or commit messages); "Review files" (Show me the full diff before committing).

4. **Execute upon confirmation:**
   - Use `git add` with specific files (never use `-A` or `.`)
   - Create commits with your planned messages
   - Show the result with `git log --oneline -n X` (where X = number of commits you just created)

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
