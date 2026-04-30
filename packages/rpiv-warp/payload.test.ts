import { buildSessionEntries, createMockCtx, makeAssistantMessage, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_ID,
	baseEnvelope,
	buildIdlePromptPayload,
	buildSessionStartPayload,
	buildStopPayload,
	buildToolCompletePayload,
	extractMessageText,
	lastAssistantText,
	lastUserText,
	projectName,
	serializePayload,
	TRUNCATE_LIMIT,
	truncate,
} from "./payload.js";
import { PLUGIN_MAX_PROTOCOL_VERSION } from "./protocol.js";

beforeEach(() => {
	process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
});

describe("truncate", () => {
	it("returns input unchanged when ≤ limit", () => {
		expect(truncate("short", 10)).toBe("short");
	});
	it("ellipsis-truncates over the limit", () => {
		expect(truncate("a".repeat(10), 5)).toBe("aa...");
	});
	it("uses TRUNCATE_LIMIT (200) by default", () => {
		const long = "x".repeat(TRUNCATE_LIMIT + 50);
		const r = truncate(long);
		expect(r.length).toBe(TRUNCATE_LIMIT);
		expect(r.endsWith("...")).toBe(true);
	});
});

describe("projectName", () => {
	it("returns the basename of cwd", () => {
		expect(projectName("/Users/me/projects/awesome-thing")).toBe("awesome-thing");
	});
});

describe("extractMessageText", () => {
	it("passes through string content", () => {
		expect(extractMessageText("hello")).toBe("hello");
	});
	it("joins text-blocks with newline", () => {
		expect(
			extractMessageText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
	});
	it("filters out non-text content", () => {
		const content = [
			{ type: "text", text: "keep" },
			{ type: "image", data: "...", mimeType: "image/png" },
		] as never;
		expect(extractMessageText(content)).toBe("keep");
	});
	it("returns empty string for empty array", () => {
		expect(extractMessageText([])).toBe("");
	});
});

describe("lastUserText / lastAssistantText", () => {
	it("returns empty string on empty branch", () => {
		expect(lastUserText([])).toBe("");
		expect(lastAssistantText([])).toBe("");
	});
	it("reverse-scans to the most recent user message", () => {
		const branch = buildSessionEntries([
			makeUserMessage("first"),
			makeAssistantMessage({ text: "ack" }),
			makeUserMessage("second"),
		]);
		expect(lastUserText(branch)).toBe("second");
	});
	it("reverse-scans to the most recent assistant message", () => {
		const branch = buildSessionEntries([
			makeAssistantMessage({ text: "earlier" }),
			makeUserMessage("ask"),
			makeAssistantMessage({ text: "later" }),
		]);
		expect(lastAssistantText(branch)).toBe("later");
	});
	it("truncates over TRUNCATE_LIMIT", () => {
		const long = "x".repeat(TRUNCATE_LIMIT + 50);
		const branch = buildSessionEntries([makeUserMessage(long)]);
		expect(lastUserText(branch).length).toBe(TRUNCATE_LIMIT);
	});
});

describe("baseEnvelope", () => {
	it("populates v / agent / event / session_id / cwd / project", () => {
		const ctx = createMockCtx({ cwd: "/tmp/projects/widget" });
		const env = baseEnvelope("session_start", ctx);
		expect(env).toEqual({
			v: PLUGIN_MAX_PROTOCOL_VERSION,
			agent: AGENT_ID,
			event: "session_start",
			session_id: "test-session",
			cwd: "/tmp/projects/widget",
			project: "widget",
		});
	});
	it("clamps v to PLUGIN_MAX_PROTOCOL_VERSION when env advertises a higher protocol", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "2";
		const env = baseEnvelope("session_start", createMockCtx({ cwd: "/tmp/projects/widget" }));
		expect(env.v).toBe(PLUGIN_MAX_PROTOCOL_VERSION);
	});
});

describe("build*Payload", () => {
	it("buildSessionStartPayload sets event:session_start", () => {
		expect(buildSessionStartPayload(createMockCtx()).event).toBe("session_start");
	});
	it("buildStopPayload pulls last user + assistant from branch", () => {
		const branch = buildSessionEntries([
			makeUserMessage("how do I deploy?"),
			makeAssistantMessage({ text: "run npm publish" }),
		]);
		const ctx = createMockCtx({ branch });
		const p = buildStopPayload(ctx, branch);
		expect(p.event).toBe("stop");
		expect(p.query).toBe("how do I deploy?");
		expect(p.response).toBe("run npm publish");
	});
	it("buildIdlePromptPayload carries the summary", () => {
		const p = buildIdlePromptPayload(createMockCtx(), "Input needed");
		expect(p.event).toBe("idle_prompt");
		expect(p.summary).toBe("Input needed");
	});
	it("buildToolCompletePayload carries tool_name", () => {
		const p = buildToolCompletePayload(createMockCtx(), "bash");
		expect(p.event).toBe("tool_complete");
		expect(p.tool_name).toBe("bash");
	});
});

describe("serializePayload", () => {
	it("produces JSON parsable back to the original", () => {
		const p = buildIdlePromptPayload(createMockCtx(), "Input needed");
		expect(JSON.parse(serializePayload(p))).toEqual(p);
	});
});
