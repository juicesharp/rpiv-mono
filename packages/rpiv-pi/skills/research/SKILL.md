---
name: research
description: Answer structured research questions about a codebase using targeted parallel analysis agents, then synthesize findings into a research document in .rpiv/artifacts/research/. Internally dispatches the scope-tracer agent to formulate trace-quality research questions, then answers them. Use when the user wants in-depth research on a codebase area, asks to "research X", or needs answers to architecture or behavior questions before designing changes.
argument-hint: "[free-text research prompt]"
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: research
    data:
      type: object
      properties:
        status:
          enum: [in-progress, in-review, ready]
  consumes:
    meta:
      artifactKind: [frd]
---

# Research

You are tasked with answering structured research questions by spawning targeted analysis agents and synthesizing their findings into a comprehensive research document. This skill internally dispatches the `scope-tracer` agent to formulate trace-quality research questions, then answers them.

## Input

`$ARGUMENTS` — free-text research prompt, or a `.rpiv/artifacts/discover/*.md` path to chain from discover.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
echo
node "${SKILL_DIR}/../_shared/git-context.mjs"
```

Copy values verbatim — do not reformat the timezone offset.

## Flow

1. Input → 2. Dispatch agents → 3. Synthesize & checkpoint → 4. Write doc → 5. Present & chain → 6. Follow-ups

The final artifact feeds design or blueprint.

## Steps

### Step 1: Input Handling

1. **Argument is empty:**
   ```
   Please provide a free-text research prompt.
   ```
   Then wait for input.

2. **Detect chained discover artifact:** If the input includes a path matching `.rpiv/artifacts/discover/.*\.md`, read it FULLY using the Read tool (no limit/offset) before scope-tracer dispatch:
   - Translate each `### [Decision title]` block in the FRD's `## Decisions` section into a Developer Context entry: `**Q (discover: <Decision title>): <Question text>**` followed by `A: <Chosen text>`. Hold these entries in main context — they're recorded in the research artifact's Developer Context section in Step 4 (write document).
   - Use the FRD's `## Recommended Approach` text (1-2 sentences naming the architectural shape) as the topic body for the next sub-step's scope-tracer prompt. The full discover artifact path stays in the input so scope-tracer's "read mentioned files first" rule picks up the file naturally for additional context.
   - Carry the FRD's Open Questions forward verbatim into the research artifact's Open Questions section in Step 4.
   - If the input is plain free-text or includes a non-discover path, skip this sub-step and proceed directly to scope-tracer dispatch with the input as the topic.

3. **Dispatch the scope-tracer agent** to formulate trace-quality research questions for the user's topic:
   ```
   Agent({
     subagent_type: "scope-tracer",
     description: "trace scope",
     prompt: "$ARGUMENTS"
   })
   ```
   The agent reads any mentioned files, sweeps anchor terms via grep/find/ls, reads 5-10 key files for depth, then emits a Discovery Summary + 5-10 dense numbered questions inline in its final message. Nothing is written to disk.

4. **Parse the agent's final message** as the questions artifact body. Extract: Discovery Summary (3-5 sentence file-landscape overview), Questions (numbered dense 3-6 sentence paragraphs).

5. **Read key shared files** referenced across multiple questions into main context — especially shared utilities, type definitions, and integration points that multiple questions mention.

6. **Analyze question overlap for grouping:**
   - Parse all question paragraphs and extract file references from each
   - Identify questions that share 2+ file references — these are candidates for grouping
   - Group related questions together (2-3 questions per group max)
   - Questions with no significant file overlap remain standalone
   - Target: 3-6 agent dispatches total (grouped + standalone)

7. **Report scoped status:**
   ```
   [Scoped]: ran scope-tracer. {N} questions in {G} groups, {M} shared files.
   ```

### Step 2: Dispatch Analysis Agents

Spawn analysis agents using the Agent tool — all in a **single assistant message with multiple Agent calls** (concurrent, synchronous). **Never `run_in_background`**: its completion can't re-drive a workflow session, so the skill ends its turn before writing the document and the stage fails with no artifact.

**Default agent**: `codebase-analyzer` for all codebase questions. This agent has Read, Grep, Glob, LS — it can trace code paths, find patterns, and analyze integration points.

**Exception**: External surfaces — third-party APIs, SDKs, libraries, services, protocols, or wire formats — that the codebase doesn't already use → `web-search-researcher`. Trigger on the surface itself, not on whether the question text literally names "docs" or "API".

