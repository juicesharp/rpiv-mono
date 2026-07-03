/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests contain literal "${...}" substitution tokens */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	executeShellInBody,
	handleBeforeAgentStart,
	handleInput,
	invalidateSkillIndex,
	parseCommandArgs,
	registerArgsHandler,
	resolveShellTimeoutMs,
	SKILL_INPUT_LABEL,
	SKILL_INVOCATION_PROTOCOL,
	substituteArgs,
	substituteVariables,
} from "./args.js";

interface SkillSpec {
	name: string;
	body: string;
	frontmatter?: Record<string, string>;
}
function writeSkillsDir(dir: string, skills: SkillSpec[]): Array<{ name: string; filePath: string; baseDir: string }> {
	const entries: Array<{ name: string; filePath: string; baseDir: string }> = [];
	for (const s of skills) {
		const filePath = join(dir, `${s.name}.md`);
		const fm = s.frontmatter
			? `---\n${Object.entries(s.frontmatter)
					.map(([k, v]) => `${k}: ${v}`)
					.join("\n")}\n---\n`
			: "";
		writeFileSync(filePath, `${fm}${s.body}`, "utf-8");
		entries.push({ name: s.name, filePath, baseDir: dir });
	}
	return entries;
}

let tmpDir: string;
let ctx: ExtensionContext;
let pi: ExtensionAPI;
let skillCommands: SlashCommandInfo[];
let getCommandsFn: ReturnType<typeof vi.fn>;

/**
 * Wire a list of skill entries into `pi.getCommands()` — the new skill index
 * source after rpiv-args switched away from filesystem-walking `loadSkills`
 * to Pi's canonical command registry. Replaces the previous
 * `vi.mocked(loadSkills).mockReturnValue(...)` per-test setup.
 */
function setSkills(entries: Array<{ name: string; filePath: string; baseDir: string }>): void {
	skillCommands = entries.map((e) => ({
		name: `skill:${e.name}`,
		description: "",
		source: "skill" as const,
		sourceInfo: {
			path: e.filePath,
			source: "test",
			scope: "user" as const,
			origin: "package" as const,
			baseDir: e.baseDir,
		},
	}));
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-args-"));
	skillCommands = [];
	getCommandsFn = vi.fn(() => skillCommands);
	invalidateSkillIndex();
	ctx = createMockCtx();
	pi = createMockPi({ getCommands: getCommandsFn as never }).pi;
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseCommandArgs", () => {
	it("splits on single spaces", () => {
		expect(parseCommandArgs("a b c")).toEqual(["a", "b", "c"]);
	});
	it("splits on tabs", () => {
		expect(parseCommandArgs("a\tb\tc")).toEqual(["a", "b", "c"]);
	});
	it("collapses multiple spaces into boundaries", () => {
		expect(parseCommandArgs("a   b")).toEqual(["a", "b"]);
	});
	it("preserves double-quoted groups", () => {
		expect(parseCommandArgs('a "b c" d')).toEqual(["a", "b c", "d"]);
	});
	it("preserves single-quoted groups", () => {
		expect(parseCommandArgs("a 'b c' d")).toEqual(["a", "b c", "d"]);
	});
	it("handles mixed quoting in one token", () => {
		expect(parseCommandArgs('"a b"c')).toEqual(["a bc"]);
	});
	it("flushes on unmatched quote (byte-compat with pi)", () => {
		expect(parseCommandArgs('a "b c')).toEqual(["a", "b c"]);
	});
	it("returns empty for empty string", () => {
		expect(parseCommandArgs("")).toEqual([]);
	});
	it("returns empty for whitespace-only string", () => {
		expect(parseCommandArgs("   \t ")).toEqual([]);
	});
	it("treats quote characters as delimiters not content", () => {
		expect(parseCommandArgs('""')).toEqual([]);
	});
	it("splits on leading tab+space mix", () => {
		expect(parseCommandArgs("\t a \t b")).toEqual(["a", "b"]);
	});
});

