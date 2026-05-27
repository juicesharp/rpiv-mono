/**
 * rpiv-args — core logic.
 *
 * Intercepts `/skill:<name> <args>` at the input hook and emits a Pi skill
 * wrapper. Pipeline (FR9):
 *   strip frontmatter → $N/$ARGUMENTS substitution (opt-in via TOKEN_REGEX)
 *   → ${SKILL_DIR}/${SESSION_ID} substitution (always-on, FR10)
 *   → shell execution (always-on, FR10 — see executeShellInBody)
 *   → wrap in <skill name=… location=…>…</skill> block
 *
 * Emit-path divergence (FR12): the trailing `\n\n${args}` suffix policy is
 * governed by ORIGINAL token presence (`hadTokens`). The no-token path emits
 * byte-identical to Pi's built-in `_expandSkillCommand`; the token path
 * intentionally drops the suffix (substitution consumed the args; bare
 * trailing imperatives hijack LLM attention from the skill body).
 *
 * Variable substitution and shell execution always run on BOTH emit paths —
 * `hadTokens` governs the suffix only, not the substitution pipeline.
 *
 * Also prepends a skill-invocation protocol to the system prompt every turn
 * (via before_agent_start) so the LLM treats trailing text after `</skill>`
 * as the skill's argument input rather than a separate imperative.
 *
 * Byte-exact wrapper requirement: parseSkillBlock regex at
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:40
 * is the load-bearing contract for the wrapper itself. Do not reformat the
 * template literal below.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	type InputEvent,
	type InputEventResult,
	parseFrontmatter,
	stripFrontmatter,
	type TruncationResult,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Matches any placeholder Pi's substituteArgs would replace. Used as the
 *  opt-in gate for the $N/$ARGUMENTS substitution path AND as the
 *  emit-path flag (hadTokens) governing the trailing-args suffix. */
const TOKEN_REGEX = /\$(?:\d+|ARGUMENTS|@|\{@:\d+(?::\d+)?\})/;

/** Prefix Pi uses (`agent-session.js:829`). Single-space tokenisation. */
const SKILL_PREFIX = "/skill:";

/** Re-entrancy guard. */
const WRAPPED_PREFIX = "<skill ";