**Agent prompt — question-as-prompt:**

Each agent receives the dense question paragraph(s) directly as its prompt. The question IS the instruction.

For standalone questions (no grouping):
```
Research topic: {topic from frontmatter}

Answer the following research question thoroughly with file:line references. Read the files mentioned, trace the code paths described, and provide a complete analysis.

{Full dense question paragraph}

Provide your analysis with exact file:line references. Focus on DEPTH — trace the actual code, don't just locate it.
```

For grouped questions:
```
Research topic: {topic from frontmatter}

Answer the following related research questions thoroughly with file:line references. These questions share overlapping code paths — use your cross-question context to provide deeper, more connected analysis.

Question 1: {Full dense question paragraph}

Question 2: {Full dense question paragraph}

For each question, provide your analysis with exact file:line references. Note connections between the questions where the same code serves multiple roles. Focus on DEPTH — trace the actual code, don't just locate it.
```

**Precedent sweep (git-gated):**

When `commit` is available (not `no-commit`), spawn one `precedent-locator` agent alongside the question agents with prompt: "Find similar past changes involving {list key files from Discovery Summary}. Search git log for commits that touched these files, similar commit messages, and follow-up fixes. Research topic: {original query}."

Findings go into Precedents & Lessons. Otherwise skip and note "git history unavailable" there.

**Wait for ALL agents to complete** before proceeding.

### Step 3: Synthesize and Checkpoint

1. **Compile findings:**
   - Match each agent's response to the question(s) it answered
   - Cross-reference findings across questions — look for patterns, conflicts, and connections
   - Prioritize live codebase findings as primary source of truth
   - Use `.rpiv/artifacts/` findings as supplementary historical context
   - Include specific file paths and line numbers
   - Build Code References as jump-table entries for the planner, not narrative (file:startLine-endLine format)
   - No multi-line code blocks (>3 lines) — use file:line refs + prose. No implementation recipes — facts only.
   - No artifact summaries — link plans/designs in Historical Context, don't summarize their contents. Research describes current codebase state.