describe("substituteArgs", () => {
	it("substitutes $1..$N positionally", () => {
		expect(substituteArgs("$1/$2", ["a", "b"])).toBe("a/b");
	});
	it("empty-substitutes $N when N > args.length", () => {
		expect(substituteArgs("$1/$5", ["a", "b"])).toBe("a/");
	});
	it("$11 is greedy (matches 11th, not $1+1)", () => {
		const args = Array.from({ length: 11 }, (_, i) => String(i + 1));
		expect(substituteArgs("$11", args)).toBe("11");
	});
	it("substitutes ${@:N} with rest-of-args", () => {
		expect(substituteArgs("${@:2}", ["a", "b", "c", "d"])).toBe("b c d");
	});
	it("substitutes ${@:N:L} with slice", () => {
		expect(substituteArgs("${@:2:2}", ["a", "b", "c", "d"])).toBe("b c");
	});
	it("clamps ${@:0} to start", () => {
		expect(substituteArgs("${@:0}", ["a", "b"])).toBe("a b");
	});
	it("substitutes $ARGUMENTS with full joined args", () => {
		expect(substituteArgs("$ARGUMENTS!", ["a", "b"])).toBe("a b!");
	});
	it("substitutes $@ identically to $ARGUMENTS", () => {
		expect(substituteArgs("$@", ["a", "b"])).toBe("a b");
	});
	it("applies $N before ${@:N} (order matters)", () => {
		expect(substituteArgs("$1-${@:2}", ["a", "b", "c"])).toBe("a-b c");
	});
	it("applies ${@:N} before $ARGUMENTS", () => {
		expect(substituteArgs("${@:2} and $ARGUMENTS", ["a", "b"])).toBe("b and a b");
	});
	it("substitutes $@ even inside quotes (no quote awareness)", () => {
		expect(substituteArgs('"$@"', ["a", "b"])).toBe('"a b"');
	});
	it("returns empty when $N referenced with no args", () => {
		expect(substituteArgs("$1", [])).toBe("");
	});
});

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const orig = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return fn();
	} finally {
		if (orig) Object.defineProperty(process, "platform", orig);
	}
}

describe("substituteVariables", () => {
	it("substitutes ${SKILL_DIR}", () => {
		expect(substituteVariables("dir=${SKILL_DIR}", { skillDir: "/a/b", sessionId: "s" })).toBe("dir=/a/b");
	});
	it("substitutes ${SESSION_ID}", () => {
		expect(substituteVariables("id=${SESSION_ID}", { skillDir: "/x", sessionId: "01HN" })).toBe("id=01HN");
	});
	it("normalizes Windows backslashes to forward slashes in ${SKILL_DIR} (Windows only)", () => {
		withPlatform("win32", () => {
			expect(substituteVariables("at ${SKILL_DIR}", { skillDir: "C:\\Users\\me\\.pi", sessionId: "s" })).toBe(
				"at C:/Users/me/.pi",
			);
		});
	});
	it("does NOT normalize backslashes on POSIX (literal backslash preserved)", () => {
		withPlatform("darwin", () => {
			expect(substituteVariables("at ${SKILL_DIR}", { skillDir: "/tmp/weird\\name", sessionId: "s" })).toBe(
				"at /tmp/weird\\name",
			);
		});
	});
	it("does not normalize forward slashes (POSIX path passthrough)", () => {
		withPlatform("linux", () => {
			expect(substituteVariables("${SKILL_DIR}", { skillDir: "/home/me/.pi", sessionId: "s" })).toBe("/home/me/.pi");
		});
	});
	it("supports multiple occurrences of each variable", () => {
		expect(substituteVariables("${SKILL_DIR} ${SESSION_ID} ${SKILL_DIR}", { skillDir: "/x", sessionId: "s" })).toBe(
			"/x s /x",
		);
	});
	it("returns body unchanged when no variables are present", () => {
		expect(substituteVariables("plain body", { skillDir: "/x", sessionId: "s" })).toBe("plain body");
	});
	it("leaves unknown ${FOO} placeholders untouched", () => {
		expect(substituteVariables("${SKILL_DIR} ${FOO}", { skillDir: "/x", sessionId: "s" })).toBe("/x ${FOO}");
	});
});

describe("resolveShellTimeoutMs", () => {
	it("returns DEFAULT_SHELL_TIMEOUT_MS when absent", () => {
		expect(resolveShellTimeoutMs({})).toBe(120_000);
	});
	it("converts seconds to ms for positive numbers", () => {
		expect(resolveShellTimeoutMs({ "shell-timeout": 5 })).toBe(5_000);
		expect(resolveShellTimeoutMs({ "shell-timeout": 0.5 })).toBe(500);
	});
	it("honors 0 as explicit disable (FR4)", () => {
		expect(resolveShellTimeoutMs({ "shell-timeout": 0 })).toBe(0);
	});
	it("falls back to default for string values (YAML coerced)", () => {
		expect(resolveShellTimeoutMs({ "shell-timeout": "5" as unknown as number })).toBe(120_000);
	});
	it("falls back to default for negative values", () => {
		expect(resolveShellTimeoutMs({ "shell-timeout": -1 })).toBe(120_000);
	});
	it("falls back to default for NaN (would silently bypass exec.js:42)", () => {
		expect(resolveShellTimeoutMs({ "shell-timeout": Number.NaN })).toBe(120_000);
	});
	it("falls back to default for Infinity (Node clamps setTimeout(Infinity) to 1ms)", () => {
		expect(resolveShellTimeoutMs({ "shell-timeout": Number.POSITIVE_INFINITY })).toBe(120_000);
	});
	it("falls back to default for boolean (YAML true)", () => {
		expect(resolveShellTimeoutMs({ "shell-timeout": true as unknown as number })).toBe(120_000);
	});
});

