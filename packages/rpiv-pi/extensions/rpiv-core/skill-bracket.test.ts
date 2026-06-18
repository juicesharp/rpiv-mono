import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionCapture } from "./session-capture.js";
import { parseSkillInvocation, registerSkillBracket } from "./skill-bracket.js";

const BASELINE_MODEL = { provider: "anthropic", id: "baseline" };

interface Handlers {
	input?: (event: { text?: string; source?: string }) => Promise<{ action: string }> | { action: string };
	agent_end?: (event?: unknown) => Promise<unknown> | unknown;
	session_start?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
}

function makePi(opts: { setModelResult?: boolean; baselineThinking?: string } = {}) {
	const handlers: Handlers = {};
	const setModel = vi.fn(async () => opts.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const pi = {
		on: vi.fn((event: string, h: (...args: unknown[]) => unknown) => {
			(handlers as Record<string, unknown>)[event] = h;
		}),
		setModel,
		setThinkingLevel,
		getThinkingLevel: vi.fn(() => opts.baselineThinking ?? "medium"),
	} as unknown as ExtensionAPI;
	return { pi, setModel, setThinkingLevel, handlers };
}

function writeModels(config: unknown) {
	const dir = join(process.env.HOME!, ".config", "rpiv-pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify(config), "utf-8");
}

async function setupBracket(opts: { setModelResult?: boolean; baselineThinking?: string } = {}) {
	const fake = makePi(opts);
	registerSessionCapture(fake.pi);
	registerSkillBracket(fake.pi);
	const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
	await fake.handlers.session_start?.({}, { modelRegistry: registry, model: BASELINE_MODEL });
	return { ...fake, registry };
}

describe("parseSkillInvocation", () => {
	it("parses raw /skill:<name> with args", () => {
		expect(parseSkillInvocation("/skill:commit do thing")).toEqual({ name: "commit" });
	});
	it("parses raw /skill:<name> with no args", () => {
		expect(parseSkillInvocation("/skill:commit")).toEqual({ name: "commit" });
	});
	it("returns undefined for /skill: with empty name", () => {
		expect(parseSkillInvocation("/skill:")).toBeUndefined();
	});
	it("parses wrapped <skill name=…> form (post-rpiv-args transform)", () => {
		// Byte-exact against parseSkillBlock regex (Pi SDK agent-session.js:40):
		//   /<skill name="..." location="...">\n([\s\S]*?)\n</skill>/
		// Mandatory \n after the opening `>` and before `</skill>`.
		const wrapped = '<skill name="research" location="/skills/research/SKILL.md">\nbody\n</skill>\n\nargs';
		expect(parseSkillInvocation(wrapped)).toEqual({ name: "research" });
	});
	it("returns undefined for unrelated text", () => {
		expect(parseSkillInvocation("hello world")).toBeUndefined();
	});
});

describe("skill-bracket — input arming", () => {
	it("arms baseline + applies override on source=interactive + known skill", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7", thinking: "minimal" } } });
		const { handlers, setModel, setThinkingLevel } = await setupBracket();

		const result = await handlers.input!({ text: "/skill:commit add feature", source: "interactive" });

		expect(result).toEqual({ action: "continue" });
		expect(setModel).toHaveBeenCalledWith({ provider: "zai", id: "glm-4-7" });
		expect(setThinkingLevel).toHaveBeenCalledWith("minimal");
	});

	it("no-op on source=extension (workflow path)", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7" } } });
		const { handlers, setModel, setThinkingLevel } = await setupBracket();
		await handlers.input!({ text: "/skill:commit", source: "extension" });
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("no-op on source=rpc", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7" } } });
		const { handlers, setModel } = await setupBracket();
		await handlers.input!({ text: "/skill:commit", source: "rpc" });
		expect(setModel).not.toHaveBeenCalled();
	});

	it("no-op when skill is unknown (no explicit entry)", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7" } } });
		const { handlers, setModel } = await setupBracket();
		await handlers.input!({ text: "/skill:unknown", source: "interactive" });
		expect(setModel).not.toHaveBeenCalled();
	});

	it("no-op when defaults exist but skill-specific entry does not (Decision 7 refined)", async () => {
		writeModels({ defaults: "anthropic/opus" });
		const { handlers, setModel } = await setupBracket();
		await handlers.input!({ text: "/skill:commit", source: "interactive" });
		expect(setModel).not.toHaveBeenCalled();
	});

	it("parses wrapped <skill name=…> form when rpiv-args transformed first", async () => {
		writeModels({ skills: { research: { model: "openai/gpt-5.5" } } });
		const { handlers, setModel } = await setupBracket();
		// Byte-exact against parseSkillBlock regex — mandatory \n after `>` and before `</skill>`.
		const wrapped = '<skill name="research" location="/SKILL.md">\nbody\n</skill>\n\nargs';
		await handlers.input!({ text: wrapped, source: "interactive" });
		expect(setModel).toHaveBeenCalledWith({ provider: "openai", id: "gpt-5.5" });
	});
});

