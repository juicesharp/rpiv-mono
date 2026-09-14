import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import adapter from "./docs/herdr-adapter.js";

function setup() {
	let listener: ((payload: unknown) => void) | undefined;
	const emit = vi.fn();
	const unsubscribe = vi.fn();
	const { pi, captured } = createMockPi({
		events: {
			emit,
			on: vi.fn((_channel: string, handler: (payload: unknown) => void) => {
				listener = handler;
				return unsubscribe;
			}),
		},
	});
	adapter(pi);
	return {
		pi,
		emit,
		unsubscribe,
		send: (payload: unknown) => listener?.(payload),
		shutdown: () => captured.events.get("session_shutdown")![0](undefined as never, undefined as never),
	};
}

describe("optional Herdr adapter", () => {
	it("maps the stable RPIV channel without forwarding questions or answers", () => {
		const { pi, send, emit } = setup();
		expect(pi.events.on).toHaveBeenCalledWith("rpiv:ask-user:blocked", expect.any(Function));
		send({ active: true, question: "private text" });
		send({ active: false });
		expect(emit.mock.calls).toEqual([
			["herdr:blocked", { active: true, label: "Waiting for user response" }],
			["herdr:blocked", { active: false }],
		]);
	});

	it("ignores malformed events and unmatched releases", () => {
		const { send, emit } = setup();
		for (const payload of [undefined, null, true, "true", {}, { active: 1 }, { active: "true" }, { active: false }])
			send(payload);
		expect(emit).not.toHaveBeenCalled();
	});

	it("balances overlapping waits and releases only outstanding contributions on shutdown", () => {
		const { send, emit, shutdown, unsubscribe } = setup();
		send({ active: true });
		send({ active: true });
		send({ active: false });
		shutdown();
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(emit.mock.calls.map((call) => call[1].active)).toEqual([true, true, false, false]);
		emit.mockClear();
		shutdown();
		expect(emit).not.toHaveBeenCalled();
	});
});