describe("invalidateSkillIndex — lazy memoisation", () => {
	it("builds index once across multiple handleInput calls", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "hello" }]);
		setSkills(entries);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, pi);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, pi);
		expect(getCommandsFn).toHaveBeenCalledTimes(1);
	});
	it("discovers extension-bundled skills via pi.getCommands() (the fix for sendUserMessage-based chaining)", async () => {
		// pi.getCommands() returns every slash command Pi recognizes, including
		// skills sourced from extension package manifests (`pi.skills: [...]`).
		// Filesystem walking can't see those — this is the regression fixture
		// for the `/rpiv` workflow's literal-`/skill:` bug.
		const entries = writeSkillsDir(tmpDir, [{ name: "extension-bundled", body: "from a sibling extension" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:extension-bundled" } as InputEvent, ctx, pi);
		expect(r).toEqual({ action: "transform", text: expect.stringContaining("from a sibling extension") });
	});
	it("rebuilds after invalidateSkillIndex()", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "hello" }]);
		setSkills(entries);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, pi);
		invalidateSkillIndex();
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, pi);
		expect(getCommandsFn).toHaveBeenCalledTimes(2);
	});
	it("lazy: no getCommands call until first handleInput", () => {
		invalidateSkillIndex();
		expect(getCommandsFn).not.toHaveBeenCalled();
	});
});

describe("handleInput — gates", () => {
	it("passes through text not starting with /skill:", async () => {
		const r = await handleInput({ text: "hello" } as InputEvent, ctx, pi);
		expect(r).toEqual({ action: "continue" });
	});
	it("passes through already-wrapped <skill ...> re-entry", async () => {
		const r = await handleInput({ text: '<skill name="x" location="y">body</skill>' } as InputEvent, ctx, pi);
		expect(r).toEqual({ action: "continue" });
	});
	it("passes through unknown skill name", async () => {
		setSkills([]);
		const r = await handleInput({ text: "/skill:nope" } as InputEvent, ctx, pi);
		expect(r).toEqual({ action: "continue" });
	});
	it("passes through when filePath read fails", async () => {
		const entries = [{ name: "ghost", filePath: join(tmpDir, "missing.md"), baseDir: tmpDir }];
		setSkills(entries);
		const r = await handleInput({ text: "/skill:ghost" } as InputEvent, ctx, pi);
		expect(r).toEqual({ action: "continue" });
	});
});

describe("handleInput — emit paths (byte-exact wrapper)", () => {
	it("emits no-substitution wrapper when body has no tokens", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "hello world" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:foo extra" } as InputEvent, ctx, pi);
		const expected =
			`<skill name="foo" location="${entries[0].filePath}">\n` +
			`References are relative to ${tmpDir}.\n\n` +
			`hello world\n` +
			`</skill>\n\n` +
			`extra`;
		expect(r).toEqual({ action: "transform", text: expected });
	});
	it("emits substituted wrapper plus labeled `Skill input:` trailer (raw args preserved)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "bar", body: "do $1 then $2" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:bar a b" } as InputEvent, ctx, pi);
		const expected =
			`<skill name="bar" location="${entries[0].filePath}">\n` +
			`References are relative to ${tmpDir}.\n\n` +
			`do a then b\n` +
			`</skill>\n\n` +
			`Skill input: a b`;
		expect(r).toEqual({ action: "transform", text: expected });
	});
	it("does NOT emit BARE args after </skill> when body has tokens (LLM attention fix + issue #89)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "discover", body: "Input: $ARGUMENTS" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:discover write a file" } as InputEvent, ctx, pi);
		const text = (r as { text: string }).text;
		expect(text).toContain("Input: write a file");
		// The argument is substituted into the body AND carried raw in the
		// labeled trailer — but never as bare trailing text (which would read
		// as a standalone imperative).
		expect(text.endsWith("</skill>\n\nSkill input: write a file")).toBe(true);
		expect(text.match(/write a file/g)?.length).toBe(2);
	});
	it("token path with empty args emits no trailer (empty-input branch keys off absence)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "discover", body: "Input: $ARGUMENTS" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:discover" } as InputEvent, ctx, pi);
		const text = (r as { text: string }).text;
		expect(text.endsWith("</skill>")).toBe(true);
		expect(text).not.toContain("Skill input:");
	});
	it("strips frontmatter before substitution", async () => {
		const entries = writeSkillsDir(tmpDir, [
			{ name: "baz", body: "body $1", frontmatter: { "argument-hint": "thing" } },
		]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:baz X" } as InputEvent, ctx, pi);
		expect((r as { text: string }).text).toContain("body X");
		expect((r as { text: string }).text).not.toContain("argument-hint");
	});
	it("empty args → no trailing block", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "x" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:foo" } as InputEvent, ctx, pi);
		expect((r as { text: string }).text.endsWith("</skill>")).toBe(true);
	});
});

