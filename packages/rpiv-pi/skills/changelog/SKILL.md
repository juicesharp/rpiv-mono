---
name: changelog
description: Regenerate the [Unreleased] section of every affected CHANGELOG.md in Keep a Changelog style. Reads commits since the last release tag plus any uncommitted or staged changes, classifies them by Conventional Commit prefix, and rewrites each [Unreleased] block. Works in single-package repos and monorepos (one CHANGELOG.md per package). Use when preparing a release or drafting changelog entries. Idempotent — safe to re-run as work lands.
argument-hint: [--since <ref>]
allowed-tools: Bash(git *), Read, Edit
shell-timeout: 10
contract:
  produces:
    kind: side-effect
    meta:
      effect: changelog-edit
  consumes:
    meta:
      world: git-history
---

# Generate CHANGELOG entries

You are tasked with regenerating the `## [Unreleased]` section of every affected `CHANGELOG.md` in the repository so it reflects all change since the last release tag — committed and uncommitted alike.

## Input

`$ARGUMENTS` — optional `--since <ref>` flag. Empty/literal → range starts at `last_tag:` from the Metadata block.

## Metadata

```!
node "${SKILL_DIR}/../_shared/changelog-bootstrap.mjs"
```

- `in_repo:` — `yes` or `no`. Used by Step 1.1.
- `last_tag:` — last release tag, or `(no tags)`. Used by Step 1.3 and Step 2.1 when no `--since` is supplied.
- `---changelogs---` block — paths of every tracked `CHANGELOG.md` (one per line, empty if none). Used by Step 1.2.

## Workflow

1. Bail-out checks
2. Determine the change range
3. Determine each CHANGELOG's scope and collect commits + uncommitted hunks
4. Classify and draft entries
5. Preview and confirm
6. Apply

## Step 1: Bail-out checks

1. If `in_repo:` is `no`, tell the user "This directory is not a git repository." and stop.
2. If the `---changelogs---` block is empty, tell the user "No `CHANGELOG.md` found in the repository — create one (root or per-package) before running this skill." and stop.
3. If `last_tag:` is `(no tags)` AND `$ARGUMENTS` lacks `--since <ref>`, ask the user to supply `--since <ref>` and stop until they do.

## Step 2: Determine the change range

1. Parse the input for a `--since <ref>` flag. If absent, use `last_tag:` from the Metadata block as `SINCE`.
2. The range is `$SINCE..HEAD` for committed changes, plus the current uncommitted+staged working tree.

## Step 3: Determine each CHANGELOG's scope, then collect commits + uncommitted hunks

Each `CHANGELOG.md` discovered in Step 1.2 owns a path scope:

- **Nested CHANGELOG** (e.g. `packages/foo/CHANGELOG.md`, `apps/web/CHANGELOG.md`): scope is its parent directory — `packages/foo/`, `apps/web/`.
- **Root CHANGELOG** (`CHANGELOG.md` at repo root):
  - If no nested CHANGELOGs exist: scope is the entire repository.
  - If nested CHANGELOGs also exist: scope is the repository **excluding** every directory that owns a nested CHANGELOG. The root file captures repo-wide change (CI, build config, root README) that no per-package file would claim.

For each scope:

1. Committed: `git log $SINCE..HEAD --pretty=format:"%H%x09%s%x09%b%x1e" -- <scope>`. For root-with-exclusions, pass `:(exclude)<dir>` pathspecs for every nested-CHANGELOG directory. Records are `\x1e`-delimited; parse subject (`%s`) and body (`%b`).
2. Uncommitted: `git diff HEAD -- <scope>` and `git diff --cached -- <scope>` with the same pathspec rules. Treat the union as a single virtual "pending" change set with no commit message — the model classifies it from the diff itself.
3. Skip CHANGELOGs whose scope has no committed and no uncommitted changes in range.

## Step 4: Classify and draft entries

