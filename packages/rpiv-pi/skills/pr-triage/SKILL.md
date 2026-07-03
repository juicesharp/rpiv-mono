---
name: pr-triage
description: "Triage a GitHub pull request before committing review effort — fetch the PR thread (description, review comments, linked issues, CI status), assess the diff against whatever architecture/standards the target repo actually carries, and emit a triage disposition (Review · Request changes · Hold · Decline) with security tier and convention drift. Use when the user wants a PR sized up, asks 'should I review/merge this PR', or wants a recommended next step on an incoming PR. Produces triage documents in .rpiv/artifacts/triage/. Read-only — never checks out or mutates the working tree. Stack-agnostic: works in any language or framework, with or without architecture docs."
argument-hint: "[PR number | PR URL | empty = current branch]"
shell-timeout: 15
contract:
  produces:
    kind: produces
    meta:
      artifactKind: triage
    data:
      type: object
      required: [security_flag, blockers_count]
      properties:
        status:
          enum: [in-progress, ready]
        security_flag:
          type: integer
          minimum: 0
          maximum: 2
        blockers_count:
          type: integer
          minimum: 0
        risk:
          enum: [low, medium, high]
        convention_drift:
          enum: [none, local, structural]
  consumes:
    meta:
      world: github-pr
---

# PR Triage

Size up a pull request **before** spending review effort: read the PR thread, compare
the diff against whatever standard the target repo carries, and emit a routing verdict.
Triage **classifies and routes** — it does not adjudicate line by line (that's
`code-review`, which the routed workflow runs). Read-only: no checkout, no mutation.

Stack-agnostic by design. The skill hard-codes no language, build tool, directory
layout, or standards file — it discovers what the repo has and degrades to the code
itself when nothing richer exists.

## Input

`$ARGUMENTS` — a PR number (`128`), a PR URL, or empty (= the open PR of the current
branch). This value is substituted into the skill at render time; Step 1 reads it from
here directly — it is already the user's argument, not a raw token to re-parse.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

PR resolution (ref normalisation, current-branch fallback, fuzzy disambiguation) is
LLM-invoked at Step 1 via the bundled `_helpers/pr-fetch.mjs` — it depends on the
substituted Input and on conversational clarification, which render-time substitution
cannot capture.

## Flow

1. Resolve + fetch PR → 2. Discover standards → 3. Dispatch assessment agents →
4. Triage checkpoint → 5. Write artifact → 6. Present + recommend

**Read-only contract (load-bearing):** every agent is dispatched with read-only tools.
The skill MUST NOT `git checkout`, switch branches, or edit files — it reasons about the
PR diff as text fetched through `gh`. The security gate runs on fetched diff text
*before* any routed workflow touches the tree.

## Steps

### Step 1: Resolve the PR and Fetch the Thread