describe("handleInput — variable substitution", () => {
	it("substitutes ${SKILL_DIR} on the no-token emit path (FR10 always-on)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "v1", body: "at ${SKILL_DIR}" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:v1" } as InputEvent, ctx, pi);
		expect((r as { text: string }).text).toContain(`at ${tmpDir}`);
	});
	it("substitutes ${SESSION_ID} using ctx.sessionManager.getSessionId()", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "v2", body: "sid=${SESSION_ID}" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:v2" } as InputEvent, ctx, pi);
		// createMockCtx() default session id is "test-session"
		expect((r as { text: string }).text).toContain("sid=test-session");
	});
	it("substitutes variables on the token emit path too (FR10 always-on)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "v3", body: "$1 in ${SKILL_DIR}" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:v3 foo" } as InputEvent, ctx, pi);
		expect((r as { text: string }).text).toContain(`foo in ${tmpDir}`);
	});
	it("trailer carries the RAW args — the variable/shell passes touch woven occurrences only (FR9 order)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "v4", body: "Input: $ARGUMENTS" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:v4 see ${SKILL_DIR}/notes.md" } as InputEvent, ctx, pi);
		const text = (r as { text: string }).text;
		// The occurrence woven into the body IS variable-substituted (args → variables → shell)…
		expect(text).toContain(`Input: see ${tmpDir}/notes.md`);
		// …but the trailer is appended AFTER every substitution/shell pass, so
		// it preserves the user's literal bytes.
		expect(text.endsWith("Skill input: see ${SKILL_DIR}/notes.md")).toBe(true);
	});
});

