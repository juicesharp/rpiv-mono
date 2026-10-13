import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionEntries, createMockCtx, createMockPi, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: vi.fn(),
	};
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		buildSessionContext: vi.fn(),
		convertToLlm: vi.fn(actual.convertToLlm),
	};
});

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_VIEW_CHANNEL, requestContextView } from "./advisor/context-view.js";
import { registerAdvisorTool, setAdvisorModel } from "./advisor/index.js";

function resp(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "done",
	};
}

/** A dispatching event bus — the mock pi's default one only records emissions. */
function mockBus() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of handlers.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const list = handlers.get(channel) ?? [];
				list.push(handler);
				handlers.set(channel, list);
				return () => {};
			},
		} as unknown as ExtensionAPI["events"],
		handlers,
	};
}

/** Install a provider that claims `answer` on every context-view request. */
function providingBus(answer: (req: any) => unknown) {
	const { events, handlers } = mockBus();
	handlers.set(CONTEXT_VIEW_CHANNEL, [
		(data: unknown) => {
			(data as any).claim(Promise.resolve(answer(data)));
		},
	]);
	return events;
}

beforeEach(() => {
	vi.mocked(completeSimple).mockReset();
	vi.mocked(buildSessionContext).mockClear();
	vi.mocked(buildSessionContext).mockImplementation(
		(entries) =>
			({
				messages: ((entries ?? []) as { type?: string; message?: unknown }[])
					.filter((e) => e?.type === "message")
					.map((e) => (e as { message: unknown }).message),
				thinkingLevel: "off",
				model: null,
			}) as ReturnType<typeof buildSessionContext>,
	);
});

describe("requestContextView", () => {
	it("returns the adapter's projection as available", async () => {
		const messages = [{ role: "user", content: [{ type: "text", text: "compressed" }] }];
		const pi = { events: providingBus(() => ({ status: "available", messages })) } as unknown as ExtensionAPI;
		await expect(requestContextView(pi, createMockCtx())).resolves.toEqual({ kind: "available", messages });
	});

	it("carries the protocol version, session id and ctx", async () => {
		const seen: any[] = [];
		const pi = {
			events: providingBus((req) => {
				seen.push(req);
				return { status: "inactive", reason: "empty" };
			}),
		} as unknown as ExtensionAPI;
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("q")]), sessionId: "s-7" });

		await requestContextView(pi, ctx);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ version: 1, sessionId: "s-7", ctx });
		expect(typeof seen[0].claim).toBe("function");
	});

	it("treats an absent provider as no view instead of waiting", async () => {
		const pi = { events: mockBus().events } as unknown as ExtensionAPI;
		await expect(requestContextView(pi, createMockCtx())).resolves.toEqual({ kind: "absent" });
	});

	it("treats an inactive answer as no view, silently", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pi = {
			events: providingBus(() => ({ status: "inactive", reason: "session-mismatch" })),
		} as unknown as ExtensionAPI;
		await expect(requestContextView(pi, createMockCtx())).resolves.toEqual({ kind: "absent" });
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	// A wired adapter that answered and then broke the hand-off is reported, not
	// swallowed: falling back here would review Pi's raw history, which is the
	// uncompressed context this adapter path exists to replace.
	it.each([
		["malformed status", { status: "available" }],
		["messages not an array", { status: "available", messages: "nope" }],
		["non-object", "nope"],
		["null", null],
	])("reports a broken hand-off on a %s answer", async (_label, answer) => {
		const pi = { events: providingBus(() => answer) } as unknown as ExtensionAPI;
		const outcome = await requestContextView(pi, createMockCtx());
		expect(outcome.kind).toBe("broken");
		expect((outcome as { detail: string }).detail).toContain("unusable answer");
	});

	it("reports a broken hand-off when the provider's claim rejects", async () => {
		const { events, handlers } = mockBus();
		handlers.set(CONTEXT_VIEW_CHANNEL, [(data: unknown) => (data as any).claim(Promise.reject(new Error("boom")))]);
		const pi = { events } as unknown as ExtensionAPI;
		const outcome = await requestContextView(pi, createMockCtx());
		expect(outcome.kind).toBe("broken");
		expect((outcome as { detail: string }).detail).toContain("boom");
	});

	it("reports a broken hand-off when asking the adapter throws", async () => {
		const pi = {
			events: {
				emit() {
					throw new Error("bus is wedged");
				},
			} as unknown as ExtensionAPI["events"],
		} as unknown as ExtensionAPI;
		const outcome = await requestContextView(pi, createMockCtx());
		expect(outcome.kind).toBe("broken");
		expect((outcome as { detail: string }).detail).toContain("bus is wedged");
	});

	it("falls back on a host without an event bus", async () => {
		await expect(requestContextView({} as ExtensionAPI, createMockCtx())).resolves.toEqual({ kind: "absent" });
	});
});

describe("executeAdvisor — compression adapter integration", () => {
	it("sends the adapter's projection instead of Pi's raw entries", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp("advice") as never);
		const view = [{ role: "user", content: [{ type: "text", text: "compressed view" }], timestamp: 1 }];
		const { pi, captured } = createMockPi({
			events: providingBus(() => ({ status: "available", messages: view })),
		});
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("raw question")]) });

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const sent = vi.mocked(completeSimple).mock.calls[0]?.[1] as { messages: unknown[] };
		expect(sent.messages.some((m) => JSON.stringify(m).includes("compressed view"))).toBe(true);
		expect(sent.messages.some((m) => JSON.stringify(m).includes("raw question"))).toBe(false);
		expect(buildSessionContext).not.toHaveBeenCalled();
	});

	it("falls back to buildSessionContext when no adapter is installed", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp("advice") as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("raw question")]) });

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const sent = vi.mocked(completeSimple).mock.calls[0]?.[1] as { messages: unknown[] };
		expect(sent.messages.some((m) => JSON.stringify(m).includes("raw question"))).toBe(true);
		expect(buildSessionContext).toHaveBeenCalledTimes(1);
	});

	it("fails the call when the adapter broke the hand-off, instead of reviewing raw history", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi({
			events: providingBus(() => ({ status: "available", messages: "nope" })),
		});
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("raw question")]) });

		const result = await captured.tools
			.get("advisor")
			?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const text = JSON.stringify(result?.content);
		expect(text).toContain("could not read the compression adapter's context view");
		expect(text).not.toContain("raw question");
		const details = (result as { details: { errorMessage?: string } }).details;
		expect(details.errorMessage).toContain("unusable answer");
		// The whole point: no fallback to the uncompressed branch, and no dispatch.
		expect(buildSessionContext).not.toHaveBeenCalled();
		expect(completeSimple).not.toHaveBeenCalled();
	});
});
