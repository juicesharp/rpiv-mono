/**
 * rpiv-args — core logic.
 *
 * Intercepts `/skill:<name> <args>` at the input hook and emits a Pi skill
 * wrapper with opt-in $N/$ARGUMENTS/$@/${@:N[:L]} substitution on the body.
 * Two emit paths:
 *   - No-token path: byte-identical to Pi's built-in `_expandSkillCommand`
 *     output (wrapper + `\n\n${args}` suffix), preserving full backward
 *     compatibility for skills without placeholders.
 *   - Token path: substitutes inside the body and INTENTIONALLY drops the
 *     trailing `\n\n${args}` suffix. The bare imperative outside the block
 *     hijacks LLM attention from the skill workflow; inside-only emission
 *     leaves the skill body as the sole user-message payload competing for
 *     attention. See architecture.md "System-Prompt Protocol & Token-Path
 *     Divergence".
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type ExtensionAPI,
	getAgentDir,
	type InputEvent,
	type InputEventResult,
	loadSkills,
	parseFrontmatter,
	type Skill,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Matches any placeholder Pi's substituteArgs would replace. Used as the
 *  opt-in gate: absent → pass through verbatim. */
const TOKEN_REGEX = /\$(?:\d+|ARGUMENTS|@|\{@:\d+(?::\d+)?\})/;

/** Prefix Pi uses (`agent-session.js:829`). Single-space tokenisation. */
const SKILL_PREFIX = "/skill:";

/** Re-entrancy guard. */
const WRAPPED_PREFIX = "<skill ";

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

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const gitRepoRoot = findGitRepoRoot(startDir);
	let dir = resolve(startDir);
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return skillDirs;
}

function addExistingPath(paths: string[], seen: Set<string>, path: string): void {
	const resolved = resolve(path);
	if (!existsSync(resolved) || seen.has(resolved)) return;
	seen.add(resolved);
	paths.push(resolved);
}

/** Collect Pi's default skill locations in collision-precedence order. */
export function collectDefaultSkillPaths(cwd: string, agentDir: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const userAgentsSkillsDir = join(homedir(), ".agents", "skills");

	addExistingPath(paths, seen, join(resolve(cwd), ".pi", "skills"));
	for (const dir of collectAncestorAgentsSkillDirs(cwd)) {
		if (resolve(dir) !== resolve(userAgentsSkillsDir)) addExistingPath(paths, seen, dir);
	}
	addExistingPath(paths, seen, join(agentDir, "skills"));
	addExistingPath(paths, seen, userAgentsSkillsDir);

	return paths;
}

/** Build the name→path index by asking Pi for its default skill locations. */
function buildSkillIndex(): Map<string, SkillIndexEntry> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { skills } = loadSkills({
		cwd,
		agentDir,
		skillPaths: collectDefaultSkillPaths(cwd, agentDir),
		includeDefaults: false,
	});
	const index = new Map<string, SkillIndexEntry>();
	for (const s of skills as Skill[]) {
		index.set(s.name, { name: s.name, filePath: s.filePath, baseDir: s.baseDir });
	}
	return index;
}

function getSkillIndex(): Map<string, SkillIndexEntry> {
	if (!skillIndex) skillIndex = buildSkillIndex();
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
// Input handler
// ---------------------------------------------------------------------------

export function handleInput(event: InputEvent): InputEventResult {
	const text = event.text;

	// Re-entrancy: already-wrapped text (from our own or any other
	// extension's {action:"transform"}) passes through untouched.
	if (text.startsWith(WRAPPED_PREFIX)) return { action: "continue" };

	if (!text.startsWith(SKILL_PREFIX)) return { action: "continue" };

	// Single-space tokenisation — byte-match Pi's indexOf(" ") at :831.
	const spaceIndex = text.indexOf(" ");
	const skillName = spaceIndex === -1 ? text.slice(SKILL_PREFIX.length) : text.slice(SKILL_PREFIX.length, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

	const entry = getSkillIndex().get(skillName);
	if (!entry) return { action: "continue" }; // unknown skill — let Pi handle it

	let content: string;
	try {
		content = readFileSync(entry.filePath, "utf-8");
	} catch {
		return { action: "continue" }; // let Pi emit its error via _expandSkillCommand
	}

	const { frontmatter } = parseFrontmatter<{ "argument-hint"?: string }>(content);
	void frontmatter; // informational only in v1
	const body = stripFrontmatter(content).trim();

	// Opt-in gate: if body has no token, emit byte-identical to Pi's :841.
	if (!TOKEN_REGEX.test(body)) {
		return { action: "transform", text: appendArgs(buildSkillBlock(entry, body), argsString) };
	}

	const parsed = parseCommandArgs(argsString);
	const substituted = substituteArgs(body, parsed);
	// Substitution consumes the args — do not also append them after </skill>.
	// Bare trailing imperatives hijack LLM attention from the skill body. See architecture.md.
	return { action: "transform", text: buildSkillBlock(entry, substituted) };
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
// Registration
// ---------------------------------------------------------------------------

export function registerArgsHandler(pi: ExtensionAPI): void {
	pi.on("input", (event) => handleInput(event));
	pi.on("before_agent_start", (event) => handleBeforeAgentStart(event));
	pi.on("session_start", (event) => {
		if (event.reason === "reload" || event.reason === "startup") {
			invalidateSkillIndex();
		}
	});
}