describe("handleInput — manifest-loaded skill baseDir (regression)", () => {
	// When a skill is sourced from an extension's `pi.skills: [...]` manifest,
	// Pi sets `cmd.sourceInfo.baseDir` to the *extension package's* root
	// (resource-loader.js:358-362 overrides skill.sourceInfo with the extension
	// source info), NOT the skill's own folder. The skill's `${SKILL_DIR}`
	// substitution and the wrapper's "References are relative to" footer must
	// resolve to `dirname(filePath)`, never to `sourceInfo.baseDir`, or
	// `${SKILL_DIR}/../_shared/now.mjs`-style paths break.
	it("resolves ${SKILL_DIR} to dirname(filePath) even when sourceInfo.baseDir is the extension root", async () => {
		const skillDir = join(tmpDir, "skills", "discover");
		mkdirSync(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		writeFileSync(filePath, "use ${SKILL_DIR}/../_shared/now.mjs", "utf-8");
		// Pretend rpiv-pi (the extension) declared this skill via pi.skills.
		// Pi sets sourceInfo.baseDir to the extension package root (`tmpDir`),
		// NOT the skill folder (`skillDir`). The fix must ignore sourceInfo.baseDir.
		setSkills([{ name: "discover", filePath, baseDir: tmpDir }]);

		const r = await handleInput({ text: "/skill:discover" } as InputEvent, ctx, pi);
		const text = (r as { text: string }).text;

		expect(text).toContain(`use ${skillDir}/../_shared/now.mjs`);
		expect(text).toContain(`References are relative to ${skillDir}.`);
		expect(text).not.toContain(`References are relative to ${tmpDir}.`);
	});

	// Parameterized coverage across every Pi skill-loading path. In all of them
	// `sourceInfo.baseDir` is the *enclosing scope* (project root, .agents dir,
	// agent dir), NOT the skill folder. Pi's own internal expander uses
	// `skill.baseDir = dirname(filePath)` (agent-session.js:855, skills.js:214);
	// rpiv-args must match exactly, or `${SKILL_DIR}` and the
	// "References are relative to" footer diverge from Pi.
	it.each([
		{
			label: "project .pi/skills/<name>/SKILL.md (sourceInfo.baseDir = project root)",
			skillRel: [".pi", "skills", "foo", "SKILL.md"],
			scopeBaseDirRel: [] as string[],
		},
		{
			label: "project .pi/skills/<name>.md flat (sourceInfo.baseDir = project root)",
			skillRel: [".pi", "skills", "flat.md"],
			scopeBaseDirRel: [],
		},
		{
			label: "project .agents/skills/<name>/SKILL.md (sourceInfo.baseDir = .agents dir)",
			skillRel: [".agents", "skills", "bar", "SKILL.md"],
			scopeBaseDirRel: [".agents"],
		},
		{
			label: "user ~/.pi/agent/skills/<name>/SKILL.md (sourceInfo.baseDir = agent dir)",
			skillRel: ["pi", "agent", "skills", "baz", "SKILL.md"],
			scopeBaseDirRel: ["pi", "agent"],
		},
		{
			label: "user ~/.agents/skills/<name>/SKILL.md (sourceInfo.baseDir = ~/.agents)",
			skillRel: ["agents", "skills", "qux", "SKILL.md"],
			scopeBaseDirRel: ["agents"],
		},
	])("$label → ${SKILL_DIR} = dirname(filePath)", async ({ skillRel, scopeBaseDirRel }) => {
		const filePath = join(tmpDir, ...skillRel);
		const skillFolder = join(tmpDir, ...skillRel.slice(0, -1));
		const scopeBaseDir = join(tmpDir, ...scopeBaseDirRel);
		mkdirSync(skillFolder, { recursive: true });
		writeFileSync(filePath, "marker ${SKILL_DIR}", "utf-8");
		// The folder name (or basename of the .md file for the flat case) is the skill name.
		const name =
			skillRel[skillRel.length - 1] === "SKILL.md"
				? skillRel[skillRel.length - 2]!
				: skillRel[skillRel.length - 1]!.replace(/\.md$/, "");

		setSkills([{ name, filePath, baseDir: scopeBaseDir }]);

		const r = await handleInput({ text: `/skill:${name}` } as InputEvent, ctx, pi);
		const text = (r as { text: string }).text;

		expect(text).toContain(`marker ${skillFolder}`);
		expect(text).toContain(`References are relative to ${skillFolder}.`);
		// Sanity: the misleading scope baseDir is NOT used as the substitution root.
		if (scopeBaseDir !== skillFolder) {
			expect(text).not.toContain(`References are relative to ${scopeBaseDir}.`);
		}
	});
});

describe("handleInput — backward compatibility (byte-identical regression fixture)", () => {
	it("a skill with NO shell syntax, NO variables, NO tokens emits byte-identically to pre-shell-execution behavior", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "regress", body: "plain body line 1\nplain body line 2" }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:regress some trailing args" } as InputEvent, ctx, pi);
		// Pin the EXACT bytes — this is the regression fixture per Verification Notes.
		const expected =
			`<skill name="regress" location="${entries[0].filePath}">\n` +
			`References are relative to ${tmpDir}.\n\n` +
			`plain body line 1\nplain body line 2\n` +
			`</skill>\n\n` +
			`some trailing args`;
		expect(r).toEqual({ action: "transform", text: expected });
	});
});

describe("handleInput — shell-timeout frontmatter", () => {
	it("accepts shell-timeout as a numeric frontmatter value (no error)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "t1", body: "ok", frontmatter: { "shell-timeout": "5" } }]);
		setSkills(entries);
		const r = await handleInput({ text: "/skill:t1" } as InputEvent, ctx, pi);
		expect((r as { text: string }).text).toContain("ok");
	});
});

