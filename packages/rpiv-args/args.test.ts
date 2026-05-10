/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests contain literal "${...}" substitution tokens */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		loadSkills: vi.fn(() => ({ skills: [] })),
	};
});

import { type BeforeAgentStartEvent, loadSkills } from "@earendil-works/pi-coding-agent";
import {
	collectDefaultSkillPaths,
	handleBeforeAgentStart,
	handleInput,
	invalidateSkillIndex,
	parseCommandArgs,
	registerArgsHandler,
	SKILL_INVOCATION_PROTOCOL,
	substituteArgs,
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
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-args-"));
	vi.mocked(loadSkills).mockClear();
	vi.mocked(loadSkills).mockReturnValue({ skills: [] } as unknown as ReturnType<typeof loadSkills>);
	invalidateSkillIndex();
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

describe("collectDefaultSkillPaths", () => {
	it("includes Pi and cross-harness .agents skill dirs in precedence order", () => {
		const repoDir = join(tmpDir, "repo");
		const nestedDir = join(repoDir, "packages", "app");
		const agentDir = join(tmpDir, "agent");
		const nestedAgentsSkills = join(nestedDir, ".agents", "skills");
		const repoAgentsSkills = join(repoDir, ".agents", "skills");
		const userPiSkills = join(agentDir, "skills");
		mkdirSync(join(repoDir, ".git"), { recursive: true });
		mkdirSync(nestedAgentsSkills, { recursive: true });
		mkdirSync(repoAgentsSkills, { recursive: true });
		mkdirSync(userPiSkills, { recursive: true });

		const paths = collectDefaultSkillPaths(nestedDir, agentDir);

		expect(paths).toContain(nestedAgentsSkills);
		expect(paths).toContain(repoAgentsSkills);
		expect(paths).toContain(userPiSkills);
		expect(paths.indexOf(nestedAgentsSkills)).toBeLessThan(paths.indexOf(repoAgentsSkills));
		expect(paths.indexOf(repoAgentsSkills)).toBeLessThan(paths.indexOf(userPiSkills));
	});
});

describe("invalidateSkillIndex — lazy memoisation", () => {
	it("builds index once across multiple handleInput calls", () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "hello" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		handleInput({ text: "/skill:foo" } as InputEvent);
		handleInput({ text: "/skill:foo" } as InputEvent);
		expect(loadSkills).toHaveBeenCalledTimes(1);
	});
	it("passes Pi 0.70 required loadSkills options (cwd + agentDir + skillPaths + includeDefaults)", () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "hello" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		handleInput({ text: "/skill:foo" } as InputEvent);
		expect(loadSkills).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: expect.any(String),
				agentDir: expect.any(String),
				skillPaths: expect.any(Array),
				includeDefaults: false,
			}),
		);
		const opts = vi.mocked(loadSkills).mock.calls[0]![0];
		expect(opts.agentDir.length).toBeGreaterThan(0);
	});
	it("rebuilds after invalidateSkillIndex()", () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "hello" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		handleInput({ text: "/skill:foo" } as InputEvent);
		invalidateSkillIndex();
		handleInput({ text: "/skill:foo" } as InputEvent);
		expect(loadSkills).toHaveBeenCalledTimes(2);
	});
	it("lazy: no loadSkills call until first handleInput", () => {
		invalidateSkillIndex();
		expect(loadSkills).not.toHaveBeenCalled();
	});
});

describe("handleInput — gates", () => {
	it("passes through text not starting with /skill:", () => {
		const r = handleInput({ text: "hello" } as InputEvent);
		expect(r).toEqual({ action: "continue" });
	});
	it("passes through already-wrapped <skill ...> re-entry", () => {
		const r = handleInput({ text: '<skill name="x" location="y">body</skill>' } as InputEvent);
		expect(r).toEqual({ action: "continue" });
	});
	it("passes through unknown skill name", () => {
		vi.mocked(loadSkills).mockReturnValue({ skills: [] } as unknown as ReturnType<typeof loadSkills>);
		const r = handleInput({ text: "/skill:nope" } as InputEvent);
		expect(r).toEqual({ action: "continue" });
	});
	it("passes through when filePath read fails", () => {
		const entries = [{ name: "ghost", filePath: join(tmpDir, "missing.md"), baseDir: tmpDir }];
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		const r = handleInput({ text: "/skill:ghost" } as InputEvent);
		expect(r).toEqual({ action: "continue" });
	});
});