1. **Read the substituted Input above** and reduce it to a concrete spec the helper
   accepts — do not re-parse a raw token:

   | Input shape | Pass to helper |
   |---|---|
   | empty | `auto` (helper resolves the current branch's PR) |
   | integer / `#123` / a PR URL | the value verbatim |
   | prose / fuzzy ("the auth refactor PR") | do NOT pass it. First run `gh pr list --json number,title,headRefName,author`, present candidates via `ask_user_question` (one question; options = candidate titles + "restate"), then pass the chosen **number** verbatim. |

2. **Fetch via the bundled helper** with the concrete spec:

   ```bash
   node "${SKILL_DIR}/_helpers/pr-fetch.mjs" "<spec>"
   ```

   The helper shells `gh` and emits labelled key/value lines (`strategy:`, `pr_number:`,
   `title:`, `url:`, `head_ref:`, `head_owner:`, `head_label:`, `base_ref:`, `author:`,
   `files_changed:`, `additions:`, `deletions:`, `linked_issues:`, `ci_state:`,
   `ci_failing:`, `context_path:`, `patch_path:`) followed by a `---changed-files---`
   block. Read those as authoritative.
   It writes two files: `context_path:` — the prose PR context (description + linked
   issues + comments + reviews + diff) for the convention-drift and intent agents; and
   `patch_path:` — the raw unified diff alone, for the `diff-auditor` security scan. Hand
   each agent the right path in Step 3; never paste the raw thread.

3. **Branch on `strategy:`** —
   - `resolved` → continue.
   - `no-pr` → print the helper's `note:` and STOP. Do not write an artifact.
   - `no-gh` → print: `pr-triage needs the GitHub CLI: install gh and run 'gh auth login'.` and STOP.

### Step 2: Discover the Standards Source (stack-agnostic)

The standard a change is held to is **whatever the repo actually carries**. Walk from
each changed file (the `---changed-files---` block) up to the repo root and resolve the
strongest available source per touched module — first hit wins, but record all that
exist into a `StandardsMap`:

1. **Explicit architecture/convention docs** — any of: `ARCHITECTURE.md`,
   `CONTRIBUTING.md`, `docs/adr/**`, `AGENTS.md`, `CLAUDE.md`,
   `.rpiv/guidance/**/architecture.md`, or a repo-local conventions doc.
2. **Machine-enforced rules** — any linter/formatter/analyzer config present in the
   tree (`.editorconfig`, ESLint/Biome/Prettier, Ruff/Flake8/Black, Checkstyle/Spotless,
   golangci-lint, clippy/rustfmt, .NET analyzers, … — whatever the repo has).
3. **Peer code (universal floor)** — when neither of the above covers a module, the
   standard IS the surrounding code: the patterns, naming, and structure of sibling
   files in that module.

Emit `StandardsMap`: per touched module → `{ source: doc|linter|peer, ref }`. A module
resolving to `source: peer` is **normal, not a gap**. Record `no-standard` only when a
module has neither docs, linters, NOR readable peers (e.g. a brand-new top-level dir) —
a genuine coverage hole worth surfacing in the artifact.

### Step 3: Dispatch Assessment — Security · Convention Drift · Intent

Spawn ALL three in parallel at T=0 in a **single message with multiple Agent calls**,
read-only tools only, none checks out code. The **security** agent reads the raw patch
at `patch_path:` (it walks a unified diff file-by-file — its contract); the **convention
drift** and **intent** agents read the prose `context_path:` doc.

**Agent — Security** (`diff-auditor`, read-only). `diff-auditor` is a row-only patch
auditor: it emits one row per surface match and **assigns no severity and no summary** —
the SAFE/REVIEW/BLOCK tier is computed by the skill in Step 4 from these rows, NOT by the
agent. Give it the patch and the numbered sink surface-list:
  ```
  Walk the patch at <patch_path> file by file. Apply these numbered sink surfaces,
  matching the concept in whatever language the diff uses (no stack assumptions):

  1. Supply-chain — install/build hooks (post-install scripts, build-step network
     fetch), a new dependency from an untrusted/unpinned source, lockfile swap to an
     untrusted registry.
  2. Secrets — credential/key/token/PEM/connection-string material added in the diff.
  3. CI/CD poisoning — workflow/pipeline config that runs PR-controlled input with
     elevated scope or exposes long-lived secrets to fork PRs.
  4. Code execution / unsafe deserialization — shell/process spawn, eval/dynamic import,
     or a deserializer that can execute code, reachable from user-controlled input.
  5. Injection — user input concatenated into a query/command interpreted by an engine
     (SQL/NoSQL/LDAP/XPath/shell).
  6. Path traversal — user-controlled path into a filesystem API without normalization.
  7. SSRF — outbound request with user-controlled host or protocol.

  Output: one pipe-delimited row per match, per `diff-auditor`'s format —
    `file:line | verbatim line | surface-id | note`
  Put `confidence: N/10` (that the surface is real and user-reachable) in the note, and
  drop any hit below 8. Rows only — no tier, no summary, no recommendations.
  ```

**Agent — Convention drift** (`codebase-analyzer`, read-only):
  ```
  Read the PR context doc at <context_path>. StandardsMap (orchestrator-resolved):
  {paste StandardsMap — per module: source=doc|linter|peer + ref}

  For each module, Read its resolved standard (doc → the relevant section; linter →
  the config's enforced rules; peer → 2–3 sibling files in the module) and the diff's
  changes there. Emit one row per deviation:
    `file:line — \`<verbatim line>\` — standard cited (doc§ / linter-rule / peer file:line) — drift: local|structural`
  structural = the change crosses a boundary or breaks a pattern the RESOLVED STANDARD
  establishes; local = a contained convention slip. Name the violated concept in the
  module's own terms — no assumption of language, framework, or layout. A peer-sourced
  module with no readable siblings returns a single `no-standard` row. Evidence only.
  ```

**Agent — Intent vs. diff** (`codebase-analyzer`, read-only):
  ```
  Read the PR context doc at <context_path>. From the Description and Linked issues,
  enumerate the PR's STATED intent as checkable claims — things the AUTHOR said they
  would do. For each claim, cite whether the diff delivers it:
    `claim — file:line evidence | <absent>`
  Then flag scope creep: substantial diff changes not traceable to any stated claim.
  Return two short lists: (A) stated-but-undelivered, (B) delivered-but-unstated.

  A claim is something the author ASSERTED (in the description, a commit message, or the
  linked issue). Do NOT count ambient repo states — CI/build status, pre-existing test
  failures, lint output — as undelivered intent; they are observations, not claims, and
  belong in the artifact's Notes, not the intent tally. Evidence only. No checkout.
  ```

**Wait for all three** before Step 4.

### Step 4: Tally, Rank, Checkpoint

**1. Tally mechanically — count the agent rows ONCE, reuse the numbers verbatim** in the
artifact frontmatter and body (never re-count in prose; a recount drift is the failure
mode this step exists to prevent):
- `security_flag` — **derive the SAFE/REVIEW/BLOCK tier from the security agent's rows**
  (the agent emits rows only, no tier): **2 (BLOCK)** if any surviving row is surface
  1 / 3 / 4 (supply-chain, CI poisoning, code-exec / unsafe deserialization) at
  `confidence ≥ 8`; else **1 (REVIEW)** if any security rows remain; else **0 (SAFE)**
- `structural_count` = convention-drift rows tagged `drift: structural`
- `local_count` = convention-drift rows tagged `drift: local`
- `intent_undelivered` = stated-but-undelivered **claims** (NOT states — CI/build status and
  pre-existing failures are observations, not claims; they go to Notes, never this count)
- `scope_creep_count` = delivered-but-unstated items
- `blockers_count` = `structural_count + intent_undelivered` (minor `local` drift is NOT a blocker)
- `convention_drift` = `structural` if `structural_count > 0`, else `local` if `local_count > 0`, else `none`
- `fit` = `possibly-redundant` when a maintainer comment flags overlap/redundancy with existing
  functionality (common for a new top-level component from an outside contributor);
  `needs-scope-decision` when the change breaks a structural placement / naming / ownership or
  versioning convention (where and how it's packaged is in question); else `in-scope`

**2. Rank the Top Blockers.** From the structural-drift rows + undelivered-intent claims,
pick the 3–5 that actually drive the decision, most-decisive first. A **fit/scope** concern
(a new top-level component, an outside contributor, a maintainer comment flagging redundancy,
a structural convention break in naming / placement / ownership) ranks at the TOP even when it
isn't a single row — it is what the reader most needs. Minor (`local`) nits NEVER appear here.

**3. Checkpoint.** Run ONE developer checkpoint via `ask_user_question` (house
one-question-at-a-time rule). Present:
- the **security tier** (derived in step 1 from the agent's rows),
- the counts with **explicit arithmetic** — `{blockers_count} blockers ({structural_count}
  structural + {intent_undelivered} undelivered intent); {local_count} minor, non-blocking`.
  NEVER show structural / minor / blockers as a bare triple that looks like it should sum.
- the **Top Blockers** (ranked) and the **fit** judgment,
- the **recommended action** (below).

**Disposition options.** This is **initial triage**, a gate before review — the pipeline is
triage → review → merge, and triage never merges. The positive outcome is *proceed to review*,
never *approve* or *merge*. The next step is a plain action (open a review, send back to the
author, comment, close). The rpiv review workflow `vet` is the review stage (review → repair →
commit), the one optional mechanism a triage hands forward.

| Disposition (the option label) | When | Next step |
|---|---|---|
| **Review** | passes triage — security SAFE, in scope, no obvious pre-review blockers | proceed to review: open a code review, or `/wf vet "<pr-url>"` (the rpiv review → repair → commit loop) |
| **Request changes** | obvious blockers the author should fix before a full review is worthwhile (structural drift, undelivered intent) | open a Request-changes review with the blockers — back to the author |
| **Hold** | `fit` is `needs-scope-decision` / `possibly-redundant`; an open question must settle first | comment the scope question (with the redirect); don't review yet |
| **Decline** | out of scope / duplicate / superseded; not worth reviewing | close with the reason + where it belongs (relocate) |

`/wf vet` is offered only with **Review** — it is the review stage that follows an accepted triage.
The other dispositions are plain actions (back to the author, comment, close), no workflow.

**Recommend the FEASIBLE option** (the recommended one listed FIRST, marked `(recommended)`):
- **Decline** when the change clearly should not merge *here* (duplicate, out of scope, superseded).
  It is a settled "no", distinct from Hold's open question.
- **Hold** when `fit` is questionable (the change may not belong as-is).
- **ALWAYS pair Hold and Decline with a redirect** — the reason AND where it belongs (which existing
  capability, which repo, which issue). Never park or reject without a path.
- **Request changes** when there are obvious blockers the author should resolve before review.
- Otherwise **Review** — it passed triage; send it to the review stage. This is the positive
  outcome of triage; it does NOT mean "merge" (that comes after review).
- Offer the other dispositions too, but exactly ONE is recommended. Mark a clearly-wrong option
  `not recommended — {reason}`, the way a reviewer would.
- The security tier is NOT overridable — `BLOCK` halts regardless of the choice.

### Step 5: Write the Triage Document

1. **Fill the tally fields** from Step 4 — already computed, do NOT recount:
   - `security_flag` = 0 SAFE · 1 REVIEW · 2 BLOCK
   - `blockers_count`, `structural_count`, `local_count`, `intent_undelivered`,
     `scope_creep_count` = the Step 4 tallies, **verbatim** (the body's `({N})` headings
     and the Verdict counts read the same numbers)
   - `risk`, `convention_drift` = the display enums; `status: ready`
   - `head_label` = the helper's `head_label:` field (already qualified `owner:branch` for a
     cross-repo fork, so a same-named fork branch doesn't render as an ambiguous `main → main`)
   - the `## Verdict` **Gates** row takes the helper's `ci_state:` + `ci_failing:` and the
     security tier (machine-checkable gates, kept out of the human verdict; name the failing
     checks, not just "failing")
2. **Write the decision-first sections** (this is what makes the artifact actionable in
   under a minute):
   - `## Bottom line` — lead with the fit/crux judgment, then the **Recommendation** as a plain
     action (open a review / back to the author / comment the scope question / close), then the
     optional rpiv line (`/wf vet "<pr-url>"` — Review only), then a **Definition of done** line
     — the condition that flips the verdict (resolve N blockers → Review-ready; for Hold/Decline,
     the answer or redirect that settles it). Any `/wf` command uses the PR **URL** (`pr_url` /
     the helper's `url:`), never a bare `#number` — the URL resolves from a fresh session.
   - `## Top Blockers` — the Step 4 ranking, 3–5 items, crux first; never minor nits.
   - `## Convention Drift` — `### Structural` as full blocks; `### Minor` collapsed to ONE
     line per nit (never full blocks for `local` rows).
3. **Write once** with the Write tool (no Edit) to
   `.rpiv/artifacts/triage/<slug>_pr-<number>-<title-kebab>.md`, where `<slug>` is the
   **second** tab-separated field on line 1 of the Metadata block (the pre-built
   `<YYYY-MM-DD_HH-MM-SS>` slug) and `<title-kebab>` is the PR title kebab-cased.
   Read `templates/triage.md`, fill every `{placeholder}` from Steps 1–4, apply the
   section-omission rules below (delete the whole section AND its trailing `---` when its
   input is empty), strip the leading `<!-- -->` comment, and Write.

   **Section-omission:** drop `## Top Blockers` when there are none (SAFE + clean + intent
   delivered); within `## Convention Drift` drop `### Structural` / `### Minor` when its
   count is 0 (drop the whole section when both are 0); within `## Intent Gaps` drop
   `### Stated-but-undelivered` / `### Scope creep` when 0 (drop the whole section when both
   are 0); drop `## Unguided Modules` when every module resolved to a standard.

   On `security_flag == 2` (BLOCK): still write the artifact — the audit record matters —
   set `status: ready`, and make the BLOCK finding the lead of `## Security`.

### Step 6: Present + Recommend

```
Triage written to:
`.rpiv/artifacts/triage/{filename}.md`

PR:          #{number} — {title}  ({head_label} → {base_ref})
Bottom line: {the one-sentence crux/fit judgment}

Security:    {SAFE|REVIEW|BLOCK}
Blockers:    {blockers_count} ({structural_count} structural + {intent_undelivered} intent) · {local_count} minor, non-blocking
Intent:      {D} delivered · {intent_undelivered} undelivered · {scope_creep_count} scope-creep
CI:          {passing|failing|pending|none}

Recommendation: {Review|Request changes|Hold|Decline} — {one-line why, plain prose}
Next step:      {the action: open a review / back to the author / comment the scope question / close with a redirect}
                {optional rpiv, Review only: `/wf vet "{pr_url}"`}
                {BLOCK: STOP — resolve the security finding before any checkout}

> 🆕 Tip: start a fresh session with `/new` before chaining.
```

## Important Notes

### Guardrails — the agent MUST obey (the rest of the skill is the happy path)

- **ALWAYS read-only.** NEVER `git checkout`, switch branches, or Edit/Write source — reason
  about the diff as fetched text only. All three agents get read-only tools.
- **NEVER let an agent set the tier or the counts.** `diff-auditor` emits rows only; the skill
  derives `security_flag` and every count in Step 4.
- **ALWAYS count agent rows exactly once and reuse them verbatim.** NEVER re-count in prose — the
  frontmatter, headings, Verdict, and checkpoint read the same numbers.
- **NEVER count ambient states as findings.** CI/build status, pre-existing failures, lint output
  are observations → `## Notes`, NEVER the intent or blocker tally.
- **ALWAYS show blockers with explicit arithmetic** (`N = X structural + Y intent`). NEVER present
  structural / minor / blockers as a bare triple that looks like it should sum.
- **NEVER override the security tier.** Derive it honestly from the rows; do not soften a BLOCK.
  On a `BLOCK` (`security_flag: 2`) still write the artifact — the audit record matters.
- **ALWAYS write the artifact exactly once** with Write (NEVER Edit).
- **NEVER put minor (`local`) nits in `## Top Blockers`.**
- **ALWAYS use the PR URL in any `/wf` command, never a bare `#number`.** The URL resolves from a
  fresh session; a number does not. (`#number` is fine in display headings only.)
- **NEVER paste the raw PR thread into a prompt.** Hand each agent only its path — `patch_path` to
  security, `context_path` to drift/intent.
- **NEVER assume the target repo's stack.** No language, build-tool, package-manager, or layout
  assumptions — discover the standard (docs → linter → peer code) and fall back to peer code.

### Notes

- **Read-only is load-bearing**: no checkout, no branch switch, no Edit/Write to source.
  All three agents inherit read-only tool sets. The security gate runs on fetched diff
  text *before* the routed workflow ever touches the tree.
- **Standards are discovered, not assumed**: the skill never hard-codes a doc path or a
  stack. It resolves the strongest available standard per module — explicit docs →
  linter rules → peer code — and degrades to peer-code inference, which exists in every
  repo. `.rpiv/guidance/` is just one possible `doc` source among many, never a
  dependency.
- **Language/framework-agnostic**: convention and security findings name the *concept*
  the diff violates in the module's own terms. No assumption of TS/Node, a build tool,
  or a directory layout.
- **`security_flag` is the gate field**: an integer a downstream `gate(...)` consumer reads via
  `Number()`; a `BLOCK` (2) halts the run (the skill writes the artifact and stops regardless —
  it never checks out the tree). No built-in `/wf` workflow consumes it now that the built-in
  `pr-triage` graph has been removed; the consumer is a user-authored workflow or other downstream
  reader. The enums (`risk`, `convention_drift`) and the tally fields are display-only. Keep
  frontmatter fields verbatim — `artifacts-locator` greps them.
- **Triage gates; it does not review**: no per-line adjudication, no severity reconciliation, no
  verification pass — that's the review stage. Keep this skill cheap: three agents, one
  checkpoint, one write.
- **GitHub-coupled**: requires `gh` auth and an open PR. The helper degrades to
  `strategy: no-gh` / `no-pr` (never a shell error) so the skill body can stop cleanly.
- **Agent roles**:
  - `diff-auditor` ×1 (Step 3) — walks `patch_path` against the numbered sink surfaces;
    emits **rows only** (`file:line | verbatim | surface-id | note`, confidence in note).
    Per its contract it assigns no severity — the skill derives `security_flag` from the
    rows in Step 4.
  - `codebase-analyzer` ×1 (Step 3) — convention drift vs the resolved `StandardsMap`.
  - `codebase-analyzer` ×1 (Step 3) — intent-vs-diff + scope-creep check.