For each affected CHANGELOG, produce entries grouped under the Keep a Changelog 1.1.0 sections, in this order: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Performance`. Append a `Breaking / Upgrade Notes` section only when a breaking change exists.

### Conventional Commit → section mapping

- `feat:` → **Added**
- `fix:` → **Fixed**
- `perf:` → **Performance**
- `refactor:`, `style:`, `build:`, `ci:`, `chore:` → **Changed**
- `docs:` → **Changed** (only if user-facing docs; skip internal `thoughts/` or research notes)
- `test:` → omit (not user-visible)
- `revert:` → **Changed** (note what was reverted)

### Always-skip commits

Skip any commit whose subject matches one of these — they are release pipeline housekeeping, not user-visible change:

- `Release v<x.y.z>` or `chore(release): v<x.y.z>` (common release-bot patterns)
- `Add [Unreleased] section for next cycle`
- Version-only bumps with no other content (`<x.y.z>` as the entire subject)
- Merge commits with no diff content of their own

### Breaking change detection

Flag a commit as breaking if any of these are true:

- The type carries an exclamation suffix (`feat!:`, `refactor!:`, etc.)
- The commit body contains a `BREAKING CHANGE:` footer
- The diff removes or renames an exported symbol, removes a CLI flag, or removes a public file

For each breaking change, add an entry to **Breaking / Upgrade Notes** in addition to the regular section, written as a one-line upgrade instruction.

### Style rules — match Keep a Changelog 1.1.0 prose

- One short user-facing sentence per entry. Imperative mood ("Add", "Fix", "Remove").
- Write for the plugin's **users**, not its maintainers. No internal symbol names, file paths, regex literals, or precedent commit hashes inside entries.
- If a feature has a user-visible name (a slash command, a CLI flag, a skill name), name it in backticks. Example: `` Added `--locale` flag for per-invocation language override. ``
- Group entries by category, not by commit. Merge duplicate-topic commits into one entry.
- If a commit reverses something earlier in the same `[Unreleased]` window (e.g. add → remove → add-back), reflect only the net effect.
- Skip entries that have zero user-visible impact: dependency bumps with no behavior change, internal refactors invisible to users, test additions, type-only changes.

### Worked example

Input commits in `packages/api/`:

```
abc1234 feat(api): add /v2/search endpoint with cursor pagination
def5678 feat(api): support webhook retries with exponential backoff
ghi9abc fix(api): rotate session secret on every JWT refresh
jkl0def docs(api): document rate-limit headers in OpenAPI spec
mno1234 chore(deps): bump @types/node to 20.11
pqr5678 test(api): coverage for cursor edge cases
stu9abc refactor(api): inline httpClient factory (no behavior change)
```

Output `[Unreleased]`:

```markdown
## [Unreleased]

### Added
- `/v2/search` endpoint with cursor-based pagination.
- Webhook delivery retries with exponential backoff.

### Changed
- OpenAPI spec documents rate-limit response headers.

### Fixed
- JWT refresh rotates the session secret on every renewal.
```

What this example demonstrates:

- Two `feat:` commits → two **Added** entries (one per user-visible feature).
- `docs:` for a user-facing API spec → **Changed** (skip if the docs touched were internal notes).
- `fix:` → **Fixed**, written as the corrected behavior in imperative mood, not as the bug.
- `chore(deps):` with no behavior change → omitted.
- `test:` → omitted (not user-visible).
- `refactor:` flagged "no behavior change" → omitted (the rule is user-visible impact, not commit type).
- Commit hashes never appear in entries.

## Step 5: Preview and confirm

1. Print a per-CHANGELOG summary: file path, count by section, breaking-change flag.
2. Print the proposed `[Unreleased]` body for each affected CHANGELOG, in full.
3. Call `ask_user_question`:
   - Question: "Apply regenerated `[Unreleased]` to {N} CHANGELOG(s)?"
   - `Header` is capped at ≤16 characters (`MAX_HEADER_LENGTH = 16` — longer values are rejected).
   - Header: "Changelog"
   - Options:
     - "Apply (Recommended)" — Write the regenerated sections to disk. Refinement, if needed, happens afterward in normal chat (`Edit` tool) or via `git restore` to roll back.
     - "Show Preview" — For each affected CHANGELOG, render a unified diff between the **current** `[Unreleased]` body on disk and the **proposed** regenerated body. Lines marked `-` are about to be removed; lines marked `+` are about to be added. After printing, re-ask this same question.

## Step 6: Apply

For each affected CHANGELOG:

1. Read the file.
2. Locate the `## [Unreleased]` heading. The block runs from that heading up to (but not including) the next `## [` heading — or end of file if no later version exists. If no `## [Unreleased]` heading exists, insert one above the first `## [` heading (or after the file's intro prose if no version sections exist yet).
3. Use `Edit` to replace the entire block with `## [Unreleased]\n\n` followed by the regenerated sections.
4. **Never** touch any heading below `[Unreleased]`. Released version sections are immutable.

After all writes complete, print the list of modified files and remind the user to commit them before invoking their release pipeline — most release scripts require a clean working tree.

## Important Notes

- ALWAYS preview before writing. Never apply without the user's `ask_user_question` confirmation.
- ALWAYS replace the full `[Unreleased]` body, not append. The skill is idempotent regeneration, not accumulation.
- NEVER modify released version sections (anything below the first `## [x.y.z]` heading).
- NEVER write Conventional Commit prefixes (`feat:`, `fix:`, etc.) into the changelog body. They classify the entry; they don't appear in the prose.
- NEVER include commit hashes, PR numbers, or author names in entries. The audience is end users, not git archaeologists.
- NEVER pick or suggest a version number. The release pipeline owns the bump.
- NEVER invoke a release script from this skill. Authoring is a separate step from releasing.
- If a CHANGELOG has changes in the range but every commit is omit-worthy by the style rules (test-only, type-only, internal refactor), leave its `[Unreleased]` body empty — do not invent entries.
