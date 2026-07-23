# rpiv-args

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. Listed in `siblings.ts`; peer-pinned by `rpiv-pi` as `"*"`.

## Responsibility
Three-hook extension that hardens Pi's `/skill:<name> <args>` invocation surface against LLM attention drift:
1. **`input`** — pre-empts Pi's built-in skill-block expansion. Runs a four-stage body pipeline, then wraps the result in a `<skill name=… location=…>…</skill>` block matching Pi's downstream `parseSkillBlock` regex. Pipeline: **opt-in** `$N`/`$ARGUMENTS`/`$@`/`${@:N[:L]}` substitution (gated on body-token presence) → **always-on** `${SKILL_DIR}`/`${SESSION_ID}` variable substitution → **always-on** inline (`` !`cmd` ``) and block (` ```!…``` `) shell execution → wrap. Emits via `{action:"transform", text}`. The wrapper is byte-exact against Pi's regex; the suffix policy diverges — see "Byte-Exact Wrapper Format" and "System-Prompt Protocol & Token-Path Divergence".
2. **`before_agent_start`** — prepends a skill-invocation protocol to the system prompt every turn so the LLM treats trailing text after `</skill>` as the skill's argument input rather than a separate imperative. Read-then-prepend pattern preserves chaining with other extensions.
3. **`session_start`** — invalidates the in-memory skill-path cache on `reload`/`startup` reasons so subsequent invocations see a fresh skill set.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI` (incl. `pi.exec` for shell), input/before-agent-start event types, frontmatter helpers (`parseFrontmatter`/`stripFrontmatter`), and the output-truncation surface (`truncateTail`, `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `ExecResult`, `TruncationResult`)
- No `pi-ai`, `pi-tui`, `typebox` — no models, no UI, no tools. It DOES run shell (`pi.exec`) and truncate output for the LLM budget

## Consumers
- **Pi extension host** loads via `pi.extensions: ["./index.ts"]`; **Pi (interactive mode)** consumes the emitted `<skill …>` wrapper via `parseSkillBlock` — byte-exact match is required for round-trip
- **`rpiv-pi`** lists it in `peerDependencies` and `siblings.ts`; its lane transcript strips the token-path `Skill input:` trailer back to raw args for display (`packages/rpiv-pi/extensions/rpiv-core/lane-transcript.ts:112`), and **`rpiv-warp`**'s toast summarizer strips the same trailer (`packages/rpiv-warp/payload.ts:103`) — both via a literal regex on the label text, NOT an import (zero-cross-imports holds)

## Module Structure
```
.  — Flat package. index.ts is a thin default-export shim; args.ts owns all, grouped by concern:
     parse/substitute — parseCommandArgs, substituteArgs ($N/$ARGUMENTS), substituteVariables (${SKILL_DIR}/${SESSION_ID})
     shell           — resolveShellTimeoutMs, runOneShellCommand, truncateForLLM, formatShellOutput, executeShellInBody (block→inline mask-and-restore)
     skill-index     — build/get/invalidateSkillIndex (exported reset for tests)
     emit/handlers   — buildSkillBlock, appendArgs/appendSkillInput (exports SKILL_INPUT_LABEL), handleInput pipeline, registerArgsHandler, SKILL_INVOCATION_PROTOCOL+handleBeforeAgentStart
```

## Interception Contract
The `input` hook is the only Pi event that fires BEFORE the built-in skill-command expander. `hadTokens = TOKEN_REGEX.test(body)` is captured BEFORE any substitution and gates ONLY the `$N`/`$ARGUMENTS` pass and the suffix format (branch 2 vs 3); `substituteVariables` and `executeShellInBody` run on BOTH known-skill paths regardless of `hadTokens`. Four dispatch branches:
1. Text starts with `<skill ` → **pass through**. Guards against the extension's own already-wrapped output and any other extension's `{action:"transform"}` upstream
2. Known skill, body has a placeholder token (`hadTokens`) → **`$N`/`$ARGUMENTS` substitute, wrap, append a `\n\nSkill input: ${args}` labeled trailer** carrying the RAW args (`appendSkillInput`; empty args → no trailer — see "System-Prompt Protocol & Token-Path Divergence")
3. Known skill, body has no tokens → **wrap with `\n\n${args}` suffix**, byte-identical to Pi's built-in `_expandSkillCommand`
4. Everything else → pass through (unknown skill, file read failure, non-skill input)

