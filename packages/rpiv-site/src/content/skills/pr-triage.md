---
slug: pr-triage
tagline: Read-only triage of an incoming GitHub PR — fetches the thread, weighs the diff against whatever standard the repo actually carries, and returns a disposition plus a security tier under `.rpiv/artifacts/triage/`.
purpose: |
  Sizes up a pull request *before* review effort is spent: three parallel read-only agents assess security surfaces, convention drift, and stated-intent-vs-diff, and the skill derives one routing verdict from their rows. Triage classifies and routes — it never adjudicates line by line (that is `code-review`) and never checks out or mutates the working tree.
when_to_use:
  - An incoming PR needs sizing up before anyone commits review time.
  - You want a recommended next step ("should I review / merge this?") rather than a line-by-line review.
  - You need a security tier on fetched diff text *before* anything touches the tree.
  - Skip it once a PR has passed triage — run `/wf vet "<pr-url>"` for the actual review pass.
inputs:
  - name: PR reference
    required: false
    source: A PR number (`128`), a PR URL, or empty
    notes: Empty resolves to the open PR of the current branch. Fuzzy prose ("the auth refactor PR") triggers a `gh pr list` disambiguation question first.
  - name: gh CLI
    required: true
    source: Authenticated GitHub CLI on PATH
    notes: "The bundled `_helpers/pr-fetch.mjs` degrades to `strategy: no-gh` / `no-pr` and stops cleanly rather than erroring."
outputs:
  - artifact: Triage document
    path: .rpiv/artifacts/triage/
    format: markdown — `security_flag` (0 SAFE · 1 REVIEW · 2 BLOCK), `blockers_count`, `risk`, `convention_drift` frontmatter over Bottom line / Top Blockers / Convention Drift sections
key_steps:
  - title: Resolve the PR and fetch the thread via `_helpers/pr-fetch.mjs`
    rationale: The helper shells `gh` and writes two files — a prose context doc and the raw patch — so each agent gets a path instead of the raw thread pasted into its prompt.
  - title: Discover the standards source per touched module
    rationale: The bar is whatever the repo actually carries — explicit docs, then linter config, then peer code as the universal floor. Nothing about the stack is hard-coded, so a `peer` resolution is normal rather than a gap.
  - title: Dispatch security, convention-drift, and intent agents in parallel
    rationale: One `diff-auditor` on the patch plus two `codebase-analyzer` passes on the context doc, all read-only, all at T=0. The security gate runs on fetched diff text before any routed workflow touches the tree.
  - title: Tally the rows once, rank the top blockers, run one checkpoint
    rationale: The skill — never an agent — derives the SAFE/REVIEW/BLOCK tier and every count, then reuses them verbatim so frontmatter, headings, and prose can't drift apart. Blockers are always shown as explicit arithmetic (structural + undelivered intent).
  - title: Write the triage document once
    rationale: A single Write (never Edit) to `.rpiv/artifacts/triage/`, with empty sections dropped. A BLOCK still writes the artifact — the audit record matters.
  - title: Present the disposition and next step
    rationale: Review · Request changes · Hold · Decline, exactly one recommended, with Hold and Decline always paired with a redirect. `/wf vet "<pr-url>"` is offered only with Review; the security tier is not overridable.
related:
  upstream: []
  downstream: [code-review]
---
