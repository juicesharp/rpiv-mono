import { makeAssistantMessage, makeToolResult, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./advisor.js";

describe("stripInflightAdvisorCall", () => {
	it("returns original array for empty messages", () => {
		const msgs: Message[] = [];
		expect(stripInflightAdvisorCall(msgs)).toBe(msgs);
	});

	it("returns original when tail is not an assistant message", () => {
		const msgs = [makeUserMessage("hi")];
		expect(stripInflightAdvisorCall(msgs)).toBe(msgs);
	});

	it("returns original when assistant tail has no advisor toolCall", () => {
		const msgs = [
			makeUserMessage("q"),
			makeAssistantMessage({
				text: "ok",
				toolCalls: [{ id: "c1", name: "web_search", arguments: {} }],
			}),
		];
		expect(stripInflightAdvisorCall(msgs)).toBe(msgs);
	});

	it("drops the tail entirely when advisor is the only content", () => {
		const msgs = [
			makeUserMessage("q"),
			makeAssistantMessage({
				toolCalls: [{ id: "c1", name: "advisor", arguments: {} }],
			}),
		];
		const out = stripInflightAdvisorCall(msgs);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
	});

	it("keeps tail with advisor removed when text precedes it", () => {
		const msgs = [
			makeUserMessage("q"),
			makeAssistantMessage({
				text: "thinking...",
				toolCalls: [{ id: "c1", name: "advisor", arguments: {} }],
			}),
		];
		const out = stripInflightAdvisorCall(msgs);
		expect(out).toHaveLength(2);
		const tail = out[1];
		expect(tail.role).toBe("assistant");
		if (tail.role !== "assistant") throw new Error();
		expect(tail.content.some((c) => c.type === "toolCall" && c.name === "advisor")).toBe(false);
		expect(tail.content.some((c) => c.type === "text" && c.text === "thinking...")).toBe(true);
	});

	it("preserves sibling non-advisor toolCalls", () => {
		const msgs = [
			makeUserMessage("q"),
			makeAssistantMessage({
				toolCalls: [
					{ id: "c1", name: "web_search", arguments: {} },
					{ id: "c2", name: "advisor", arguments: {} },
					{ id: "c3", name: "todo", arguments: {} },
				],
			}),
		];
		const out = stripInflightAdvisorCall(msgs);
		const tail = out[out.length - 1];
		if (tail.role !== "assistant") throw new Error();
		const toolNames = tail.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name);
		expect(toolNames).toEqual(["web_search", "todo"]);
	});

	it("leaves older assistant messages untouched", () => {
		const older = makeAssistantMessage({
			toolCalls: [{ id: "c0", name: "advisor", arguments: {} }],
		});
		const msgs = [
			makeUserMessage("q"),
			older,
			makeUserMessage("q2"),
			makeAssistantMessage({
				toolCalls: [{ id: "c1", name: "advisor", arguments: {} }],
			}),
		];
		const out = stripInflightAdvisorCall(msgs);
		expect(out).toHaveLength(3);
		expect(out[1]).toBe(older);
	});

	it("returns a new array when stripping occurs", () => {
		const msgs = [
			makeUserMessage("q"),
			makeAssistantMessage({
				toolCalls: [{ id: "c1", name: "advisor", arguments: {} }],
			}),
		];
		const out = stripInflightAdvisorCall(msgs);
		expect(out).not.toBe(msgs);
	});
});

describe("ensureUserTailForAdvisor", () => {
	it("returns original on empty input", () => {
		const msgs: Message[] = [];
		expect(ensureUserTailForAdvisor(msgs)).toBe(msgs);
	});

	it("returns original when tail is already user", () => {
		const msgs = [makeAssistantMessage({ text: "old" }), makeUserMessage("q")];
		expect(ensureUserTailForAdvisor(msgs)).toBe(msgs);
	});

	it("returns original when tail is a toolResult", () => {
		const msgs: Message[] = [
			makeUserMessage("q"),
			makeAssistantMessage({ toolCalls: [{ id: "c1", name: "todo", arguments: {} }] }),
			makeToolResult({ toolCallId: "c1", toolName: "todo", text: "done" }),
		];
		expect(ensureUserTailForAdvisor(msgs)).toBe(msgs);
	});

	it("appends a user nudge when tail is assistant", () => {
		const msgs = [makeUserMessage("q"), makeAssistantMessage({ text: "thinking..." })];
		const out = ensureUserTailForAdvisor(msgs);
		expect(out).not.toBe(msgs);
		expect(out).toHaveLength(3);
		const tail = out[out.length - 1];
		expect(tail.role).toBe("user");
		if (tail.role !== "user") throw new Error();
		expect(Array.isArray(tail.content) && tail.content[0]?.type === "text").toBe(true);
	});
});
