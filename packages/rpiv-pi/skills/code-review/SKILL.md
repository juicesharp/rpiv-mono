---
name: code-review
description: Three-pass parallel reviewer (quality, security, dependencies) with conditional advisor adjudication. Produces review documents in thoughts/shared/reviews/. Use when changes are ready for review.
argument-hint: [scope]
---

## Scope Source

If the user has not specified what to review, ask them before proceeding. Scope is one of: `commit` (latest commit), `staged`, `working`, a commit hash or `A..B` range, or a PR branch name. Their input will appear as a follow-up paragraph after this skill body.

# Code Review

You are tasked with reviewing changes across three parallel lenses — **Quality**, **Security**, **Dependencies** — and synthesising their findings with optional stronger-model adjudication into an actionable `thoughts/shared/reviews/` artifact.

**How it works**:
- Resolve scope and assemble the diff (Step 1)
- Phase-1 Discovery Map (Step 2 — one agent + orchestrator-side git work)
- Phase-2 three-lens review + precedents + conditional CVE lookup (Step 3 — parallel agents)
- Reconcile findings via advisor (if present) or inline dimension-sweep (Step 4)
- Grounded-questions developer checkpoint (Step 5)
- Write the review artifact (Step 6)
- Present and handle follow-ups (Steps 7–8)

## Step 1: Resolve Scope and Assemble the Diff