describe("handleInput — emit paths (byte-exact wrapper)", () => {
	it("emits no-substitution wrapper when body has no tokens", () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "hello world" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		const r = handleInput({ text: "/skill:foo extra" } as InputEvent);
		const expected =
			`<skill name="foo" location="${entries[0].filePath}">\n` +
			`References are relative to ${tmpDir}.\n\n` +
			`hello world\n` +
			`</skill>\n\n` +
			`extra`;
		expect(r).toEqual({ action: "transform", text: expected });
	});
	it("emits substituted wrapper without trailing args (args consumed by substitution)", () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "bar", body: "do $1 then $2" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		const r = handleInput({ text: "/skill:bar a b" } as InputEvent);
		const expected =
			`<skill name="bar" location="${entries[0].filePath}">\n` +
			`References are relative to ${tmpDir}.\n\n` +
			`do a then b\n` +
			`</skill>`;
		expect(r).toEqual({ action: "transform", text: expected });
	});
	it("does NOT duplicate args after </skill> when body has tokens (LLM attention fix)", () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "discover", body: "Input: $ARGUMENTS" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		const r = handleInput({ text: "/skill:discover write a file" } as InputEvent);
		const text = (r as { text: string }).text;
		expect(text).toContain("Input: write a file");
		expect(text.endsWith("</skill>")).toBe(true);
		// Sanity: the imperative must appear exactly once (inside the block, not after).
		expect(text.match(/write a file/g)?.length).toBe(1);
	});
	it("strips frontmatter before substitution", () => {
		const entries = writeSkillsDir(tmpDir, [
			{ name: "baz", body: "body $1", frontmatter: { "argument-hint": "thing" } },
		]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		const r = handleInput({ text: "/skill:baz X" } as InputEvent);
		expect((r as { text: string }).text).toContain("body X");
		expect((r as { text: string }).text).not.toContain("argument-hint");
	});
	it("empty args → no trailing block", () => {
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "x" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		const r = handleInput({ text: "/skill:foo" } as InputEvent);
		expect((r as { text: string }).text.endsWith("</skill>")).toBe(true);
	});
});

describe("registerArgsHandler", () => {
	it("invalidates on session_start reason=startup", () => {
		const { pi, captured } = createMockPi();
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "body" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		registerArgsHandler(pi);
		handleInput({ text: "/skill:foo" } as InputEvent);
		expect(loadSkills).toHaveBeenCalledTimes(1);
		const handler = captured.events.get("session_start")?.[0];
		handler?.({ reason: "startup" } as never);
		handleInput({ text: "/skill:foo" } as InputEvent);
		expect(loadSkills).toHaveBeenCalledTimes(2);
	});
	it("invalidates on session_start reason=reload", () => {
		const { pi, captured } = createMockPi();
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "body" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		registerArgsHandler(pi);
		handleInput({ text: "/skill:foo" } as InputEvent);
		const handler = captured.events.get("session_start")?.[0];
		handler?.({ reason: "reload" } as never);
		handleInput({ text: "/skill:foo" } as InputEvent);
		expect(loadSkills).toHaveBeenCalledTimes(2);
	});
	it("does NOT invalidate on other session_start reasons", () => {
		const { pi, captured } = createMockPi();
		const entries = writeSkillsDir(tmpDir, [{ name: "foo", body: "body" }]);
		vi.mocked(loadSkills).mockReturnValue({ skills: entries } as unknown as ReturnType<typeof loadSkills>);
		registerArgsHandler(pi);
		handleInput({ text: "/skill:foo" } as InputEvent);
		const handler = captured.events.get("session_start")?.[0];
		handler?.({ reason: "resume" } as never);
		handleInput({ text: "/skill:foo" } as InputEvent);
		expect(loadSkills).toHaveBeenCalledTimes(1);
	});
	it("wires input handler", () => {
		const { pi, captured } = createMockPi();
		registerArgsHandler(pi);
		expect(captured.events.has("input")).toBe(true);
		expect(captured.events.has("session_start")).toBe(true);
		expect(captured.events.has("before_agent_start")).toBe(true);
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
	it("registered handler returns the prepended systemPrompt when invoked via Pi event bus", () => {
		const { pi, captured } = createMockPi();
		registerArgsHandler(pi);
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
