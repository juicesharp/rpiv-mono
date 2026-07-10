import { buildSessionEntries, createMockCtx, makeAssistantMessage, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_ID,
	baseEnvelope,
	buildIdlePromptPayload,
	buildPromptSubmitPayload,
	buildSessionStartPayload,
	buildStopPayload,
	buildToolCompletePayload,
	buildWorkflowQuestionAskedPayload,
	buildWorkflowQuestionCompletePayload,
	buildWorkflowSessionStartPayload,
	extractMessageText,
	lastAssistantText,
	lastUserText,
	projectName,
	serializePayload,
	summarizeSkillBlock,
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

describe("summarizeSkillBlock", () => {
	const wrap = (name: string, body: string, suffix?: string) =>
		`<skill name="${name}" location="/abs/${name}/SKILL.md">\nReferences are relative to /abs/${name}.\n\n${body}\n</skill>${suffix ? `\n\n${suffix}` : ""}`;

	it("collapses a wrapper with trailing-args suffix to `/skill:<name> <args>`", () => {
		expect(summarizeSkillBlock(wrap("discover", "body text", "write a file"))).toBe("/skill:discover write a file");
	});
	it("collapses a wrapper with no suffix to `/skill:<name>` (token-path emit, empty args)", () => {
		expect(summarizeSkillBlock(wrap("discover", "body text"))).toBe("/skill:discover");
	});
	it("strips the `Skill input:` trailer label down to the raw args (token-path emit)", () => {
		expect(summarizeSkillBlock(wrap("validate", "body text", "Skill input: @path/to/plan.md --goal g.md"))).toBe(
			"/skill:validate @path/to/plan.md --goal g.md",
		);
	});
	it("passes non-skill input through verbatim", () => {
		expect(summarizeSkillBlock("how do I deploy?")).toBe("how do I deploy?");
	});
	it("passes a malformed/partial wrapper through verbatim", () => {
		expect(summarizeSkillBlock('<skill name="x"> body </skill>')).toBe('<skill name="x"> body </skill>');
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
	it("collapses a stored skill-wrapper user message to `/skill:<name> <args>`", () => {
		const wrapped =
			'<skill name="discover" location="/abs/discover/SKILL.md">\nReferences are relative to /abs/discover.\n\nbody text\n</skill>\n\nwrite a file';
		const branch = buildSessionEntries([makeUserMessage(wrapped)]);
		expect(lastUserText(branch)).toBe("/skill:discover write a file");
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
	it("buildPromptSubmitPayload carries the query", () => {
		const p = buildPromptSubmitPayload(createMockCtx(), "how do I deploy?");
		expect(p.event).toBe("prompt_submit");
		expect(p.query).toBe("how do I deploy?");
	});
	it("buildPromptSubmitPayload defaults query to empty string", () => {
		const p = buildPromptSubmitPayload(createMockCtx());
		expect(p.query).toBe("");
	});
	it("buildPromptSubmitPayload collapses a wrapped skill query to `/skill:<name> <args>`", () => {
		const wrapped =
			'<skill name="discover" location="/abs/discover/SKILL.md">\nReferences are relative to /abs/discover.\n\nbody text\n</skill>\n\nwrite a file';
		const p = buildPromptSubmitPayload(createMockCtx(), wrapped);
		expect(p.query).toBe("/skill:discover write a file");
	});
	it("buildToolCompletePayload carries tool_input when provided", () => {
		const p = buildToolCompletePayload(createMockCtx(), "bash", { command: "npm test" });
		expect(p.event).toBe("tool_complete");
		expect(p.tool_name).toBe("bash");
		expect(p.tool_input).toEqual({ command: "npm test" });
	});
	it("buildToolCompletePayload omits tool_input when not provided", () => {
		const p = buildToolCompletePayload(createMockCtx(), "bash");
		expect(p.event).toBe("tool_complete");
		expect(p.tool_name).toBe("bash");
		expect(p.tool_input).toBeUndefined();
	});
});

describe("workflow-question run-keyed builders", () => {
	it("buildWorkflowSessionStartPayload sets session_id=runId, event=session_start, cwd/project from cwd", () => {
		const p = buildWorkflowSessionStartPayload("run-abc", "/tmp/projects/widget");
		expect(p).toEqual({
			v: PLUGIN_MAX_PROTOCOL_VERSION,
			agent: AGENT_ID,
			event: "session_start",
			session_id: "run-abc",
			cwd: "/tmp/projects/widget",
			project: "widget",
		});
	});
	it("buildWorkflowQuestionAskedPayload sets session_id=runId, event=question_asked", () => {
		const p = buildWorkflowQuestionAskedPayload("run-abc", "/tmp/projects/widget");
		expect(p).toEqual({
			v: PLUGIN_MAX_PROTOCOL_VERSION,
			agent: AGENT_ID,
			event: "question_asked",
			session_id: "run-abc",
			cwd: "/tmp/projects/widget",
			project: "widget",
		});
	});
	it("buildWorkflowQuestionCompletePayload sets session_id=runId, event=tool_complete, tool_name=ask_user_question", () => {
		const p = buildWorkflowQuestionCompletePayload("run-abc", "/tmp/projects/widget");
		expect(p).toEqual({
			v: PLUGIN_MAX_PROTOCOL_VERSION,
			agent: AGENT_ID,
			event: "tool_complete",
			session_id: "run-abc",
			cwd: "/tmp/projects/widget",
			project: "widget",
			tool_name: "ask_user_question",
		});
	});
	it("buildWorkflowQuestionCompletePayload carries NO tool_input", () => {
		const p = buildWorkflowQuestionCompletePayload("run-abc", "/tmp");
		expect(p.tool_input).toBeUndefined();
	});
	it("baseEnvelope is unchanged — still reads ctx.sessionManager.getSessionId()", () => {
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
});

describe("serializePayload", () => {
	it("produces JSON parsable back to the original", () => {
		const p = buildIdlePromptPayload(createMockCtx(), "Input needed");
		expect(JSON.parse(serializePayload(p))).toEqual(p);
	});
});