2. **Developer checkpoint — grounded questions one at a time:**

   Start with grounded questions referencing real findings with file:line evidence. Ask ONE question at a time, waiting for the answer before the next. Use a **❓ Question:** prefix. Each question must pull NEW information from the developer — not confirm what you already found:

   Every question MUST embed at least one `file:line` reference in the question text — not just in surrounding context. Examples:

   - "❓ Question: `src/events/orders.ts:45-67` has 3 event hooks but no error recovery path. Is there a retry mechanism elsewhere I'm not seeing?"
   - "❓ Question: Pattern-finder found manual mapping at `src/services/OrderService.ts:45` (8 uses) vs AutoMapper at `src/services/UserService.ts:12` (2 uses). Which should new code follow?"
   - "❓ Question: Precedent commit `abc123` required a follow-up fix at `src/handlers/key.ts:158` for connection leak. Should we account for that pattern in this design?"

   Anti-patterns — NEVER ask these:
   - "Is this research to understand X or prepare for Y?" — confirmatory, pulls zero new information
   - "Does this look correct?" / "Should I continue?" — asks developer to validate YOUR work instead of providing NEW context
   - Questions without `file:line` — if you can't ground it in code, it's not a research question

   **Question patterns by finding type:**

   - **Pattern conflict**: "Found 2 implementations of {X} — which is canonical?" with options citing `file:line` + occurrence count
   - **Scope boundary**: "Question {N} references files {A,B,C} but analysis shows {D} is the real integration point. Extend scope?" with yes/no + "describe what I missed"
   - **Priority override**: "Questions Q1 and Q2 have competing implications for {area}. Which is load-bearing?" with options
   - **Integration ambiguity**: "Found no connection between {X} and {Y}. Is there an indirect path?" — `ask_user_question`, "Other" carries the answer

   **Choosing question format:**

   - **`ask_user_question` tool** — when your question has 2-4 concrete options from code analysis (pattern conflicts, integration choices, scope boundaries, priority overrides). The user can always pick "Other" for free-text. Example:

     > Use the `ask_user_question` tool with the following question: "Found 2 patterns for retry logic — which is canonical?". Header: "Pattern". Options: "Event-sourced retry (Recommended)" (`src/events/orders.ts:45-67` — 3 hooks, matches precedent commit `abc123`); "Direct retry loop" (`src/services/OrderService.ts:112` — single use, no event traceability).

   - **Open-ended** (discovery, "what am I missing?", corrections) — still `ask_user_question`; offer your best 1-2 guesses and let "Other" carry the unpredictable answer.

   **Anti-pattern** — do NOT dump a verbose paragraph mixing analysis with a trailing question:

   ❌ "The premise inversion is load-bearing for prioritization — it means Site A is a no-op, and the real bloat only hits general-purpose dispatches. Given this, where is the bloat actually landing? Do your skills dispatch named bundled agents — in which case append-mode is irrelevant — or general-purpose — in which case it IS the dominant source?"

   ✅ Extract the 2 concrete options and call `ask_user_question`: "Where is the prompt bloat landing?". Header: "Bloat source". Options: "Named bundled agents (Recommended)" (Skills dispatch `codebase-analyzer` etc. — `prompt_mode: "replace"`, no parent inheritance); "General-purpose agent" (`default-agents.ts:11-28` — `promptMode: "append"`, inherits full parent prompt).

   **Batching**: When you have 2-4 independent questions (answers don't depend on each other), you MAY batch them in a single `ask_user_question` call. Keep dependent questions sequential.

   **CRITICAL**: Ask ONE question at a time. Wait for the answer before asking the next. Lead with your most significant finding.

3. **Present compiled scan** (under 30 lines):
   ```
   Task: {one-line summary}
   Scope: {N files across M layers, K integration points}

   {Layer name} — {key files and what they do}
   {Layer name} — {key files and what they do}
   Integration — {N inbound, M outbound, K wiring. Top concern if any}
   History — {N relevant docs. Key insight if any}

   Best template: {implementation to model after}
   Precedents — {N similar changes found. Top lesson if any}
   Inconsistencies: {count} found ({short names})
   ```

   Gate the write with `ask_user_question`. Question: "Scan complete — write the doc, or adjust first?". Header: "Research". Options: "Write the doc (Recommended)"; "Add an area"; "Correct a finding".

4. **Incorporate developer input:**

   Classify each response:

   **Corrections** (e.g., "skip the job scheduler", "use CreateProduct not GetUser"):
   - Incorporate directly into synthesis. Record in Developer Context.

   **New areas** (e.g., "you missed the events module"):
   - Spawn targeted rescan: **codebase-locator** + **codebase-analyzer** on the new area (max 2 agents).
   - Merge results into synthesis. Record in Developer Context.

   **Decisions** (e.g., "yes, hook into that event chain"):
   - Record in Developer Context. Remove corresponding item from Open Questions.

   **Scope/focus** (e.g., "focus on API layer, UI is out of scope"):
   - Record in Developer Context.

   After incorporating all input, proceed to Step 4.

### Step 4: Write Research Document

1. **Determine metadata** (from the Metadata block above):
   - Filename: `.rpiv/artifacts/research/<slug>_<topic>.md` — `<slug>` is the second tab-separated field on line 1 of the Metadata block above; `<topic>` is a brief kebab-case description.
   - `repository:` ← `repo:` label; `branch:` / `commit:` ← matching labels (already include `no-branch` / `no-commit` fallbacks).
   - `date:` / `last_updated:` ← `<iso>` (first tab-separated field on line 1 of the Metadata block above, offset verbatim).
   - Author: `author:` from the Metadata block (fallback: `unknown`).

2. **Write the research document** — this document is compressed context for a new session. Include everything the planner needs to make architectural decisions without re-researching:

   ```markdown
   ---
   date: {Current date and time with timezone in ISO format}
   author: {`author:` from Metadata block}
   commit: {Current commit hash}
   branch: {Current branch name}
   repository: {Repository name}
   topic: "{User's Research Topic}"
   tags: [research, codebase, relevant-component-names]
   status: ready
   last_updated: {Same ISO timestamp as `date:` above}
   last_updated_by: {`author:` from Metadata block}
   ---

   # Research: {User's Research Topic}

   ## Research Question
   {Original user query from questions artifact}

   ## Summary
   {High-level findings answering the user's question}

   ## Detailed Findings

   ### {Component/Area 1}
   - Finding with reference (`file.ext:line`)
   - Connection to other components
   - Implementation details

   ### {Component/Area 2}
   ...

   ## Code References
   - `path/to/file.py:123` — Description of what's there
   - `another/file.ts:45-67` — Description of the code block

   ## Integration Points
   {All connections to the researched area. Enumerate each consumer, dependency, and wiring point with file:line. Source from the questions artifact's Discovery Summary + new connections found by analysis agents.}

   ### Inbound References
   - `path/to/consumer.ext:line` — {What references the component and how}

   ### Outbound Dependencies
   - `path/to/dependency.ext:line` — {What the component depends on}

   ### Infrastructure Wiring
   - `path/to/config.ext:line` — {DI, routes, events, jobs, middleware}

   ## Architecture Insights
   {Patterns, conventions, and design decisions discovered}

   ## Precedents & Lessons
   {N} similar past changes analyzed.

   ### Precedent: {what was added/changed}
   **Commit(s)**: `hash` — "message" (YYYY-MM-DD)
   **Blast radius**: N files across M layers
     layer/ — what changed

   **Follow-up fixes**:
   - `hash` — "message" (date) — what went wrong

   **Lessons from docs**:
   - .rpiv/artifacts/path/to/doc.md — key lesson extracted

   **Takeaway**: {one sentence — what to watch out for}

   ### Composite Lessons
   - {Composite lesson 1 — most recurring pattern first, with relevant `commit hash` inline}
   - {Composite lesson 2}

   ## Historical Context (from `.rpiv/artifacts/`)
   {Links only — one line per doc, no summaries of their contents}
   - `.rpiv/artifacts/something.md` — {one-line description of what this doc covers}
   ## Developer Context
   **Q (`file.ext:line`): {Question grounded in specific code reference}**
   A: {Developer's answer}

   ## Related Research
   - {Links to other research documents}

   ## Open Questions
   {Only questions NOT resolved during checkpoint}
   ```

### Step 5: Present and Chain

```
Research document written to:
`.rpiv/artifacts/research/{filename}.md`

{N} questions answered, {M} findings across {K} files.

Please review and let me know if you have follow-up questions.

---

💬 Follow-up: describe the change in chat to append a timestamped Follow-up section to this artifact. Re-run `/skill:research` for a fresh artifact.

**Next step (choose one):**
- `/skill:design .rpiv/artifacts/research/{filename}.md` — iterative design with vertical-slice decomposition (produces design artifact for plan)
- `/skill:blueprint .rpiv/artifacts/research/{filename}.md` — lightweight fast path for smaller tasks; combined design + phased plan in one pass (produces implement-ready plan directly)

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

### Step 6: Handle Follow-ups

- **Append, never rewrite.** Edit the artifact to add a `## Follow-up Research {ISO 8601 timestamp}` section. Prior content stays immutable.
- **Bump frontmatter.** Update `last_updated` + `last_updated_by`; set `last_updated_note: "Added follow-up research for <brief description>"`.
- **Re-dispatch narrowly.** Spawn ≤1–2 fresh analysis agents scoped to the new question. Do NOT re-run the full skill.
- **When to re-invoke instead.** If scope changed materially (different feature surface, different research target), re-run `/skill:research` for a fresh artifact. The previous block's `Next step:` stays valid for the existing artifact.

## Important Notes

- **Analysis only**: This skill answers questions. Question formulation is delegated to the scope-tracer subagent at Step 1.
- **Single entry point**: Free-text research prompt. Argument substitution is handled by `rpiv-args`; scope-tracer runs in-band before analysis dispatch.
- **Chained from discover**: when the input includes a path to a `.rpiv/artifacts/discover/*.md` artifact, read it FULLY in Step 1 and translate each Decision into a `Q (discover: <title>) / A: <Chosen>` Developer Context entry. Pass the FRD's `Recommended Approach` text as the scope-tracer topic. Open Questions carry forward verbatim. The `argument-hint` stays free-text-only — discover artifact recognition is by path-mention, not by argument-hint widening.
- **Grouped dispatch**: Related questions are batched per agent based on file overlap. Default agent: codebase-analyzer. This reduces token waste from redundant file reads and lets agents build cross-question context.
- **Downstream compatible**: Research documents feed directly into design and plan — the same Code References / Integration Points / Architecture Insights sections they expect.
- **Agent-message parsing**: scope-tracer emits Discovery Summary + numbered Questions inline in its final assistant message; parse the agent's final-message text (no file write).
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS dispatch scope-tracer first (Step 1)
  - ALWAYS analyze question overlap for grouping (Step 1)
  - ALWAYS wait for all agents to complete (Step 2)
  - ALWAYS run developer checkpoint before writing (Step 3)
  - ALWAYS gather metadata before writing (Step 4)
  - NEVER write the document with placeholder values
- **Frontmatter consistency**: Always include frontmatter, use snake_case fields
