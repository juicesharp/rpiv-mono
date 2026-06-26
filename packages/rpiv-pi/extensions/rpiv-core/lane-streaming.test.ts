import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createLaneSessionView } from "./lane-streaming.js";
import type { ViewerMessage } from "./lane-transcript.js";

type AnyEvent = { type: string; message?: { role: string; content?: unknown[] } };

/** A fake AgentSession whose subscribe listener the test can drive via `fire`. */
function makeFake() {
	let listener: ((e: AnyEvent) => void) | undefined;
	const unsub = vi.fn();
	const session = {
		sessionId: "sid-1",
		isStreaming: true,
		sessionManager: { getBranch: () => [], getCwd: () => "/tmp" },
		getToolDefinition: vi.fn((n: string) => ({ name: n })),
		subscribe: vi.fn((l: (e: AnyEvent) => void) => {
			listener = l;
			return unsub;
		}),
	};
	return { session: session as unknown as AgentSession, fire: (e: AnyEvent) => listener?.(e), unsub };
}

const update = (thinking: string): AnyEvent => ({
	type: "message_update",
	message: { role: "assistant", content: [{ type: "thinking", thinking }] },
});

describe("createLaneSessionView", () => {
	it("captures the assistant partial on start/update and clears on message_end (dedup)", () => {
		const { session, fire } = makeFake();
		const view = createLaneSessionView(session);
		expect(view.getStreamingMessage()).toBeUndefined();

		fire({ type: "message_start", message: { role: "assistant", content: [] } });
		fire(update("pondering"));
		expect((view.getStreamingMessage() as ViewerMessage).content?.[0]).toMatchObject({ thinking: "pondering" });

		fire(update("pondering more"));
		expect((view.getStreamingMessage() as ViewerMessage).content?.[0]).toMatchObject({ thinking: "pondering more" });

		fire({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "done" }] } });
		expect(view.getStreamingMessage()).toBeUndefined(); // committed → dropped
	});

	it("clears the partial on a non-assistant message_start", () => {
		const { session, fire } = makeFake();
		const view = createLaneSessionView(session);
		fire(update("x"));
		fire({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
		expect(view.getStreamingMessage()).toBeUndefined();
	});

	it("delegates sessionManager / getToolDefinition / subscribe to the raw session", () => {
		const { session } = makeFake();
		const view = createLaneSessionView(session);
		expect(view.sessionManager.getCwd()).toBe("/tmp");
		expect(view.getToolDefinition("bash")).toEqual({ name: "bash" });
		const noop = () => {};
		view.subscribe(noop);
		expect(session.subscribe).toHaveBeenCalledWith(noop);
	});

	it("dispose() tears down the capture subscription", () => {
		const { session, unsub } = makeFake();
		createLaneSessionView(session).dispose();
		expect(unsub).toHaveBeenCalledTimes(1);
	});
});