/** Default ceiling for shell execution: 2 minutes. Frontmatter `shell-timeout`
 *  (seconds) overrides; `0` disables natively via pi.exec's `&&` short-circuit
 *  at dist/core/exec.js:42. */
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** Inline shell: !`command` — non-greedy single-line, no newline crossing.
 *  Capture is `[^`\n]+` (at least one char) so a literal `` !`` `` in
 *  prose does NOT run the shell with an empty `-c` argument (per
 *  artifact-reviewer finding R3).
 *  Runs AFTER block; block-before-inline is enforced by the mask-and-restore
 *  pass below (block outputs are protected from inline re-execution per R2).
 *  MUST stay /g — consumed by matchAll(); do NOT call .exec()/.test() on
 *  this directly (stale lastIndex would silently skip matches). */
const SHELL_INLINE_PATTERN = /!`([^`\n]+)`/g;

/** Block shell: ```!\n…\n``` — multiline non-greedy. Captured content is
 *  handed to the shell as a single program (newlines preserved).
 *  MUST stay /g — consumed by matchAll(); do NOT call .exec()/.test() on
 *  this directly (stale lastIndex would silently skip matches). */
const SHELL_BLOCK_PATTERN = /```!\n([\s\S]*?)\n```/g;

// ---------------------------------------------------------------------------
// Tokeniser — byte-equivalent to Pi's parseCommandArgs at
// node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js:11-42
// ---------------------------------------------------------------------------

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

// ---------------------------------------------------------------------------
// Substitutor — byte-equivalent to Pi's substituteArgs at
// node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js:54-82
// Order matters: $N first, then ${@:N[:L]}, then $ARGUMENTS, then $@.
// ---------------------------------------------------------------------------

export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num) => args[parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

// ---------------------------------------------------------------------------
// Variable substitution — mechanical, runs after $N/$ARGUMENTS and before
// shell execution. ${SKILL_DIR} is forward-slash-normalized at the
// substitution site ONLY — buildSkillBlock must stay byte-exact (its
// `References are relative to ${baseDir}` line is consumed by Pi unchanged).
//
// Backslash normalization is GATED on process.platform === "win32" so a
// POSIX path containing a literal backslash (e.g. `/tmp/weird\name`) is
// byte-preserving. Per artifact-reviewer finding R7.
// ---------------------------------------------------------------------------

export function substituteVariables(body: string, vars: { skillDir: string; sessionId: string }): string {
	const skillDir = process.platform === "win32" ? vars.skillDir.split("\\").join("/") : vars.skillDir;
	return body.replace(/\$\{SKILL_DIR\}/g, skillDir).replace(/\$\{SESSION_ID\}/g, vars.sessionId);
}

// ---------------------------------------------------------------------------
// shell-timeout resolution.
//
// YAML scalar coercion at frontmatter parse time can produce any of: number,
// string, boolean, null, NaN (from `.nan`), Infinity (from `.inf`). Silent
// fallback to default on any non-finite or non-positive value matches Pi's
// graceful-degradation posture at dist/utils/frontmatter.js:24 (`parsed ?? {}`).
//
// Number.isFinite is load-bearing — both NaN and Infinity must be rejected:
//   - NaN  → would silently bypass exec.js:42's `&& options.timeout > 0`
//            short-circuit (NaN > 0 is false) and disable the timer, hiding
//            an FR4 violation.
//   - Infinity → Node's setTimeout(fn, Infinity) clamps to 1ms → an immediate
//                kill (the opposite of "no timeout").
//
// `0` is honored as explicit disable (FR4).
// ---------------------------------------------------------------------------

export function resolveShellTimeoutMs(frontmatter: { "shell-timeout"?: unknown }): number {
	const raw = frontmatter["shell-timeout"];
	if (raw === undefined) return DEFAULT_SHELL_TIMEOUT_MS;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_SHELL_TIMEOUT_MS;
	if (raw < 0) return DEFAULT_SHELL_TIMEOUT_MS;
	if (raw === 0) return 0;
	return raw * 1000;
}

// ---------------------------------------------------------------------------
// Shell execution.
//
// Pipeline: blocks first, then inlines. Block-before-inline is load-bearing
// — the block pattern's content group `[\s\S]*?` legitimately matches `!\``
// inside the fence; running inline first would eat backticks from block
// content and produce malformed bodies.
//
// Sequential iteration (FR11) — never Promise.all. Skill authors rely on
// `!`mkdir x`` → `!`ls x`` ordering. The git-context.ts:36-44 Promise.all
// precedent for parallel read-only git commands is INTENTIONALLY not copied.
//
// Cross-platform shim: PowerShell on Windows (POSIX-alias coverage), sh on
// POSIX. `pi.exec` uses spawn(…, {shell:false}) per dist/core/exec.js:13-17
// so the shim is required.
//
// `pi.exec` NEVER rejects (dist/core/exec.js:10-72 — every termination path
// calls resolve(...)). No try/catch needed here.
//
// FR5 branch order: killed → code !== 0 → success. `killed` is checked first
// because a timed-out child may also report a non-zero code via `code ?? 0`
// (exec.js:60) or `1` via the catch (exec.js:71); the timeout message wins.
// ---------------------------------------------------------------------------

/** Truncate a string for LLM consumption: 50KB / 2000-line tail budget,
 *  with a `[truncated: hit ...]` footer when truncation occurred. Shared
 *  by the success path (`formatShellOutput`) and the non-zero exit path
 *  in `runOneShellCommand` so a multi-MB stderr from a failed `!`npm test``
 *  cannot bypass FR2's budget (per R1). */
function truncateForLLM(content: string): string {
	const trunc: TruncationResult = truncateTail(content, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let out = trunc.content;
	if (trunc.truncated) {
		const limit = trunc.truncatedBy === "lines" ? `${trunc.maxLines} lines` : formatSize(trunc.maxBytes);
		out += `\n[truncated: hit ${limit}]`;
	}
	return out;
}

function formatShellOutput(res: ExecResult): string {
	let combined = res.stdout;
	if (res.stderr && res.stderr.length > 0) {
		const sep = combined.length === 0 || combined.endsWith("\n") ? "" : "\n";
		combined = `${combined}${sep}[stderr]\n${res.stderr}`;
	}
	return truncateForLLM(combined);
}

async function runOneShellCommand(command: string, pi: ExtensionAPI, cwd: string, timeoutMs: number): Promise<string> {
	const [shCmd, shFlag] = process.platform === "win32" ? ["powershell.exe", "-Command"] : ["sh", "-c"];
	const res: ExecResult = await pi.exec(shCmd, [shFlag, command], { cwd, timeout: timeoutMs });
	if (res.killed) {
		// Floor at 1s so sub-second `shell-timeout` values (e.g. 0.5) don't display
		// the contradictory `[Shell error: timed out after 0s]` (per R4).
		const sec = Math.max(1, Math.round(timeoutMs / 1000));
		return `[Shell error: timed out after ${sec}s]`;
	}
	if (res.code !== 0) {
		// FR2 budget on the error path — stderr is truncated identically to
		// the success path so a failed `!`npm test`` cannot blow the LLM budget (R1).
		return `[Shell error: exit code ${res.code}]\n${truncateForLLM(res.stderr)}`;
	}
	return formatShellOutput(res);
}

/** Mask-and-restore strategy (per R2): run the block pass first, replacing
 *  each block match with a non-printable sentinel (`\x00BLOCK${n}\x00`) that
 *  the inline regex CANNOT match (sentinels have no backticks). Then run the
 *  inline pass on the sentinel-bearing string. Finally restore sentinels to
 *  their block outputs. This guarantees block stdout containing literal
 *  `` !`...` `` is NEVER re-executed by the inline pass. */
export async function executeShellInBody(
	body: string,
	pi: ExtensionAPI,
	cwd: string,
	timeoutMs: number,
): Promise<string> {
	// Pass 1: blocks → sentinels (outputs stashed in blockOutputs).
	const blockOutputs: string[] = [];
	let withSentinels = "";
	{
		const matches = [...body.matchAll(SHELL_BLOCK_PATTERN)];
		let last = 0;
		for (const m of matches) {
			const idx = m.index ?? 0;
			withSentinels += body.slice(last, idx);
			withSentinels += `\x00BLOCK${blockOutputs.length}\x00`;
			blockOutputs.push(await runOneShellCommand(m[1] ?? "", pi, cwd, timeoutMs));
			last = idx + m[0].length;
		}
		withSentinels += body.slice(last);
	}
	// Pass 2: inlines on the sentinel-bearing string. Sentinels carry no
	// backticks so the inline regex (which requires backticks at both ends)
	// cannot match against them — block outputs are protected.
	let withInlines = "";
	{
		const matches = [...withSentinels.matchAll(SHELL_INLINE_PATTERN)];
		let last = 0;
		for (const m of matches) {
			const idx = m.index ?? 0;
			withInlines += withSentinels.slice(last, idx);
			withInlines += await runOneShellCommand(m[1] ?? "", pi, cwd, timeoutMs);
			last = idx + m[0].length;
		}
		withInlines += withSentinels.slice(last);
	}
	// Pass 3: restore block sentinels to their actual outputs.
	return withInlines.replace(/\x00BLOCK(\d+)\x00/g, (_, n) => blockOutputs[parseInt(n, 10)] ?? "");
}

// ---------------------------------------------------------------------------
// Skill-path index — populated once, refreshed on session_start(reason:reload)
// ---------------------------------------------------------------------------

interface SkillIndexEntry {
	readonly name: string;
	readonly filePath: string;
	readonly baseDir: string;
}

let skillIndex: Map<string, SkillIndexEntry> | null = null;

export function invalidateSkillIndex(): void {
	skillIndex = null;
}

/**
 * Build the name→path index from Pi's command registry. `pi.getCommands()`
 * returns every slash command the agent can see — including skills sourced
 * from extension package manifests (`pi.skills: [...]`), not just the
 * filesystem-walked defaults. This is the authoritative source: whatever Pi
 * knows about as `/skill:<name>`, this index recognizes.
 *
 * Critically, this fixes programmatic `sendUserMessage("/skill:<name> …")`
 * from other extensions (e.g. the `/rpiv` workflow runner). Those calls go
 * through `prompt({expandPromptTemplates: false})`, so Pi's built-in
 * `_expandSkillCommand` is skipped — `rpiv-args` is the only expander on that
 * path. If the index doesn't recognize the skill, the raw `/skill:<name> …`
 * reaches the LLM unwrapped.
 */
function buildSkillIndex(pi: ExtensionAPI): Map<string, SkillIndexEntry> {
	const index = new Map<string, SkillIndexEntry>();
	for (const cmd of pi.getCommands()) {
		if (cmd.source !== "skill") continue;
		// Pi prefixes skill-source commands with "skill:" (agent-session.js:1699).
		const name = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
		const filePath = cmd.sourceInfo.path;
		// `cmd.sourceInfo.baseDir` cannot be used here: for skills sourced from
		// an extension manifest (`pi.skills: [...]`), resource-loader.js:358-362
		// overrides `skill.sourceInfo` with the *extension package's* baseDir
		// (e.g. `packages/rpiv-pi`), not the skill folder. Pi's own internal
		// `Skill.baseDir` is set to `dirname(filePath)` at skills.js:214,237 —
		// which is what `${SKILL_DIR}` substitutions in skill bodies expect.
		const baseDir = dirname(filePath);
		index.set(name, { name, filePath, baseDir });
	}
	return index;
}

function getSkillIndex(pi: ExtensionAPI): Map<string, SkillIndexEntry> {
	if (!skillIndex) skillIndex = buildSkillIndex(pi);
	return skillIndex;
}

// ---------------------------------------------------------------------------
// Wrapper emit — byte-exact against parseSkillBlock regex at
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:40
// and byte-equivalent to _expandSkillCommand's output at :840-841.
// ---------------------------------------------------------------------------

function buildSkillBlock(entry: SkillIndexEntry, body: string): string {
	return `<skill name="${entry.name}" location="${entry.filePath}">\nReferences are relative to ${entry.baseDir}.\n\n${body}\n</skill>`;
}

function appendArgs(skillBlock: string, args: string): string {
	return args ? `${skillBlock}\n\n${args}` : skillBlock;
}

// ---------------------------------------------------------------------------
// Input handler — async pipeline (FR9 ordering).
//
// `pi` is threaded as the 3rd parameter (not captured at module level) so the
// extension owns zero new singleton state — see architecture.md "Module-level
// Cache Reset". `ctx` carries the session manager for ${SESSION_ID}.
// ---------------------------------------------------------------------------

export async function handleInput(
	event: InputEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<InputEventResult> {
	const text = event.text;

	// Re-entrancy: already-wrapped text (from our own or any other
	// extension's {action:"transform"}) passes through untouched.
	if (text.startsWith(WRAPPED_PREFIX)) return { action: "continue" };

	if (!text.startsWith(SKILL_PREFIX)) return { action: "continue" };

	// Single-space tokenisation — byte-match Pi's indexOf(" ") at :831.
	const spaceIndex = text.indexOf(" ");
	const skillName = spaceIndex === -1 ? text.slice(SKILL_PREFIX.length) : text.slice(SKILL_PREFIX.length, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

	const entry = getSkillIndex(pi).get(skillName);
	if (!entry) return { action: "continue" }; // unknown skill — let Pi handle it

	let content: string;
	try {
		content = readFileSync(entry.filePath, "utf-8");
	} catch {
		return { action: "continue" }; // let Pi emit its error via _expandSkillCommand
	}

	const { frontmatter } = parseFrontmatter<{ "argument-hint"?: string; "shell-timeout"?: unknown }>(content);
	const body = stripFrontmatter(content).trim();
	const timeoutMs = resolveShellTimeoutMs(frontmatter);

	// FR12: emit-path divergence (token-path drops the trailing `\n\n${args}`
	// suffix) is governed by ORIGINAL token presence only. FR10: variable
	// substitution and shell execution run on BOTH paths regardless.
	const hadTokens = TOKEN_REGEX.test(body);

	let processed = hadTokens ? substituteArgs(body, parseCommandArgs(argsString)) : body;
	processed = substituteVariables(processed, {
		skillDir: entry.baseDir,
		sessionId: ctx.sessionManager.getSessionId(),
	});
	processed = await executeShellInBody(processed, pi, process.cwd(), timeoutMs);

	const block = buildSkillBlock(entry, processed);
	return { action: "transform", text: hadTokens ? block : appendArgs(block, argsString) };
}

// ---------------------------------------------------------------------------
// Skill-invocation protocol — prepended to the system prompt every turn via
// before_agent_start. See architecture.md for rationale and re-application
// semantics (agent-session.js:112-113 — Pi's canonical per-turn pattern).
// ---------------------------------------------------------------------------

export const SKILL_INVOCATION_PROTOCOL = `## Skill invocation protocol (CRITICAL)

A \`<skill name="..." location="...">...</skill>\` block in a user message is a structured invocation. Handle it as follows:

1. The block body defines the workflow you must execute. Follow it.
2. Any text after \`</skill>\` is the user's argument input to that skill — never a separate command, even when it reads as an imperative ("create X", "update Y", "delete Z").
3. Do not bypass the skill's workflow to act on trailing text directly. The user invoked the skill because they want the skill's workflow applied to that input.

`;

export function handleBeforeAgentStart(event: BeforeAgentStartEvent): BeforeAgentStartEventResult {
	return { systemPrompt: SKILL_INVOCATION_PROTOCOL + event.systemPrompt };
}

// ---------------------------------------------------------------------------
// Registration. The input handler arrow forwards `ctx` (Pi's runner awaits
// the result at runner.js:801) and closes over `pi` so handleInput sees both
// without new module-level state.
// ---------------------------------------------------------------------------

export function registerArgsHandler(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => handleInput(event, ctx, pi));
	pi.on("before_agent_start", (event) => handleBeforeAgentStart(event));
	pi.on("session_start", (event) => {
		// Pi fires session_start for every session including programmatic
		// spawns. Re-enumerating the skill set per spawn is cheap (one
		// readdir per declared skillPath); the prior workflow-aware gate
		// shaved that work but coupled this package to rpiv-workflow's
		// internal Symbol. Drop the gate — correctness > microseconds.
		if (event.reason === "reload" || event.reason === "startup") {
			invalidateSkillIndex();
		}
	});
}