## Byte-Exact Wrapper Format
The wrapper MUST satisfy Pi's downstream `parseSkillBlock` exactly — **no trailing newline inside `</skill>`**, **one** blank line between the opening line and the body; do not add or remove whitespace inside the block:
```
<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${body}
</skill>

${args}     ← suffix depends on emit path: bare vs `Skill input:`-labeled (below)
```

### Suffix policy
- **No-token path (branch 3)**: emit `\n\n${args}` after `</skill>` when args present — byte-identical to Pi's `_expandSkillCommand`; the only path args reach the LLM for placeholder-free skills.
- **Token path (branch 2)**: emit `\n\nSkill input: ${args}` after `</skill>` (`appendSkillInput`, `SKILL_INPUT_LABEL`) — the RAW argument string, labeled. Empty args emit NO trailer; skills' empty-input branches deliberately key off its absence. See next section for why substitution alone is not enough.

## System-Prompt Protocol & Token-Path Divergence
The `before_agent_start` hook prepends a `## Skill invocation protocol (CRITICAL)` block to the system prompt every turn. The protocol explicitly tells the LLM: text after `</skill>` is argument input to the skill, never a separate command; a `Skill input:` label there marks the raw argument string, and value occurrences substituted into body slots are this real user input, not example/placeholder text. Per-turn re-application is Pi's canonical pattern (`agent-session.js:864`/`:887` — each `prompt()` passes `_baseSystemPrompt` to `emitBeforeAgentStart`, then resets to it absent extension modification); same bytes every turn → prompt-cache hit after turn 1.

