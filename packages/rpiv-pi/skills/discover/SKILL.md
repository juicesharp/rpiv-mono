---
name: discover
description: Interview the developer one question at a time to extract feature intent and requirements, then synthesize into a Feature Requirements Document at .rpiv/artifacts/discover/. The first question is intent-only and runs before any codebase probe; subsequent questions ground in evidence the probe surfaces. Use as the canonical entry point of the pipeline before research, or to stress-test a feature idea before codebase discovery. The FRD's Decisions block is consumed by `research` and propagates through Developer Context into `design`.
argument-hint: "[free-text feature description | existing artifact path]"
shell-timeout: 10
---

# Discover

You are tasked with extracting feature intent and requirements through a one-question-at-a-time interview, then writing a Feature Requirements Document (FRD) that downstream skills consume. Two principles shape the flow: (1) **intent before agents** — the foundational intent question runs before any probe, so stated intent shapes the probe scope; (2) **lazy + confirm** — build the decision tree one layer at a time, and surface evidence-based pre-resolutions for confirmation rather than silently recording them.

## Input

`$ARGUMENTS` — free-text feature description, or path to an existing FRD / ticket / doc for refinement.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

- `now.mjs` (line 1) — `<iso>\t<slug>` tab-separated.

Copy values verbatim — do not reformat the timezone offset.

## Flow

1. Input → 2. Intent question → 3. Codebase probe → 4. Lazy tree → 5. Interview loop → 6. Synthesize FRD → 7. Write artifact → 8. Follow-ups

The final artifact is research-compatible — its Decisions block is translated into research's Developer Context and inherited by design.

## Steps

### Step 1: Input Handling

1. **No argument provided**:
   ```
   I'll capture feature intent into an FRD. Provide one of:

   `/skill:discover [free-text feature description]`     — fresh interview, write a new FRD
   `/skill:discover [existing artifact path]`            — refine an existing FRD/ticket/doc via fresh interview
   ```
   Then wait for input.

2. **Detect input shape** — parse the input:
   - If the argument is an existing file path (resolves to a readable `.md` under `.rpiv/artifacts/`, or any path the user mentions for refinement context), read it FULLY using the Read tool WITHOUT limit/offset. Treat its content as baseline context — the interview surfaces gaps, missing requirements, and unstated assumptions relative to what's already documented.
   - Otherwise → fresh-feature mode: the entire argument is the free-text feature description.

3. **Read any other files mentioned** in the prompt (tickets, docs, related artifacts, explicit `path:line` references) FULLY before proceeding.

**No agent dispatch in Step 1.** Only `Read` on user-named paths. Agent grounding starts in Step 3, after stated intent has shaped the probe scope.

Each invocation always writes a NEW timestamp-distinct artifact (Step 7) — there is no in-place stress-test append mode. To iterate on a prior FRD, either re-invoke discover (produces a fresh artifact) or manually Edit the prior artifact.

### Step 2: Foundational Intent Question

Before any codebase probe, ask the foundational intent question. This is purely conversational — no agents, no recommendation, no `file:line` citations.

1. **Ask one open-ended `intent` question** via `ask_user_question`:
   - Frame: "What problem are you solving and who hits it?" / "What does success look like for the person experiencing this today?" — phrase it for the specific feature.
   - **No `(Recommended)` option.** The developer should generate the framing, not pick from a proposal.
   - **No `file:line` citations** — codebase has nothing to say about intent.
   - Options should be open shapes (e.g., "End user / maintainer / operator / Other") that route the answer, not solution shapes.
   - Always offer "Other" so the developer can free-text the real framing.

2. **Capture the answer in the developer's own words.** This text feeds into the FRD's Problem & Intent section verbatim — do not paraphrase into agent prose.

3. **Probe-readiness check**: does the stated intent support a *narrow* probe slice (one component, one seam)? If yes → proceed to Step 3. If no (answer is too vague, e.g., "I dunno, feels slow"), ask **one more `intent` question** to sharpen scope, then re-check. Step 2 ends on probe-readiness, not at fixed N=1. Cap: 3 `intent` questions before falling through to Step 3 with whatever scope you have.

### Step 3: Lightweight Codebase Probe (parallel agents, intent-shaped)

Goal: ground the upcoming interview in concrete codebase evidence, with the probe slice shaped by the developer's stated intent from Step 2 — not by the raw input text.

1. **Pick the agent set.** Dispatch `codebase-locator`, `codebase-analyzer`, or both — nothing else. Cap: 2 agents per Step 3 invocation.

