# skills/

## Monorepo Context
Lives inside `packages/rpiv-pi/`. Skills delegate to tools provided by sibling packages (the structured-question selector, todo tracker, web tools, etc.) — sibling source is at `../../<name>/`. New skill folders are picked up by Pi automatically via the `pi.skills: ["./skills"]` manifest field on Pi restart.

## Responsibility
User-invocable AI workflow definitions. Each `SKILL.md` is a structured prompt injected as system context when a user runs `/skill:<name>`. Skills own multi-step orchestration logic: research, design, planning, implementation, annotation, test generation. Mostly prompt engineering, with a small set of executable helper scripts (Node `.mjs`) in `_shared/` (cross-skill) and per-skill `_helpers/` that skills shell out to at runtime via `node "${SKILL_DIR}/../_shared/<name>.mjs"`.

## Dependencies
- **Pi framework**: reads `"skills": ["./skills"]` from `package.json`; injects SKILL.md body as system context on invocation
- **Sibling plugins**: provide the tools skills call (`ask_user_question`, `todo`, `advisor`, `web_search`/`web_fetch`, the `Agent` dispatcher)
- **`extensions/rpiv-core/`**: session-time scaffolding, guidance/git-context injection, bundled-agent sync; registers each skill's `contract:` frontmatter into the rpiv-workflow registry (`skill-contracts-source.ts`) and injects the session-start pipeline index (`pipeline-pointer.ts`)
- **`@juicesharp/rpiv-args`**: substitutes `$N`/`$ARGUMENTS`/`$@`/`${@:N[:L]}` placeholders in skill bodies before they reach the agent loop; on the token path it also emits the raw argument string in a `Skill input:`-labeled trailer after the skill block so supplied input is never misread as empty (issue #89)

## Consumers
- **Users**: `/skill:<name>` invokes the matching skill. Most pipeline-stage/fanout skills (18 of 27) declare `disable-model-invocation: true` (`code-review` and `commit` are stage-run yet stay model-visible) — hidden from the model's skill list, they run only on explicit invocation or workflow dispatch; a compact stage-command index injected at session start keeps them discoverable
- **Workflows**: chain wiring is framework-enforced — each skill's `contract:` produces/consumes block drives contract-driven routing, stage-compatibility validation, and outcome derivation; only human-facing trigger prose ("Always requires a [upstream] artifact") remains in `description`

## Module Structure
```
<skill-name>/SKILL.md             — One folder per skill. Folder name == frontmatter `name` == /skill:<name>.
<skill-name>/templates/           — Optional. Inter-skill contract: frontmatter fields and section names
                                    that downstream agents grep for. Read at runtime, never inlined.
<skill-name>/examples/            — Optional. Few-shot reference outputs. Cited by relative path with a
                                    "What makes this example good" annotation block.
<skill-name>/_helpers/            — Optional. Skill-private Node helpers (code-review's review-range.mjs, pr-triage's pr-fetch.mjs).
_shared/                          — Cross-skill Node helpers (now, git-changes, git-context, changelog-bootstrap,
                                    list-recent, slice-overlap, stitch-elaborations — that last run by the workflow
                                    host to fold per-phase elaborations back into the plan). Never inlined.
```

## SKILL.md Frontmatter Schema

```yaml
---
name: my-skill            # kebab-case; matches folder name; maps to /skill:my-skill
description: "What it does. Use when [trigger]."
argument-hint: "[what the user passes]"
allowed-tools: Bash(git *), Read, Glob, Grep   # restricts the tool set (may list Agent); omit to inherit everything
shell-timeout: 10         # seconds, for the body's shell blocks (rpiv-args; default 120s, 0 disables)
disable-model-invocation: true   # the norm (18/27) — most pipeline-stage/fanout skills; code-review, commit, and utility skills omit it
contract:                 # every skill declares one; produces/consumes drive routing + stage-compat validation
  produces: { kind: produces, meta: { artifactKind: slices }, data: { …JSON schema… } }
  consumes: { meta: { artifactKind: [research, slices] } }
---
```

`allowed-tools` is LLM-facing prompt context — Pi does not parse the field, but the agent reads its own declared allowlist and follows it by convention. **Skills that need the `Agent` tool either list `Agent` explicitly** (`annotate-guidance`, `annotate-inline`, `validate`) **or omit the field entirely** to inherit the full tool surface (`code-review`, `frontend-design`).

## Agent Dispatch Convention

At every `(parallel agents)` step, use simple prose — "Spawn the following agents in parallel using the Agent tool" — followed by per-agent `**Agent — <role>:**` blocks listing `subagent_type`, prompt, and any inputs. Close the section with an explicit sync barrier ("Wait for ALL agents to complete before proceeding"). The dispatching model emits one assistant message with N parallel `Agent` tool_use blocks; no literal call shape needs to appear in prose. **Never `run_in_background`** — a background completion can't re-drive a workflow session, so the skill ends its turn before writing the artifact and the stage fails.

Per-agent isolation comes from the agent's own `isolated: true` frontmatter (empty history, replaced system prompt, no inherited context/skills) — no caller-side flag is required.

## Skill Body Structure

```markdown
# Skill Title        ← H1 first — nothing precedes it

## Input             ← required-argument section; interactive skills wait, fanout skills "print an error and stop" (dispatch error)

[Workflow map]       ← bulleted step summary for multi-step skills

## Step 1: Name
1. Guard clause / bail-out first
2. Call `ask_user_question` tool for developer checkpoints (never prose "ask the user"):
   Question: "…", Header: "…", Options: ["Option A (Recommended)", "Option B"]

## Step 2: Spawn Agents (parallel agents)      ← "(parallel agents)" tag in heading
- subagent_type: `codebase-analyzer`
- Prompt: "…"
Wait for ALL agents to complete before proceeding.  ← explicit sync barrier

## Important Notes   ← last section: ALWAYS/NEVER ordering rules and prohibitions
```

## Fanout Skill Archetype

The `build` workflow's sliced flow added a second archetype — `design-slice`, `synthesize`, `grade`, `amend`, `elaborate`, plus `implement`'s single-phase fan-out lane. Conventions: single-pass with "No subagents. No self-review. No questions." (a downstream grade panel is the validation), flag-style arguments (`--dimension`, `--designs`, `--slices`, `--slice-verdicts`, `--upstream`), `disable-model-invocation: true`, and machine-consumed artifacts written to `.rpiv/artifacts/verdicts|elaborations|slices/`. Dispatched per-unit by the workflow host — "Use as a fanout unit, not standalone." Bookending the fanout: `slice` produces the map the fanout is cut from and is interactive in fresh mode (`ask_user_question` forks + confirm-before-write; only RE-SLICE mode is non-interactive), and `design-review` runs once as a single fan-in `ask_user_question` checkpoint — neither is dispatched per-unit.

## Architectural Boundaries
- **NO tool logic in SKILL.md** — skills describe workflows; extensions provide tools
- **NO template content inlined** — when `templates/` exists, the skill reads it at runtime; never copy it inline
- **Pipeline skills declare their chain in `contract:`** (produces/consumes) — `description` keeps only the human-facing trigger prose ("Always requires a [upstream] artifact")
- **Argument tokens are opt-in** — only present `$N`/`$ARGUMENTS`/`$@`/`${@:N[:L]}` if the skill needs them; without tokens, rpiv-args is byte-equivalent to Pi's built-in skill-block emitter

<important if="you are adding a new skill to this layer">
## Adding a New Skill
1. Create `<skill-name>/SKILL.md` with frontmatter: `name` (matches folder), `description`, `argument-hint`
2. Include `allowed-tools` only to restrict the tool set (list `Agent` in it if the skill dispatches agents); omit to inherit everything
3. If the skill requires an argument, add a `## Input` section after the H1 — interactive skills wait for the argument; fanout skills print an error and stop (dispatch error)
4. Multi-step skills: add a workflow map after the H1; use `## Step N:` headings
5. For parallel agent steps: append `(parallel agents)` to the heading; close with an explicit sync-barrier line
6. Developer checkpoints: use `ask_user_question` for 2-4 concrete options; `❓ Question:` free-text prefix for open-ended — one question at a time, wait for the answer before asking the next
7. Prohibitions and ordering rules go in `## Important Notes` as the final section
8. If the skill produces structured artifacts consumed downstream, create a `templates/` subfolder and cite it as a runtime read
9. If output quality benefits from concrete examples, create an `examples/` subfolder and cite each with a "What makes this example good" annotation block
10. Pipeline skills: declare a `contract:` block (produces/consumes) and `disable-model-invocation: true`; make the upstream artifact path the `argument-hint`
</important>