The token-path trailer (branch 2 above) is the structural complement. Substitution alone is not enough: it weaves the value into documentation-shaped body slots where models misread it as placeholder/example text and take the empty-input branch (issue #89). A BARE trailing suffix is not the answer either — trailing imperatives hijack LLM attention from the skill body (originally observed with `/skill:discover write a file ...` where the LLM acted on "write a file" instead of running discover's interview workflow). The `Skill input:`-labeled trailer is the deliberate middle ground: an unambiguous argument signal that does not read as a standalone command. Prose label, NOT an XML wrapper — Pi's interactive renderer shows post-`</skill>` text verbatim in a user-message box, so raw tags would leak into the UI.

## Substitution Order (byte-equivalent to Pi internals)
1. `$N` positional (`\$(\d+)` greedy) — missing → empty string
2. `${@:N}` / `${@:N:L}` slice — 1-indexed, clamped ≥ 0
3. `$ARGUMENTS` then 4. `$@` — both `args.join(" ")`. Order matters: `$N` first so slice/`$ARGUMENTS` values containing `$<digit>` are not recursively substituted.

## Always-On Shell Execution (`executeShellInBody`)
~~~
inline:  !`cmd`           (SHELL_INLINE_PATTERN, single-line, ≥1 char)
block:   ```!\n…\n```     (SHELL_BLOCK_PATTERN, multiline)
~~~
Runs on every known-skill emit path (independent of `hadTokens`), after variable substitution. **Blocks first, then inlines** via mask-and-restore: block matches → `\x00BLOCK${n}\x00` sentinels (no backticks → inline regex can't re-match block stdout) → inline pass → restore. Sequential, never `Promise.all` (authors rely on `!`mkdir x``→`!`ls x`` ordering). Shim: `sh -c` POSIX / `powershell.exe -Command` win32; `pi.exec` never rejects. Output tail-truncated to `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES` (`truncateForLLM`) on BOTH success and non-zero-exit paths.

## Module-level Cache Reset
The handler module exports a reset (`invalidateSkillIndex`) — `test/setup.ts` `beforeEach` calls it so cross-test skill-path cache leaks don't bias the next case. New singleton state added to this package MUST extend the reset and be wired into setup.ts in the same change.

## Architectural Boundaries
- **NO cross-sibling imports** — Phase-1 zero-cross-imports contract. Only `@earendil-works/pi-coding-agent` is allowed
- **NO deep imports** — argv parsing and substitution are re-implemented in-package, NOT imported from Pi's internal `dist/` modules (no semver guarantee on internals)
- **NO retroactive skill-body edits** — additive-only; existing `[square]` hints and no-arg branches are untouched
- **NO `steer()` / `followUp()` coverage** — those paths skip `emitInput`. Placeholders on those paths are resolved by Pi's built-in expansion only — document, don't mitigate
- **NO `arguments:` frontmatter key** — the substitution trigger is body-token presence, NOT frontmatter. Frontmatter IS read via `parseFrontmatter`, but only `shell-timeout` is consumed (→ `resolveShellTimeoutMs`, seconds; `0` disables); `argument-hint` is typed in the frontmatter shape yet never read — and frontmatter never drives substitution

<important if="you are changing the wrapper template or substitution order">
## Byte-Exact Contract
1. The wrapper template (`<skill name=…>…</skill>`) MUST match Pi's built-in output character-for-character — Pi's downstream `parseSkillBlock` regex is the load-bearing parser
2. The suffix format is path-dependent — bare `\n\n${args}` on the no-token path, `\n\nSkill input: ${args}` on the token path; empty args emit no suffix on either. `SKILL_INPUT_LABEL` MUST stay literally in sync with `SKILL_INVOCATION_PROTOCOL` and the label-stripping regexes in `packages/rpiv-warp/payload.ts:103` and `packages/rpiv-pi/extensions/rpiv-core/lane-transcript.ts:112`. Do not unify the two paths without re-reading "System-Prompt Protocol & Token-Path Divergence"
3. Substitution order (`$N` → `${@:N[:L]}` → `$ARGUMENTS` → `$@`) MUST NOT change — the order prevents wildcard values containing `$<digit>` from being re-substituted
4. Add a regression test BEFORE edits: round-trip a wrapped block through Pi's exported `parseSkillBlock`
</important>

<important if="you are touching the system-prompt protocol or before_agent_start handler">
## System-Prompt Protocol Contract
1. ALWAYS read-then-prepend (`SKILL_INVOCATION_PROTOCOL + event.systemPrompt`) — `emitBeforeAgentStart` (`runner.js:784-829`) chains `before_agent_start` results across extensions; replacement clobbers their modifications. Never return a fresh string
2. Per-turn re-application is by design — each `prompt()` starts from a clean `_baseSystemPrompt` (`agent-session.js:864`, reset at `:887`; rebuilt only at `:627`/`:1754`); one-shot mutation is not architecturally available
3. The protocol references `<skill name="..." location="...">...</skill>` literally — keep this in sync with the wrapper template if either changes
4. Token cost is amortized via prompt caching only when bytes are identical across turns. Any per-turn variance (timestamps, context-dependent text) breaks the cache
</important>

<important if="you are adding a new placeholder or a stricter enforcement semantic">
## Extending the Vocabulary
1. New placeholder → update the token regex AND the substitution function. Both must stay in sync
2. Required-arg enforcement (`<required>` vs `[optional]`, `strict-args:` flag) was explicitly deferred. Before reopening, enumerate every skill's `argument-hint` against the impact matrix
3. Prefer opt-in semantics — the current baseline (token-present → substitute; else verbatim) is fully backward-compatible. Anything refusing an empty-args invocation WILL break required-as-optional skills today
</important>
