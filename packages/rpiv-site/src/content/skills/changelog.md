---
slug: changelog
tagline: Regenerates the `[Unreleased]` section of every affected `CHANGELOG.md` from commits + uncommitted hunks, classified by Conventional Commit prefix. Monorepo-aware, idempotent.
purpose: |
  Keeps `[Unreleased]` blocks honest as work lands. `changelog` reads everything since the last release tag (committed and uncommitted), classifies by Conventional Commit prefix, and rewrites each affected `CHANGELOG.md`. Safe to re-run; results converge.
when_to_use:
  - Preparing a release and the `[Unreleased]` block is out of date.
  - You want a draft for review before a release script runs.
  - Skip when no `CHANGELOG.md` exists or no release tag has ever been cut.
inputs:
  - name: $ARGUMENTS (`--since <ref>`)
    required: false
    source: Range hint (defaults to `git describe --tags --abbrev=0`)
outputs:
  - artifact: Rewritten `[Unreleased]` block per affected `CHANGELOG.md`
    path: every tracked `CHANGELOG.md`
    format: Keep a Changelog 1.1.0
key_steps:
  - title: Bail-out checks
    rationale: Verifies git, at least one `CHANGELOG.md`, and at least one release tag. Stopping early on missing prerequisites prevents silent no-op runs.
  - title: Resolve scope per CHANGELOG
    rationale: Nested CHANGELOGs own their parent directory; root CHANGELOG owns the repo *minus* nested-CHANGELOG directories. Path-scoped `git log` keeps monorepo entries from bleeding across packages.
  - title: Collect committed + uncommitted hunks together
    rationale: A virtual "pending" change set is added alongside committed history so drafts reflect what's actually changing, not just what's already in `git log`.
  - title: Classify per Conventional Commit mapping
    rationale: "`feat:`→Added, `fix:`→Fixed, `perf:`→Performance, etc. Skips release-pipeline housekeeping and test-only commits so entries are user-visible."
  - title: Flag breaking changes
    rationale: "`!` suffix, `BREAKING CHANGE:` footer, or removed/renamed exports trigger an additional entry under `Breaking / Upgrade Notes`: a one-line upgrade instruction the release notes can reuse."
  - title: Preview and confirm before applying
    rationale: Diff is shown first so the developer can correct misclassifications cheaply. Apply step uses `Edit` so other sections of the file are never touched.
related:
  upstream: [commit, implement]
  downstream: []
---