describe("skill-bracket — agent_end restoration", () => {
	it("restores baseline model + thinking after a full arm cycle", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7", thinking: "minimal" } } });
		const { handlers, setModel, setThinkingLevel } = await setupBracket({ baselineThinking: "low" });

		await handlers.input!({ text: "/skill:commit", source: "interactive" });
		setModel.mockClear();
		setThinkingLevel.mockClear();

		await handlers.agent_end!({});

		expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
		expect(setThinkingLevel).toHaveBeenLastCalledWith("low");
	});

	it("second agent_end after one cycle is a no-op", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7" } } });
		const { handlers, setModel } = await setupBracket();
		await handlers.input!({ text: "/skill:commit", source: "interactive" });
		await handlers.agent_end!({});
		setModel.mockClear();
		await handlers.agent_end!({});
		expect(setModel).not.toHaveBeenCalled();
	});

	it("does not call setModel/setThinkingLevel when input never armed", async () => {
		writeModels({});
		const { handlers, setModel, setThinkingLevel } = await setupBracket();
		await handlers.input!({ text: "/skill:unknown", source: "interactive" });
		await handlers.agent_end!({});
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});
});

describe("skill-bracket — stale-ctx resilience", () => {
	const STALE = "This extension ctx is stale after session replacement or reload.";

	it("swallows stale-ctx on input arm (bracket goes inert)", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7", thinking: "minimal" } } });
		const fake = makePi();
		(fake.pi as unknown as Record<string, unknown>).setModel = vi.fn(async () => {
			throw new Error(STALE);
		});
		registerSessionCapture(fake.pi);
		registerSkillBracket(fake.pi);
		const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
		await fake.handlers.session_start?.({}, { modelRegistry: registry, model: BASELINE_MODEL });

		await expect(fake.handlers.input!({ text: "/skill:commit", source: "interactive" })).resolves.toEqual({
			action: "continue",
		});
	});

	it("swallows stale-ctx on agent_end restore AND clears state", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7" } } });
		const fake = makePi();
		registerSessionCapture(fake.pi);
		registerSkillBracket(fake.pi);
		const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
		await fake.handlers.session_start?.({}, { modelRegistry: registry, model: BASELINE_MODEL });

		await fake.handlers.input!({ text: "/skill:commit", source: "interactive" });

		(fake.pi as unknown as Record<string, unknown>).setModel = vi.fn(async () => {
			throw new Error(STALE);
		});
		await expect(fake.handlers.agent_end!({})).resolves.toBeUndefined();

		const restoredSetModel = vi.fn(async () => true);
		(fake.pi as unknown as Record<string, unknown>).setModel = restoredSetModel;
		await fake.handlers.agent_end!({});
		expect(restoredSetModel).not.toHaveBeenCalled();
	});

	it("propagates non-stale errors", async () => {
		writeModels({ skills: { commit: { model: "zai/glm-4-7", thinking: "minimal" } } });
		const fake = makePi();
		(fake.pi as unknown as Record<string, unknown>).setModel = vi.fn(async () => {
			throw new Error("boom: real bug");
		});
		registerSessionCapture(fake.pi);
		registerSkillBracket(fake.pi);
		const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
		await fake.handlers.session_start?.({}, { modelRegistry: registry, model: BASELINE_MODEL });

		await expect(fake.handlers.input!({ text: "/skill:commit", source: "interactive" })).rejects.toThrow("boom");
	});
});

describe("skill-bracket — soft-fail on setModel returning false", () => {
	it("warns but still applies thinking", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeModels({ skills: { commit: { model: "zai/glm-4-7", thinking: "minimal" } } });
		const { handlers, setThinkingLevel } = await setupBracket({ setModelResult: false });

		await handlers.input!({ text: "/skill:commit", source: "interactive" });

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("setModel failed for /skill:commit"));
		expect(setThinkingLevel).toHaveBeenCalledWith("minimal");
		warn.mockRestore();
	});
});

// Local sweep — repo-wide test/setup.ts beforeEach handles
// __resetSkillBracketState + __resetSessionCaptureState.
beforeEach(() => {
	vi.restoreAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});
