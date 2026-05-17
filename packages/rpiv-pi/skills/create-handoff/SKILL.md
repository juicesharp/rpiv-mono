---
name: create-handoff
description: Create a context-preserving handoff document for session transitions, compacting the current task, decisions made, in-flight changes, and open questions into a single concise file so a fresh session can pick up where this one left off. Use when the user invokes /create-handoff, says context is getting large, asks to wrap up the session, or wants to hand off work to another session.
argument-hint: [description]
allowed-tools: Read, Write, Bash(git *), Glob, Grep
disable-model-invocation: true
---

# Create Handoff

You are tasked with writing a handoff document to hand off your work to another agent in a new session. You will create a handoff document that is thorough, but also **concise**. The goal is to compact and summarize your context without losing any of the key details of what you're working on.

## Input

`$ARGUMENTS` — optional description (used in the handoff filename slug).

## Process
### 1. Filepath & Metadata
Use the following information to understand how to create your document:
    - create your file under `.rpiv/artifacts/handoffs/YYYY-MM-DD_HH-MM-SS_description.md`, where:
        - YYYY-MM-DD / HH-MM-SS come from the `date` command (see below)
        - description is a brief kebab-case description
     - Repository name: from git root basename, or current directory basename if not a git repo
     - Use the git branch and commit from the git context injected at the start of the session (or run `git branch --show-current` / `git rev-parse --short HEAD` directly)
     - Timestamp: run `date +"%Y-%m-%dT%H:%M:%S%z"` — raw for `date:` and `last_updated:`, first 19 chars (`T`→`_`, `:`→`-`) for filename slug.
     - Author: use the User from the git context injected at the start of the session (fallback: "unknown")
     - If metadata unavailable: use "unknown" for commit/branch
    - Examples:
        - `.rpiv/artifacts/handoffs/2025-01-08_13-55-22_create-context-compaction.md`

### 2. Handoff writing.
using the above conventions, write your document. use the defined filepath, and the following YAML frontmatter pattern. Use the metadata gathered in step 1, Structure the document with YAML frontmatter followed by content:

Use the following template structure:
```markdown
---
date: {Current date and time with timezone in ISO format}
author: {Author name from artifact status}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
topic: "{Feature/Task Name} {Work Type}" # Customize work type: Implementation Strategy, Bug Fix, Research, Feature Implementation, etc.
tags: [implementation, strategy, relevant-component-names]
status: complete
last_updated: {Same ISO timestamp as `date:` above}
last_updated_by: {Author name}
type: {work_type} # Options: implementation_strategy, bug_fix, research, refactoring, feature_development, etc.
---

# Handoff: {very concise description}

## Task(s)
{description of the task(s) that you were working on, along with the status of each (completed, work in progress, planned/discussed). If you are working on an implementation plan, make sure to call out which phase you are on. Make sure to reference the plan document and/or research document(s) you are working from that were provided to you at the beginning of the session, if applicable.}

## Critical References
{List any critical specification documents, architectural decisions, or design docs that must be followed. Include only 2-3 most important file paths. Leave blank if none.}

## Recent changes
{describe recent changes made to the codebase that you made in file:line syntax}

## Learnings
{describe important things that you learned - e.g. patterns, root causes of bugs, or other important pieces of information someone that is picking up your work after you should know. consider listing explicit file paths.}

## Artifacts
{ an exhaustive list of artifacts you produced or updated as filepaths and/or file:line references - e.g. paths to feature documents, implementation plans, etc that should be read in order to resume your work.}

## Action Items & Next Steps
{ a list of action items and next steps for the next agent to accomplish based on your tasks and their statuses}

## Other Notes
{ other notes, references, or useful information - e.g. where relevant sections of the codebase are, where relevant documents are, or other important things you learned that you want to pass on but that don't fall into the above categories}
```
---

### 3. Approve
Save the document.

Once this is completed, you should respond to the user with the template between <template_response></template_response> XML tags. do NOT include the tags in your response.

<template_response>
Handoff written to:
`.rpiv/artifacts/handoffs/YYYY-MM-DD_HH-MM-SS_description.md`

Replace the path below with your actual handoff file path before running.

---

💬 Follow-up: describe extra context in chat to append to this handoff before chaining; re-run `/skill:create-handoff` for a fresh handoff document.

**Next step:** `/skill:resume-handoff .rpiv/artifacts/handoffs/YYYY-MM-DD_HH-MM-SS_description.md` — pick up where this session left off in a fresh context.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
</template_response>

---
## Additional Notes & Instructions
- **more information, not less**. This is a guideline that defines the minimum of what a handoff should be. Always feel free to include more information if necessary.
- **be thorough and precise**. include both top-level objectives, and lower-level details as necessary.
- **avoid excessive code snippets**. While a brief snippet to describe some key change is important, avoid large code blocks or diffs; do not include one unless it's necessary (e.g. pertains to an error you're debugging). Prefer using `/path/to/file.ext:line` references that an agent can follow later when it's ready, e.g. `packages/dashboard/src/app/dashboard/page.tsx:12-24`