2. **Spawn the chosen agent(s) in parallel using the Agent tool.** Draft each prompt yourself from the developer's stated intent — keep the slice narrow (one component, one seam) and avoid breadth phrasing like "everything related to X". Shape per call:
   ```
   Agent({
     subagent_type: "codebase-locator",   // or "codebase-analyzer"
     description: "<3-5 word task>",
     prompt: "<your narrow-slice prompt, scoped to stated intent>"
   })
   ```
   The agent description on each subagent is the contract for what it expects in the prompt body.

3. **Wait for ALL agents to complete before proceeding to Step 4.**

4. **Read any clearly-relevant files** surfaced by the agents (≤5 files in main context, files <300 lines fully, larger files first 150 lines). Carry the agent reports and these files into Step 4 as evidence.

5. **Empty results are not fatal.** If the probe returns thin/empty results (greenfield, no precedent), record "no codebase precedent" as evidence — `scope` interview questions still work (they don't need `file:line`), and `shape` questions will shift to ungrounded "pick A or B by convention" mode.

### Step 4: Lazy Tree Setup + Pre-Resolution Confirmation

Synthesize the **next layer** of questions internally before asking anything. Lazy expansion — build only root + immediate children at this stage, not the full tree. Each subsequent layer is built after its parent resolves.

1. **Build root + immediate children**:
   - **Root** — the developer's already-stated problem from Step 2.
   - **Immediate children** — the foundational unresolved branches: Goals/Non-Goals · Functional Requirements · Non-Functional Requirements (perf/security/UX/reliability) · Constraints · Acceptance Criteria · Recommended Approach.
   - Order branches by dependency (root → goals → constraints → solution shape → details). **This order drives the interview, not the FRD section order** — Step 6 redistributes answers into FRD sections.

2. **Mark evidence-based pre-resolutions** from Step 3 with `file:line` citations. Do NOT silently record them as Decisions yet.

3. **Batch-confirm pre-resolutions in a single `ask_user_question` call** before entering the interview loop. Frame each as: "From the probe I inferred — `<observed behavior>` (`file:line`). Keep this for the feature, or change it as part of the work?" The developer's confirm/correct is the actual Decision.

   - **Confirm** → record as Decision, rationale `evidence: file:line + confirmed`.
   - **Correct** → flip the Decision direction, schedule a Correction probe at Step 5 (≤1 additional agent on the new seam).

4. The lazy tree stays internal — do NOT present the tree to the developer unless asked.

### Step 5: Interview Loop

Walk the lazy tree depth-first, parent before child. Expand the next layer (build a node's children) only after the node resolves. For each unresolved node:

1. **Classify the question by tier**:
   - **`intent`** — already done in Step 2. Do not re-ask intent in this loop.
   - **`scope`** (goals · non-goals · functional reqs · non-functional reqs · constraints) — recommendation grounded in stated intent. `file:line` citations only when an option references existing code; otherwise state "no codebase precedent" in the option description.
   - **`shape`** (architectural choice — which seam, which pattern, which integration point) — frame **dialectically**: name the tradeoff axis, not a winner. Each option's `description` MUST state what it optimizes for AND what it sacrifices, in the form "optimizes <X>, loses <Y>" (or "optimizes <X>, costs <Y>"). The lead option still carries `(Recommended)` with a one-line rationale, but the framing forces the developer to pick a side of an explicit tension rather than rubber-stamp a winner. Generate at least 2 candidate options before scoring — never present a single option masquerading as a choice. `file:line` citations required on every option that references existing code. Mirrors the `packages/rpiv-pi/skills/research/SKILL.md:103-142` checkpoint pattern. If no precedent exists, switch to ungrounded mode and label options as "convention A / convention B" with explicit "no codebase precedent" — the dialectic framing (X vs Y tradeoff) still applies.

     **Anti-rescoping**: if the probe finds something that could substitute for the requested build (e.g., feature already exists but isn't wired up), surface as an `intent` question with `file:line` — never silently redirect. Offer both "use what's there" and "build as asked".
   - **`detail`** (acceptance criteria · routine sub-decisions inside any branch) — batchable when 2-4 sibling leaves are independent.

2. **Recommended answer** (`scope` / `shape` / `detail`): derive from intent + Step 3 evidence + project conventions. Every non-intent question carries a recommendation labeled `(Recommended)`.

3. **Ask via `ask_user_question`.** Lead with the recommended option. The "Other" option is automatic and handles open-ended answers.

4. **Critical rules**:
   - Ask ONE question at a time. Wait for the answer before asking the next.
   - If a new evidence-based node surfaces mid-loop, batch-confirm it the way Step 4 does — never silently auto-record.

5. **Classify each response**:
   - **Decision** ("yes, that recommendation is right" / "use option B"): Record in Decisions. Resolve the node. Expand its children if any. Continue.
   - **Correction** ("no, the real intent is X" / "you missed Y"): Re-run targeted Step 3 grep on the new area; spawn at most **1 additional narrow agent per correction event** if the correction reveals a seam not yet probed. Adjust the affected subtree. Re-ask any descendants that depend on the corrected node.
   - **Scope adjustment** ("skip the UI part" / "include retries"): Update the tree — prune pruned branches, add new branches if needed. Record in Decisions. **Scope-creep**: every Decision must trace to a branch under the Step 2 request. Related-but-unrequested observations ("X is also broken") go to **Suggested Follow-ups** or trigger a one-shot expand-scope? question — never silently into Decisions.
   - **Cross-cutting answer** ("we also need audit / rate limiting / X" — affects multiple branches): Mark the new node as cross-cutting and **re-queue** it. When the walk reaches each affected parent (functional / non-functional / constraints), the cross-cutter fires under that parent's context. Same node, multiple parents resolved sequentially.
   - **Defer** ("not sure, leave for later"): Add to Open Questions. Resolve the node by deferral. Continue.

6. **Batching**: When 2-4 sibling `detail` leaves are independent (answers don't depend on each other), you MAY batch them in a single `ask_user_question` call. Keep dependent questions sequential. Do not batch `scope` or `shape` questions.

7. **Termination — depth check, not bucket-fill**: stop the loop when:
   - (a) every branch has a Decision or a Deferral, AND
   - (b) the developer's own words appear in Problem/Goals (not paraphrased agent prose), AND
   - (c) no Decision is `Recommendation accepted` without at least one Rationale clause beyond `agreed`.

   Do not invent questions to pad the interview. Do NOT ask a final "looks good / want to adjust" rubber-stamp question — chain forward to research is automatic at Step 7.

**Total agent budget across the skill**: 2 (Step 3 initial probe) + N×1 (Step 5 corrections, typically 0-2) = 2-4 agent dispatches per FRD.

### Step 6: Synthesize FRD Body

Read `templates/frd.md` (relative to this skill folder) at runtime to confirm the section list and frontmatter shape — do not inline it from memory.

Compile interview output into the FRD. The interview's logical order (problem → goals → constraints → solution → details) is decoupled from the FRD's section order — redistribute answers into the template buckets here:

- **Summary** — 2-3 sentences capturing the settled feature concept.
- **Problem & Intent** — the developer's framing from Step 2, in their own words. Verbatim where possible.
- **Goals / Non-Goals** — explicit in/out lists from the interview.
- **Functional Requirements** — numbered, each independently testable.
- **Non-Functional Requirements** — perf, security, UX, accessibility, reliability constraints.
- **Constraints & Assumptions** — environmental, technical, schedule, organizational.
- **Acceptance Criteria** — observable pass conditions a reviewer can check. Each MUST name a concrete command, output, or visible behavior (e.g., "running `npm test` exits 0", "`/skill:X` writes `path/to/Y`"). Reject vague phrasing like "feature works correctly" or "UX is acceptable".
- **Recommended Approach** — 1-2 sentences naming the architectural shape implied by the decisions (e.g., "new command in `packages/rpiv-pi/extensions/`, output to stdout, no persistence"). This text is what `research` passes to `scope-tracer` as the topic for breadth grounding.
- **Decisions** — full Q/A log per decision: `### [title]` + `**Question**:` (text as asked, or "Pre-resolved from codebase evidence — confirmed in Step 4") + `**Recommended**:` (or "n/a — `intent` question") + `**Chosen**:` (developer's pick or evidence-derived answer) + `**Rationale**:` (1 line — why, or `evidence: path/to/file.ext:line + confirmed` for codebase-derived). This block is the inheritance hook into research's Developer Context.
- **Open Questions** — only items the developer explicitly deferred.
- **Suggested Follow-ups** — related-but-out-of-scope items surfaced during the probe or interview that the developer did NOT add to scope (per the Step 5 scope-creep guardrail). One line per item: what was observed and where (`file:line` when applicable). Omit the section entirely if empty.
- **References** — input files, mentioned tickets, related artifacts.

### Step 7: Write Artifact, Present, Chain

1. **Determine metadata** (from the Metadata block above):
   - Filename: `.rpiv/artifacts/discover/<slug>_<topic>.md` — `<slug>` is the second tab-separated field on `now.mjs` line 1; `<topic>` is a kebab-case slug from the settled feature concept.
   - `repository:` ← `repo:` label; `branch:` / `commit:` ← matching labels.
   - `date:` / `last_updated:` ← `<iso>` (first tab-separated field on `now.mjs` line 1, offset verbatim).
   - Interviewer: `author:` from the Metadata block (fallback: `unknown`).

2. **Write the FRD** using the Write tool. Frontmatter `status: complete`. All template sections present and filled. The Write tool creates parent directories automatically — no `mkdir -p` needed in the skill.

3. **Present and chain**:
   ```
   Intent captured to:
   `.rpiv/artifacts/discover/<YYYY-MM-DD_HH-MM-SS>_<topic>.md`

   {N} requirements, {M} decisions, {K} open questions.

   The FRD's Decisions block is translated into research's Developer Context and inherited by design.

   ---

   💬 Follow-up: discover writes a fresh FRD per call — re-invoke `/skill:discover` to iterate (the prior FRD stays unchanged on disk).

   **Next step:** `/skill:research .rpiv/artifacts/discover/<YYYY-MM-DD_HH-MM-SS>_<topic>.md` — ground the intent in codebase reality.

   > 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
   ```

### Step 8: Handle Follow-ups

- **Fresh artifact per call, no in-place append.** Discover deliberately writes a NEW timestamp-distinct FRD on every invocation — there is no `## Follow-up` append mode. The prior FRD stays unchanged on disk.
- **Iterate by re-invoking.** Re-run `/skill:discover [path-to-prior-FRD]` (or `/skill:discover <free-text>`) to produce a fresh FRD informed by the prior one.
- **No rubber-stamp question.** NEVER ask a final "looks good / want to adjust" question — chain forward to research is automatic at Step 7.
- **Manual edits are allowed.** If the developer wants a one-off correction without re-running the full interview, they can Edit the FRD directly — the skill does not own follow-up surface area beyond fresh-artifact-per-call.

## Important Notes

These reinforce the critical rules from the steps above — listed here so they don't get lost in step-body detail.

- **Always interview-first, intent-first**: Never write the FRD without running the interview loop. The `intent` question (Step 2) always precedes any agent dispatch — let stated intent shape the probe, not the other way around.
- **Always one question at a time**: Even with 2-4 batched independent `detail` leaves, that's still one `ask_user_question` call — wait for answers before asking the next round.
- **`intent` generates, `scope`/`shape`/`detail` reviews**: Intent is the developer's framing — they generate it. Scope, shape, and detail are proposals — they review them. The "developer reviews a proposal" model does not apply at the intent layer.
- **`file:line` is tier-conditional**: `intent` — never. `scope` — only when an option references existing code, otherwise label "no codebase precedent". `shape` — required on every option that references existing code; if no precedent exists, switch to ungrounded "convention A / convention B" mode. `detail` — same rule as `scope`.
- **Lazy tree, no full-tree pre-build**: Build only root + immediate children in Step 4. Expand each node's children only after the node resolves. Premature full-tree construction biases the dialogue.
- **Pre-resolutions confirm, never silently record**: Evidence-based nodes are batch-confirmed in Step 4 (or mid-loop if newly surfaced). The developer's confirm/correct is the actual Decision.
- **Cross-cutting answers re-queue, don't duplicate or drop**: When an answer affects multiple branches, mark the node cross-cutting and fire it under each affected parent during the walk.
- **Interview order ≠ FRD section order**: Walk the tree in dependency order (problem → goals → constraints → solution → details). Step 6 redistributes answers into FRD sections.
- **Light fan-out only**: Step 3 ≤2 agents (`codebase-locator` + optionally `codebase-analyzer`). Step 5 Corrections ≤1 additional agent per correction event. Breadth discovery (`scope-tracer`, broad sweeps, `integration-scanner`) belongs to `research` — chain forward instead of expanding scope here.
- **Never write or edit source files**: This skill produces an artifact only. Source-file changes are `implement`'s job, far downstream.
- **Fresh artifact every invocation**: Each `/skill:discover` call writes a NEW timestamp-distinct file. To iterate on a prior FRD, re-invoke or manually Edit the prior file.
- **Critical ordering** — follow the numbered steps exactly:
  - ALWAYS read mentioned files before any agent dispatch (Step 1 → Step 2)
  - ALWAYS ask the `intent` question before probing (Step 2 → Step 3)
  - ALWAYS shape the probe by stated intent, not the raw input text (Step 3)
  - ALWAYS batch-confirm pre-resolutions instead of silent auto-record (Step 4)
  - ALWAYS expand the tree lazily during the interview (Step 5)
  - ALWAYS re-queue cross-cutting answers under each affected parent (Step 5)
  - ALWAYS terminate on depth signal, not bucket-fill (Step 5)
  - ALWAYS synthesize from the interview log, never from memory of the conversation (Step 6)
  - NEVER skip the developer-facing interview — it's the entire point of this skill
  - NEVER ask a final "looks good / want to adjust" rubber-stamp question (anti-pattern per `a93e591`)
  - NEVER dispatch agents before Step 2's `intent` question is answered
