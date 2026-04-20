import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./btw-ui.js", () => ({
	showBtwOverlay: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
	return {
		...actual,
		completeSimple: vi.fn(),
		supportsXhigh: vi.fn(() => false),
	};
});

import { completeSimple } from "@mariozechner/pi-ai";
import { BTW_COMMAND_NAME, BTW_STATE_KEY, registerBtwCommand } from "./btw.js";
import { showBtwOverlay } from "./btw-ui.js";

const model = { provider: "a", id: "m" } as unknown as Model<Api>;

type OverlayCtl = { setAnswer: ReturnType<typeof vi.fn>; setError: ReturnType<typeof vi.fn> };

function stubOverlay(): OverlayCtl {
	const ctl: OverlayCtl = { setAnswer: vi.fn(), setError: vi.fn() };
	vi.mocked(showBtwOverlay).mockReturnValueOnce({
		overlayPromise: Promise.resolve(),
		controllerReady: Promise.resolve(ctl as never),
	} as never);
	return ctl;
}

function doneResponse(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "done",
	};
}

beforeEach(() => {
	vi.mocked(showBtwOverlay).mockReset();
	vi.mocked(completeSimple).mockReset();
});

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[BTW_STATE_KEY];
});

function register() {
	const { pi, captured } = createMockPi();
	registerBtwCommand(pi);
	return captured.commands.get(BTW_COMMAND_NAME)!;
}

describe("/btw — early-return branches", () => {
	it("!hasUI notifies error and skips overlay", async () => {
		const cmd = register();
		const ctx = createMockCtx({ hasUI: false, model });
		await cmd.handler("anything", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(showBtwOverlay).not.toHaveBeenCalled();
	});

	it("empty question emits usage warning", async () => {
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("   ", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
		expect(showBtwOverlay).not.toHaveBeenCalled();
	});

	it("missing model notifies error", async () => {
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("hello?", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("active model"), "error");
		expect(showBtwOverlay).not.toHaveBeenCalled();
	});
});

describe("/btw — happy path", () => {
	it("invokes overlay, awaits executor, pipes answer to setAnswer", async () => {
		const ctl = stubOverlay();
		vi.mocked(completeSimple).mockResolvedValueOnce(doneResponse("42") as never);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("what is 6 times 7?", ctx as never);
		expect(showBtwOverlay).toHaveBeenCalledTimes(1);
		const params = vi.mocked(showBtwOverlay).mock.calls[0][0];
		expect(params.question).toBe("what is 6 times 7?");
		expect(params.history).toEqual([]);
		expect(ctl.setAnswer).toHaveBeenCalledWith("42");
		expect(ctl.setError).not.toHaveBeenCalled();
	});
});

describe("/btw — aborted", () => {
	it("does not touch the overlay controller", async () => {
		const ctl = stubOverlay();
		vi.mocked(completeSimple).mockResolvedValueOnce({
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			stopReason: "aborted",
		} as never);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("q", ctx as never);
		expect(ctl.setAnswer).not.toHaveBeenCalled();
		expect(ctl.setError).not.toHaveBeenCalled();
	});
});

describe("/btw — executor failure", () => {
	it("pipes error into setError", async () => {
		const ctl = stubOverlay();
		vi.mocked(completeSimple).mockResolvedValueOnce({
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			stopReason: "error",
			errorMessage: "upstream 502",
		} as never);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("q", ctx as never);
		expect(ctl.setError).toHaveBeenCalledWith(expect.stringContaining("upstream 502"));
		expect(ctl.setAnswer).not.toHaveBeenCalled();
	});
});

describe("/btw — cross-session hint is rendered after turns accumulate", () => {
	it("second invocation's systemPrompt contains the recent-questions section", async () => {
		stubOverlay();
		vi.mocked(completeSimple).mockResolvedValueOnce(doneResponse("ans1") as never);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("first question", ctx as never);

		stubOverlay();
		vi.mocked(completeSimple).mockResolvedValueOnce(doneResponse("ans2") as never);
		await cmd.handler("second question", ctx as never);

		const secondSystemPrompt = vi.mocked(completeSimple).mock.calls[1][1].systemPrompt ?? "";
		expect(secondSystemPrompt).toContain("Recent /btw questions across sessions");
		expect(secondSystemPrompt).toContain("first question");
	});
});