describe("executeShellInBody", () => {
	it("returns body unchanged when no shell syntax is present (pass-through)", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("plain body", testPi, "/tmp", 1000);
		expect(out).toBe("plain body");
		expect(execFn).not.toHaveBeenCalled();
	});

	it("replaces inline !`cmd` with stdout on success", async () => {
		const execFn = vi.fn(async () => ({ stdout: "hello\n", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("before !`echo hello` after", testPi, "/tmp", 1000);
		expect(out).toBe("before hello\n after");
	});

	it("replaces block ```! ... ``` with stdout on success", async () => {
		const execFn = vi.fn(async () => ({ stdout: "line1\nline2\n", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("before\n```!\ngit status\n```\nafter", testPi, "/tmp", 1000);
		expect(out).toContain("line1\nline2");
		expect(out).not.toContain("```!");
	});

	it("runs commands sequentially (FR11 — never Promise.all)", async () => {
		const order: string[] = [];
		const execFn = vi.fn(async (_cmd: string, args: string[]) => {
			const cmd = args[1] ?? "";
			order.push(`start:${cmd}`);
			await new Promise((r) => setTimeout(r, 10));
			order.push(`end:${cmd}`);
			return { stdout: cmd, stderr: "", code: 0, killed: false };
		});
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		await executeShellInBody("!`a` !`b` !`c`", testPi, "/tmp", 1000);
		expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
	});

	it("FR5: killed=true → [Shell error: timed out after Ns]", async () => {
		const execFn = vi.fn(async () => ({ stdout: "partial\n", stderr: "", code: 1, killed: true }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`sleep 60`", testPi, "/tmp", 5000);
		expect(out).toBe("[Shell error: timed out after 5s]");
	});

	it("R4: sub-second shell-timeout displays 1s (floor), not 0s", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: true }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`x`", testPi, "/tmp", 500);
		expect(out).toBe("[Shell error: timed out after 1s]");
	});

	it("FR5: non-zero exit → [Shell error: exit code N]\\n<stderr>", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "oh no\n", code: 2, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`false`", testPi, "/tmp", 1000);
		expect(out).toBe("[Shell error: exit code 2]\noh no\n");
	});

	it("R1: non-zero exit truncates large stderr through the same 50KB / 2000-line budget as success", async () => {
		const bigStderr = `${"ERR\n".repeat(20_000)}`; // ~80KB / 20,000 lines
		const execFn = vi.fn(async () => ({ stdout: "", stderr: bigStderr, code: 2, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`failingcmd`", testPi, "/tmp", 1000);
		expect(out.startsWith("[Shell error: exit code 2]\n")).toBe(true);
		expect(out.length).toBeLessThan(bigStderr.length); // truncated
		expect(out).toMatch(/\[truncated: hit .+\]$/);
	});

	it("FR5: timeout wins over non-zero code (killed checked first)", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 1, killed: true }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`sleep 60`", testPi, "/tmp", 3000);
		expect(out).toBe("[Shell error: timed out after 3s]");
		expect(out).not.toContain("exit code");
	});

	it("appends [stderr] block when both stdout and stderr produced content", async () => {
		const execFn = vi.fn(async () => ({ stdout: "ok\n", stderr: "warn\n", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`x`", testPi, "/tmp", 1000);
		expect(out).toBe("ok\n[stderr]\nwarn\n");
	});

	it("stderr-only success: stderr promoted under [stderr] header", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "diagnostic\n", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`x`", testPi, "/tmp", 1000);
		expect(out).toBe("[stderr]\ndiagnostic\n");
	});

	it("both-empty success returns empty string", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`x`", testPi, "/tmp", 1000);
		expect(out).toBe("");
	});

	it("truncates >50KB output and appends [truncated: hit ...] footer", async () => {
		const big = `${"x".repeat(60_000)}\n`;
		const execFn = vi.fn(async () => ({ stdout: big, stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`big`", testPi, "/tmp", 1000);
		expect(out.length).toBeLessThan(big.length);
		expect(out).toMatch(/\[truncated: hit .+\]$/);
	});

	it("truncates >2000-line output (lines-first wins)", async () => {
		const tall = `${"line\n".repeat(2500)}`;
		const execFn = vi.fn(async () => ({ stdout: tall, stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`tall`", testPi, "/tmp", 1000);
		expect(out).toMatch(/\[truncated: hit 2000 lines\]$/);
	});

	it("block-before-inline ordering: inline backticks inside block are preserved as one program", async () => {
		const execFn = vi.fn(async (_cmd: string, args: string[]) => ({
			stdout: `EXEC[len=${(args[1] ?? "").length}]`,
			stderr: "",
			code: 0,
			killed: false,
		}));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const body = 'X\n```!\necho hi && echo "with !`inline` text"\n```\nY';
		const out = await executeShellInBody(body, testPi, "/tmp", 1000);
		expect(execFn).toHaveBeenCalledTimes(1);
		expect(out).toContain("X\nEXEC[");
		expect(out).toContain("\nY");
		expect(out).not.toContain("!`inline`");
	});

	it("uses sh -c on POSIX (non-win32 platform branch)", async () => {
		const orig = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		try {
			const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
			const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
			await executeShellInBody("!`pwd`", testPi, "/tmp", 1000);
			expect(execFn).toHaveBeenCalledWith("sh", ["-c", "pwd"], { cwd: "/tmp", timeout: 1000 });
		} finally {
			if (orig) Object.defineProperty(process, "platform", orig);
		}
	});

	it("uses powershell.exe -Command on Windows", async () => {
		const orig = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
			const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
			await executeShellInBody("!`Get-Location`", testPi, "C:\\tmp", 1000);
			expect(execFn).toHaveBeenCalledWith("powershell.exe", ["-Command", "Get-Location"], {
				cwd: "C:\\tmp",
				timeout: 1000,
			});
		} finally {
			if (orig) Object.defineProperty(process, "platform", orig);
		}
	});

	it("passes cwd and timeout through to pi.exec options", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		await executeShellInBody("!`x`", testPi, "/some/cwd", 7777);
		expect(execFn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
			cwd: "/some/cwd",
			timeout: 7777,
		});
	});

	it("inline pattern does not match across newlines", async () => {
		const execFn = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("!`echo a\necho b`", testPi, "/tmp", 1000);
		expect(execFn).not.toHaveBeenCalled();
		expect(out).toBe("!`echo a\necho b`");
	});

	it("R3: literal `` !`` `` (empty backticks) is left verbatim — pi.exec is never called with an empty -c", async () => {
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("prose with !`` empty backticks", testPi, "/tmp", 1000);
		expect(execFn).not.toHaveBeenCalled();
		expect(out).toBe("prose with !`` empty backticks");
	});

	it("R2: block stdout containing literal !`evil` does NOT re-execute via the inline pass", async () => {
		// Block stdout LITERALLY contains the inline shell syntax `!`evil``. Without
		// the mask-and-restore pass, the inline regex would re-match and trigger a
		// second pi.exec. We assert exactly ONE pi.exec call (the block) and that
		// the inline syntax survives verbatim in the output.
		const execFn = vi.fn(async () => ({
			stdout: "echo result !`evil cmd`",
			stderr: "",
			code: 0,
			killed: false,
		}));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const out = await executeShellInBody("X\n```!\ngenerate-something\n```\nY", testPi, "/tmp", 1000);
		expect(execFn).toHaveBeenCalledTimes(1);
		expect(out).toContain("!`evil cmd`"); // inline syntax preserved literally
		expect(out).toContain("X\n");
		expect(out).toContain("\nY");
	});
});

describe("handleInput — shell execution (integration)", () => {
	it("executes !`cmd` on the no-token emit path (FR10 always-on)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "sh1", body: "branch !`git rev-parse HEAD`" }]);
		setSkills(entries);
		const execFn = vi.fn(async () => ({ stdout: "abc1234", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const r = await handleInput({ text: "/skill:sh1" } as InputEvent, ctx, testPi);
		expect((r as { text: string }).text).toContain("branch abc1234");
	});

	it("executes !`cmd` on the token emit path too (FR10 always-on)", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "sh2", body: "$1 at !`pwd`" }]);
		setSkills(entries);
		const execFn = vi.fn(async () => ({ stdout: "/home/me", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const r = await handleInput({ text: "/skill:sh2 hello" } as InputEvent, ctx, testPi);
		expect((r as { text: string }).text).toContain("hello at /home/me");
	});

	it("forwards process.cwd() and resolved timeout to pi.exec", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "sh3", body: "!`x`", frontmatter: { "shell-timeout": "5" } }]);
		setSkills(entries);
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		await handleInput({ text: "/skill:sh3" } as InputEvent, ctx, testPi);
		expect(execFn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
			cwd: process.cwd(),
			timeout: 5000,
		});
	});

	it("uses DEFAULT_SHELL_TIMEOUT_MS (120s) when frontmatter omits shell-timeout", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "sh4", body: "!`x`" }]);
		setSkills(entries);
		const execFn = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		await handleInput({ text: "/skill:sh4" } as InputEvent, ctx, testPi);
		expect(execFn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
			cwd: process.cwd(),
			timeout: 120_000,
		});
	});
});

