import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { getDocsProtocol, handleBeforeAgentStart, registerDocsProtocol } from "./docs-protocol.js";

describe("getDocsProtocol", () => {
	it("returns a non-empty string", () => {
		const protocol = getDocsProtocol();
		expect(protocol).toBeTruthy();
		expect(typeof protocol).toBe("string");
	});

	it("contains the workflow-basics doc path", () => {
		const protocol = getDocsProtocol();
		expect(protocol).toContain("workflow-basics.md");
	});

	it("contains the workflow-authoring doc path", () => {
		const protocol = getDocsProtocol();
		expect(protocol).toContain("workflow-authoring.md");
	});

	it("contains absolute paths (starting with /)", () => {
		const protocol = getDocsProtocol();
		expect(protocol).toMatch(/\/.*workflow-basics\.md/);
		expect(protocol).toMatch(/\/.*workflow-authoring\.md/);
	});

	it("includes the routing instruction", () => {
		const protocol = getDocsProtocol();
		expect(protocol).toContain("When asked about workflows");
	});

	it("includes the validation reminder", () => {
		const protocol = getDocsProtocol();
		expect(protocol).toContain("validateWorkflow()");
	});

	it("returns identical bytes on repeated calls (prompt-cache invariant)", () => {
		const first = getDocsProtocol();
		const second = getDocsProtocol();
		expect(first).toBe(second);
	});

	it("starts and ends with a blank line for clean concatenation", () => {
		const protocol = getDocsProtocol();
		expect(protocol.startsWith("\n")).toBe(true);
		expect(protocol.endsWith("\n")).toBe(true);
	});
});

describe("handleBeforeAgentStart", () => {
	it("prepends the protocol to the system prompt", () => {
		const event = { systemPrompt: "BASE" };
		const result = handleBeforeAgentStart(event);
		expect(result.systemPrompt).toBe(`${getDocsProtocol()}BASE`);
	});

	it("preserves the existing system prompt content", () => {
		const existing = "line1\nline2\nline3";
		const result = handleBeforeAgentStart({ systemPrompt: existing });
		expect(result.systemPrompt.endsWith(existing)).toBe(true);
	});

	it("does not replace the system prompt", () => {
		const event = { systemPrompt: "IMPORTANT_CONTENT" };
		const result = handleBeforeAgentStart(event);
		expect(result.systemPrompt).toContain("IMPORTANT_CONTENT");
	});
});

describe("registerDocsProtocol", () => {
	it("registers a before_agent_start handler", () => {
		const { captured } = createMockPi();
		registerDocsProtocol({
			on: (event, handler) => {
				captured.events.set(event, [handler as (...args: unknown[]) => unknown]);
			},
		});
		expect(captured.events.has("before_agent_start")).toBe(true);
		expect(captured.events.get("before_agent_start")).toHaveLength(1);
	});

	it("registered handler prepends protocol to system prompt", () => {
		let registeredHandler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
		registerDocsProtocol({
			on: (_event, handler) => {
				registeredHandler = handler;
			},
		});
		expect(registeredHandler).toBeDefined();
		const result = registeredHandler!({ systemPrompt: "PROMPT" });
		expect(result.systemPrompt).toBe(`${getDocsProtocol()}PROMPT`);
	});
});