1. **Parse the scope argument** (follow-up paragraph or the skill's argument):
   - `commit` → `git diff HEAD~1 HEAD`
   - `staged` → `git diff --cached`
   - `working` → `git diff`
   - Commit hash `abc1234` → `git show abc1234`
   - Range `A..B` → `git diff A..B`
   - PR branch name → `git diff $(git merge-base main HEAD)..HEAD` (or the branch vs its base)

2. **Read the full diff FIRST** (orchestrator-side, before any agent dispatch):
   - `git diff --name-only [scope]` → `ChangedFiles` list
   - `git diff --stat [scope]` → size summary
   - `git diff -U0 [scope]` → hunk ranges for Phase-2 prompts (inline, don't dump to user)
   - `git log -1 --format="%s%n%n%b" [scope-ref]` → commit-message context when applicable

3. **Bail-out**: if `ChangedFiles` is empty, print `No changes in scope [scope]. Exiting.` and STOP. Do not write an artifact.

4. **Derive flags** (orchestrator-side, used in later steps):
   - `ManifestChanged` = ChangedFiles intersects {`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`} OR a `peerDependencies` field was touched.
   - `LockstepSelfReview` = repository root contains `scripts/sync-versions.js` AND every `packages/*/package.json` shares the same `version:` AND the diff touches `packages/*/package.json`.
   - `ReviewType` = one of `commit | pr | staged | working`.

## Step 2: Phase-1 Discovery Map (parallel agents)

Spawn ONE agent in parallel with orchestrator-side work:

**Agent — Integration map:**
- subagent_type: `integration-scanner`
- Prompt: "Map inbound references, outbound dependencies, and infrastructure wiring for the following changed files: [ChangedFiles, one per line]. Flag any auth-boundary crossings (middleware, guards, interceptors, authorize-style decorators) and config/DI/event registration touching these paths. Do NOT analyse code quality — connections only, in your standard output format."

While the agent runs, the orchestrator produces the rest of the Discovery Map inline from Step 1's data:
- `ChangedFiles`, `ManifestChanged`, `LockstepSelfReview`, `ReviewType`
- Hunk ranges per file (from `git diff -U0`)
- Commit-message context (if applicable)

**Wait for ALL agents to complete** before proceeding.

**Synthesize the Discovery Map** — a compact text block that Phase-2 agents receive verbatim as `Known Context`:

```
## Discovery Map

Review type: [ReviewType]
Scope: [scope argument]
Commit/range: [git ref]
Changed files ([N]):
  path/a.ts (+A -B)
  path/b.ts (+A -B)
Hunks:
  path/a.ts: L10-23, L45-60
  path/b.ts: L5-8
Manifest changed: [yes|no]
Lockstep self-review: [yes|no]
Auth-boundary crossings: [from integration-scanner output, file:line]
Inbound refs: [from integration-scanner output]
Outbound deps: [from integration-scanner output]
Wiring/config: [from integration-scanner output]
```

## Step 3: Phase-2 Three-Lens Review (parallel agents)

Spawn these agents in parallel using the Agent tool. Each receives the `## Discovery Map` block inline as `Known Context` above its task.

**Always spawn:**

**Quality lens:**
- subagent_type: `codebase-analyzer`
- Prompt:
  ```
  Known Context:
  [paste Discovery Map verbatim]

  Task: Trace data flow through each changed hunk. For every hunk, enumerate `file:line` observations in these buckets — do NOT classify severity, the orchestrator does:
  1. Logic-bug risks: missing validation, dropped error paths, off-by-one, null/undefined misses, incorrect branch ordering, forgotten return/await, state mutations without guards.
  2. Pattern divergence: where the hunk deviates from the surrounding file's existing style/structure (cite the nearby line the hunk broke from).
  3. Blast radius: any inbound reference in the Discovery Map that the hunk's behavior change could affect (`consumer.ext:line` + what changes for it).
  4. Test coverage gaps: any risk-bearing behavior the hunk introduces that has no adjacent test reference.

  Return evidence only. No recommendations.
  ```

**Security lens:**
- subagent_type: `codebase-analyzer`
- Prompt:
  ```
  Known Context:
  [paste Discovery Map verbatim]

  Task: Grep each changed hunk for the following sink patterns and list every match with `file:line` + surrounding 3 lines. Cross-reference the Discovery Map's Auth-boundary crossings.
  For each hit, additionally return `confidence: N/10` reflecting how certain you are that a user-controlled input can reach this sink under current deployment. Do NOT report hits with confidence < 8.
  - Command execution: `exec(`, `execSync(`, `execFile(`, `child_process`, `spawn(`
  - Dynamic evaluation: `eval(`, `new Function(`
  - SQL template-interpolation: multi-line `` `SELECT ... ${ ``, `` `INSERT ... ${ ``, `` `UPDATE ... ${ ``, `` `DELETE ... ${ ``
  - XSS sinks: `innerHTML =`, `dangerouslySetInnerHTML`, `document.write(`
  - Path traversal: string concatenation into `fs.readFile`, `fs.writeFile`, `path.join` with user input
  - SSRF: `fetch(`, `http.request(`, `axios(`, `got(` where HOST or PROTOCOL (not just path) is user-controlled
  - Secrets in diff: `api_key`, `secret`, `password`, `BEGIN PRIVATE KEY`, `.env` content literal
  - Missing auth guard: auth-boundary crossings (from Discovery Map) reaching a traced sink without an upstream guard

  Hard exclusions — do NOT report:
  - DOS / resource exhaustion / rate limiting / memory or CPU exhaustion
  - Missing hardening in isolation (no traced sink), lack of audit logs
  - Theoretical race conditions / timing attacks without a concrete reproducer
  - Log spoofing, prototype pollution, tabnabbing, open redirects, XS-Leaks, regex DOS, regex injection
  - Client-side-only authn/authz gaps (server is the authority)
  - XSS in React/Angular/tsx files unless via `dangerouslySetInnerHTML`, `bypassSecurityTrustHtml`, or equivalent
  - Findings whose sole source is an environment variable, CLI flag, or UUID (trusted in our threat model)
  - Findings in test-only files or `.ipynb` notebooks without a concrete untrusted-input path
  - Outdated-dependency CVEs (handled by the dependencies/CVE lens)

  For each hit, name the pattern and quote the line. Return evidence only. No CVE lookups — that is a separate agent.
  ```

**Dependencies lens:**
- subagent_type: `codebase-analyzer`
- Prompt (only when `ManifestChanged` is true; otherwise SKIP this lens and omit the `### Dependencies` H3 block from the artifact):
  ```
  Known Context:
  [paste Discovery Map verbatim]
  Lockstep self-review: [LockstepSelfReview yes|no]

  Task: Parse the diff of `package.json` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`. List:
  1. Added dependencies: `name@version` with `file:line`.
  2. Bumped dependencies: `name: old -> new` with `file:line`.
  3. Removed dependencies.
  4. `peerDependencies` changes.
  5. License field changes or additions in the lockfile.
  6. When Lockstep self-review is `yes`: flag only intra-monorepo version drift where a sibling pin diverges from the lockstep `version:` in `packages/*/package.json`. Treat `"*"` peer pins as intentional.
  7. When Lockstep self-review is `no`: flag any version-conflict between direct dep and lockfile resolution.

  Return evidence only. No CVE lookups — that is a separate agent.
  ```

**Precedents lens:**
- subagent_type: `precedent-locator`
- Prompt:
  ```
  Planned change: code review of [scope]. Changed files: [ChangedFiles].
  Find the most similar past changes that touched these files or files nearby. For each precedent, report the commit hash, blast radius, any follow-up fixes within 30 days, and the one-sentence takeaway. Distil composite lessons across all precedents.
  ```

**Conditional spawn** (only when `ManifestChanged` is true):

**CVE/advisory lens:**
- subagent_type: `web-search-researcher`
- Prompt:
  ```
  For each of the following dependency changes, look up known CVEs / GitHub Advisories / OSS Index entries in the target version. Return LINKS alongside findings. If a vulnerability exists, summarize severity (Critical / High / Moderate / Low), affected version range, and whether the bumped-to version is fixed.

  Dependencies to check:
  [name@version, one per line — extracted by orchestrator from the diff]
  ```

**Wait for ALL agents to complete** before proceeding.

## Step 4: Reconcile Findings

1. **Compile evidence** from every lens:
   - Quality evidence → classify each `file:line` observation into severity:
     - 🔴 Critical: traced flow contradiction (dropped error path, missing validation on a known sink, null-deref).
     - 🟡 Important: blast-radius × complexity-delta (hot path + new allocation, visible ABI change without migration).
     - 🔵 Suggestion: pattern divergence with a concrete nearby template.
     - 💭 Discussion: composite-lesson architecture concerns.
   - Security evidence → classify:
     - 🔴 sink hit with a CONCRETE user-reachable source→sink path traced through Discovery Map auth-boundary crossings. Reject any hit lacking an explicit trace.
     - 🟡 crypto-only concrete issues: weak hash in an auth/integrity role (MD5/SHA1), non-constant-time compare on secrets, hardcoded key material in diff. Do NOT use 🟡 for "missing hardening".
     - 🔵 pattern divergence from a secure example in the SAME file (cite the nearby secure `file:line`).
     - 💭 architectural question.
   - Dependencies evidence → classify:
     - 🔴 Known-exploitable CVE in a touched dep (Critical/High per advisory DB) OR lockstep-contract violation (would trip `scripts/sync-versions.js`).
     - 🟡 Moderate CVE, outdated major with a migration path, license incompatibility with the project license.
     - 🔵 Minor/transitive drift.
     - 💭 Architectural dep question.
   - Precedents → compile into a separate `## Precedents & Lessons` section orthogonal to per-lens findings. Composite lessons go at the bottom of that section.

2. **Probe advisor availability** — attempt a probe by checking whether `advisor` is in the active tool set (main-thread visibility). If yes, proceed to advisor path; otherwise take the inline path.

3. **Advisor path** (when advisor is active):
   - Print a main-thread `## Pre-Adjudication Findings` block first — the advisor reads `getBranch()`, so evidence must be flushed before the call.
   - Call `advisor()` (zero-param). If it returns usable prose, paste it verbatim into `## Advisor Adjudication` and skip the inline path. Otherwise fall through.

4. **Inline path** (advisor unavailable or errored):
   - Run a dimension-sweep modeled on `skills/design/SKILL.md:83-116`: Data model / API surface / Integration / Scope / Verification / Performance.
   - For every finding, ask: does another finding contradict this severity given the Discovery Map? If yes, note the tension.
   - Produce a short `## Reconciliation Notes` block inside the artifact capturing any severity moves and the rationale.

5. **Emit the reconciled severity map** — authoritative severity per finding, carrying the advisor's guidance when present. Keep the per-pass grouping (do NOT tag each finding with its originating lens in prose; the H2 it sits under is the tag).

## Step 5: Developer Checkpoint

Use the grounded-questions-one-at-a-time pattern. Every question must reference real findings with `file:line` evidence and pull a DECISION from the developer.

**Present a compiled scan first** (under 20 lines):

```
Review: [scope]
Files: [N]
Quality: [C🔴/I🟡/S🔵/D💭]
Security: [C/I/S/D]
Dependencies: [C/I/S/D | not-applicable]
Precedents: [N composite lessons, top: "[one-line]"]
Advisor: [adjudicated | inline]
```

Wait for the developer's response. Then ask **one question at a time**, waiting for each answer.

**Question patterns:**

- **Severity dispute**: Only ask when the advisor re-ranked a finding or when inline reconciliation surfaced a contradiction. Use `ask_user_question` — Options: "Keep [original severity] (Recommended)" / "Downgrade" / "Escalate" — with `file:line` evidence in the description.
- **Scope ambiguity**: "❓ Question: finding at `file:line` lies in a test helper — does the team count test-only issues? Include in artifact or not?"
- **False-positive confirmation**: Only ask when a security/dep finding hinges on context the orchestrator cannot see (e.g., `exec()` with a variable that the developer might know is constant).

**Critical rules:**
- Ask ONE question at a time. Wait before asking the next.
- Lead with the most load-bearing finding.
- Skip the checkpoint entirely if no disputes surfaced and the developer set `status: approved` in the scan response.

## Step 6: Write the Review Document

1. **Determine metadata**:
   - Filename: `thoughts/shared/reviews/YYYY-MM-DD_HH-MM-SS_[scope-kebab].md`
   - Repository: git root basename (fallback: cwd basename).
   - Branch + commit: from git-context injected at session start, or `git branch --show-current` / `git rev-parse --short HEAD` (fallback: `no-branch` / `no-commit`).
   - Reviewer: user from injected git-context (fallback: `unknown`).

2. **Write the artifact** using the Write tool (no Edit — this skill writes once per run):

```markdown
---
date: [ISO 8601 with timezone]
reviewer: [User]
repository: [Repo name]
branch: [Branch]
commit: [Short hash]
review_type: [commit|pr|staged|working]
scope: "[What was reviewed]"
critical_issues: [Count across all lenses]
important_issues: [Count]
suggestions: [Count]
status: [approved|needs_changes|requesting_changes]
tags: [code-review, relevant-components]
last_updated: [YYYY-MM-DD]
last_updated_by: [User]
---

# Code Review: [Scope Description]

**Date**: [full ISO date]
**Reviewer**: [User]
**Repository**: [Repo]
**Branch**: [Branch]
**Commit**: [Short hash]

## Review Summary
[3–5 sentences: overall verdict, highest-severity finding per lens, advisor outcome.]

## Issues Found

### Quality
#### 🔴 Critical
- `file:line` — [evidence + one-sentence fix pointer]
#### 🟡 Important
- `file:line` — [evidence + fix pointer]
#### 🔵 Suggestions
- `file:line` — [nearby template reference + suggested alignment]
#### 💭 Discussion
- `file:line` — [open question or trade-off]

### Security
#### 🔴 Critical
- `file:line` — [sink quoted + exploitability rationale referencing auth-boundary from Discovery Map]
#### 🟡 Important
- `file:line` — [missing hardening + secure precedent]
#### 🔵 Suggestions
- `file:line` — [pattern divergence from secure example]
#### 💭 Discussion
- `file:line` — [architectural question]

### Dependencies
(Omit this H3 block entirely when the Dependencies lens was skipped — i.e., `ManifestChanged` was false.)
#### 🔴 Critical
- `dep@ver` (`package.json:line`) — [CVE id + link + affected-range + fix version]
#### 🟡 Important
- `dep@ver` — [moderate CVE / license / lockstep note with link]
#### 🔵 Suggestions
- `dep@ver` — [minor/transitive drift]
#### 💭 Discussion
- `dep@ver` — [architectural dep question]

## Precedents & Lessons
- `commit hash` — [precedent + one-sentence takeaway]
- Composite lessons (most-recurring first):
  1. [lesson 1]
  2. [lesson 2]

## Pattern Analysis
[How changes align with or diverge from existing patterns in the changed files. Cite `file:line` of the nearest established pattern.]

## Impact Assessment
[Files and inbound refs affected per the Discovery Map. Enumerate each affected consumer with `file:line` and what changes for it.]

## Historical Context
[Links to thoughts/ docs referenced by precedent-locator; one line each, no summaries.]

## Advisor Adjudication
(Omit this H2 entirely when the advisor did not run — its presence IS the signal that adjudication occurred.)
[Advisor model prose pasted VERBATIM. Do not edit or paraphrase.]

## Reconciliation Notes
(Include only when the inline path ran, OR when developer dispute in Step 5 moved a severity.)
[Short prose: which findings shifted severity and why.]

## Recommendation
[Clear verdict: Approved / Needs Changes / Requesting Changes. Cite the top 1–3 items that drove the verdict with `file:line`.]
```

## Step 7: Present and Chain

```
Review written to:
`thoughts/shared/reviews/[filename].md`

[C] critical, [I] important, [S] suggestions across [Q] quality, [Se] security, [D] dependency issues.
Advisor: [adjudicated | inline]
Status: [verdict]

Top items:
1. `file:line` — [headline]
2. `file:line` — [headline]
3. `file:line` — [headline]

Ask follow-ups, or run `/skill:revise` to address the findings.
```

## Step 8: Handle Follow-ups

- If the user asks for deeper analysis of a specific finding, spawn a targeted `codebase-analyzer` on that area (1 agent max) and append a `## Follow-up [timestamp]` section using the Edit tool.
- Update frontmatter: `last_updated`, `last_updated_by`, and `last_updated_note: "Appended follow-up on [area]"`.
- Never rewrite prior findings; only append.

## Important Notes

- **No tool-permission widening**: `allowed-tools` is intentionally omitted — the skill inherits `Agent`, `ask_user_question`, `advisor`, `Write`, `web_search`, `todo` per `.rpiv/guidance/skills/architecture.md:40`. Do NOT re-add the line.
- **Always use parallel Agent tool calls** in Phase-2 to maximise efficiency.
- **Always read the full diff FIRST** (Step 1) before spawning any Phase-1 or Phase-2 agent.
- **Always pass the Discovery Map inline** as `Known Context` to every Phase-2 agent — agents are `isolated: true` and cannot see sibling transcripts.
- **Security-lens precision stance**: prefer false negatives over false positives. Security evidence must carry `confidence ≥ 8` and 🔴 requires an explicit source→sink trace. Missing hardening without a traced sink is NOT a finding. Keep the Security-lens exclusion list in sync with the reference FP-filter precedents.
- **Critical ordering**: Follow the numbered steps exactly.
  - ALWAYS resolve scope and bail on empty diff (Step 1) before Phase-1.
  - ALWAYS wait for Phase-1 completion before Phase-2 dispatch.
  - ALWAYS wait for ALL Phase-2 agents to complete before reconciliation (Step 4).
  - ALWAYS probe advisor availability before calling `advisor()` (strip-when-unconfigured at `packages/rpiv-advisor/advisor.ts:463-472`).
  - ALWAYS emit the `## Pre-Adjudication Findings` block to the main branch BEFORE calling `advisor()` — the advisor reads `getBranch()` (main-thread-only at `packages/rpiv-advisor/advisor.ts:336`) and will not see evidence you did not flush.
  - ALWAYS preserve the severity taxonomy emoji + naming (🔴 Critical / 🟡 Important / 🔵 Suggestions / 💭 Discussion) and the existing frontmatter keys verbatim — discovery agents `thoughts-locator` and `thoughts-analyzer` grep these.
  - NEVER call `advisor()` from inside a sub-agent — its branch is invisible to the advisor.
  - NEVER parse advisor prose mechanically — paste verbatim into `## Advisor Adjudication`.
  - NEVER add a new bundled agent to support this skill — zero-new-agents contract per `packages/rpiv-pi/extensions/rpiv-core/agents.ts:148-268` sync cost.
- **Severity classification**:
  - Evidence from agents justifies each issue's severity.
  - Every finding carries a `file:line`.
  - Correct-pattern examples cited where available.
  - Fixes are concrete (pointer, not vague).
- **Agent roles (for this skill)**:
  - `integration-scanner` (Phase-1): inbound refs, outbound deps, auth-boundary crossings.
  - `codebase-analyzer` × 3 (Phase-2): one per lens — evidence-only, no recommendations (honors the guardrail at `packages/rpiv-pi/agents/codebase-analyzer.md:113-119`).
  - `precedent-locator` (Phase-2, always): git history + thoughts/ for lessons.
  - `web-search-researcher` (Phase-2, conditional on `ManifestChanged`): CVE / GitHub Advisory / OSS Index lookups with LINKS.
- **File reading**: read the diff FULLY (no limit/offset) via `git` commands before spawning agents. Let agents read their scoped targets; the orchestrator does not need to read source files for non-risk findings.
- CC auto-loads CLAUDE.md files when agents read files in a directory — no need to scan for them explicitly.