describe("handleInput — $ARGUMENTS+shell injection (documented FRD trust model)", () => {
	it("pipeline order (tokens → variables → shell) means $ARGUMENTS-injected !`...` reaches shell execution — local = trusted, NOT a vuln", async () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "inj", body: "user said: $ARGUMENTS" }]);
		setSkills(entries);
		const execFn = vi.fn(async () => ({ stdout: "PWNED", stderr: "", code: 0, killed: false }));
		const { pi: testPi } = createMockPi({ exec: execFn as never, getCommands: getCommandsFn as never });
		const r = await handleInput({ text: "/skill:inj !`echo PWNED`" } as InputEvent, ctx, testPi);
		expect(execFn).toHaveBeenCalledTimes(1);
		expect((r as { text: string }).text).toContain("user said: PWNED");
	});
});

describe("registerArgsHandler", () => {
	it("invalidates on session_start reason=startup", async () => {
		const { pi: testPi, captured } = createMockPi({ getCommands: getCommandsFn as never });
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "body" }]);
		setSkills(entries);
		registerArgsHandler(testPi);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, testPi);
		expect(getCommandsFn).toHaveBeenCalledTimes(1);
		const handler = captured.events.get("session_start")?.[0];
		handler?.({ reason: "startup" } as never);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, testPi);
		expect(getCommandsFn).toHaveBeenCalledTimes(2);
	});
	it("invalidates on session_start reason=reload", async () => {
		const { pi: testPi, captured } = createMockPi({ getCommands: getCommandsFn as never });
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "body" }]);
		setSkills(entries);
		registerArgsHandler(testPi);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, testPi);
		const handler = captured.events.get("session_start")?.[0];
		handler?.({ reason: "reload" } as never);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, testPi);
		expect(getCommandsFn).toHaveBeenCalledTimes(2);
	});
	it("does NOT invalidate on other session_start reasons", async () => {
		const { pi: testPi, captured } = createMockPi({ getCommands: getCommandsFn as never });
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "body" }]);
		setSkills(entries);
		registerArgsHandler(testPi);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, testPi);
		const handler = captured.events.get("session_start")?.[0];
		handler?.({ reason: "resume" } as never);
		await handleInput({ text: "/skill:foo" } as InputEvent, ctx, testPi);
		expect(getCommandsFn).toHaveBeenCalledTimes(1);
	});
	it("wires input handler", () => {
		const { pi: testPi, captured } = createMockPi();
		registerArgsHandler(testPi);
		expect(captured.events.has("input")).toBe(true);
		expect(captured.events.has("session_start")).toBe(true);
		expect(captured.events.has("before_agent_start")).toBe(true);
	});
	it("input arrow forwards ctx + closes over pi (registered arrow signature)", async () => {
		const { pi: testPi, captured } = createMockPi({ getCommands: getCommandsFn as never });
		const entries = writeSkillsDir(tmpDir, [{ name: "wired", body: "at ${SKILL_DIR}" }]);
		setSkills(entries);
		registerArgsHandler(testPi);
		const inputHandler = captured.events.get("input")?.[0];
		expect(inputHandler).toBeDefined();
		const out = (await inputHandler?.({ text: "/skill:wired" } as never, ctx as never)) as {
			action: string;
			text: string;
		};
		expect(out.action).toBe("transform");
		expect(out.text).toContain(`at ${tmpDir}`);
	});
});

describe("handleBeforeAgentStart — system-prompt protocol", () => {
	it("prepends the protocol to event.systemPrompt (highest-attention position)", () => {
		const result = handleBeforeAgentStart({
			type: "before_agent_start",
			prompt: "anything",
			systemPrompt: "BASE",
		} as unknown as BeforeAgentStartEvent);
		expect(result).toEqual({ systemPrompt: `${SKILL_INVOCATION_PROTOCOL}BASE` });
	});
	it("read-then-prepend (preserves prior extension chain modifications)", () => {
		const prior = "BASE\n\n## prior-ext addition\nHello.";
		const result = handleBeforeAgentStart({
			type: "before_agent_start",
			prompt: "x",
			systemPrompt: prior,
		} as unknown as BeforeAgentStartEvent);
		expect((result.systemPrompt as string).startsWith(SKILL_INVOCATION_PROTOCOL)).toBe(true);
		expect((result.systemPrompt as string).endsWith(prior)).toBe(true);
	});
	it("is deterministic across calls (cache-friendly bytes)", () => {
		const a = handleBeforeAgentStart({
			type: "before_agent_start",
			prompt: "p1",
			systemPrompt: "S",
		} as unknown as BeforeAgentStartEvent);
		const b = handleBeforeAgentStart({
			type: "before_agent_start",
			prompt: "p2",
			systemPrompt: "S",
		} as unknown as BeforeAgentStartEvent);
		expect(a.systemPrompt).toBe(b.systemPrompt);
	});
	it("protocol references the parseSkillBlock format and the trailing-text role", () => {
		expect(SKILL_INVOCATION_PROTOCOL).toContain("<skill name=");
		expect(SKILL_INVOCATION_PROTOCOL).toContain("</skill>");
		expect(SKILL_INVOCATION_PROTOCOL.toLowerCase()).toContain("argument");
	});
	it("protocol defines the `Skill input:` trailer label emitted by the token path (keep in sync)", () => {
		expect(SKILL_INVOCATION_PROTOCOL).toContain(SKILL_INPUT_LABEL);
	});
	it("registered handler returns the prepended systemPrompt when invoked via Pi event bus", () => {
		const { pi: testPi, captured } = createMockPi();
		registerArgsHandler(testPi);
		const handler = captured.events.get("before_agent_start")?.[0];
		expect(handler).toBeDefined();
		const out = handler?.({
			type: "before_agent_start",
			prompt: "p",
			systemPrompt: "BASE",
		} as never) as { systemPrompt: string };
		expect(out.systemPrompt).toBe(`${SKILL_INVOCATION_PROTOCOL}BASE`);
	});
});
