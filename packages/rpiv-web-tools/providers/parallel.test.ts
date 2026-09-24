import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import registerWebTools from "../index.js";

const mocks = vi.hoisted(() => ({
	clientOptions: undefined as unknown,
	transportUrl: undefined as unknown,
	transportOptions: undefined as unknown,
	transportClose: vi.fn(),
	connect: vi.fn(),
	callTool: vi.fn(),
	close: vi.fn(),
	terminateSession: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client", () => ({
	Client: class {
		private transport: { close: () => unknown } | undefined;

		constructor(options: unknown) {
			mocks.clientOptions = options;
		}

		connect(transport: unknown, options?: unknown) {
			this.transport = transport as { close: () => unknown };
			return mocks.connect(transport, options);
		}

		callTool(...args: unknown[]) {
			return mocks.callTool(...args);
		}

		close() {
			mocks.close();
			return this.transport?.close();
		}
	},
	StreamableHTTPClientTransport: class {
		constructor(url: URL, options: unknown) {
			mocks.transportUrl = url;
			mocks.transportOptions = options;
		}

		terminateSession() {
			return mocks.terminateSession();
		}

		close() {
			return mocks.transportClose();
		}
	},
}));

const CONFIG_PATH = configPath("rpiv-web-tools");

function registerAndCapture() {
	const { pi, captured } = createMockPi();
	registerWebTools(pi);
	return { captured };
}

function writeConfig(contents: unknown) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

beforeEach(() => {
	mocks.clientOptions = undefined;
	mocks.transportUrl = undefined;
	mocks.transportOptions = undefined;
	mocks.transportClose.mockReset().mockResolvedValue(undefined);
	mocks.connect.mockReset().mockResolvedValue(undefined);
	mocks.callTool.mockReset().mockResolvedValue({
		isError: false,
		structuredContent: {
			results: [
				{ title: "First", url: "https://result.example/1", excerpts: ["first excerpt", "second excerpt"] },
				{ title: "Second", url: "https://result.example/2", excerpts: ["another excerpt"] },
			],
		},
	});
	mocks.close.mockReset().mockResolvedValue(undefined);
	mocks.terminateSession.mockReset().mockResolvedValue(undefined);
	rmSync(CONFIG_PATH, { force: true });
});

describe("Parallel search provider", () => {
	it("routes web_search through the keyless MCP client and maps the host session and result limit", async () => {
		writeConfig({ provider: "parallel" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ sessionId: "pi-session-123" });
		const result = await captured.tools
			.get("web_search")
			?.execute?.(
				"tc",
				{ query: "Parallel search MCP", max_results: 1 },
				undefined as never,
				undefined as never,
				ctx,
			);

		expect(result?.details).toMatchObject({
			backend: "parallel",
			resultCount: 1,
			results: [{ title: "First", url: "https://result.example/1", snippet: "first excerpt second excerpt" }],
		});
		expect(mocks.clientOptions).toEqual({ name: "rpiv-web-tools", version: "2.11.0" });
		expect(mocks.transportUrl).toEqual(new URL("https://search.parallel.ai/mcp"));
		const transportOptions = mocks.transportOptions as { requestInit: { headers: Record<string, string> } };
		expect(transportOptions.requestInit.headers["User-Agent"]).toBe("rpiv-web-tools/2.11.0");
		expect(transportOptions.requestInit.headers).not.toHaveProperty("Authorization");
		expect(mocks.callTool).toHaveBeenCalledWith(
			{
				name: "web_search",
				arguments: {
					objective: "Parallel search MCP",
					search_queries: ["Parallel search MCP"],
					session_id: "pi-session-123",
				},
			},
			undefined,
		);
		expect(mocks.terminateSession).toHaveBeenCalledOnce();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("pads short queries to the MCP keyword minimum", async () => {
		writeConfig({ provider: "parallel" });
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "weather" }, undefined as never, undefined as never, createMockCtx());
		expect(mocks.callTool).toHaveBeenCalledWith(
			{ name: "web_search", arguments: expect.objectContaining({ search_queries: ["weather web search"] }) },
			undefined,
		);
	});

	it("passes cancellation to the call and preserves MCP errors while cleaning up", async () => {
		writeConfig({ provider: "parallel" });
		mocks.callTool.mockResolvedValueOnce({
			isError: true,
			content: [{ type: "text", text: "Search rate limit reached" }],
		});
		mocks.terminateSession.mockRejectedValueOnce(new Error("cleanup failure"));
		const controller = new AbortController();
		const { captured } = registerAndCapture();
		const call = captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "Parallel search MCP" }, controller.signal, undefined as never, createMockCtx());

		await expect(call).rejects.toThrow("Search rate limit reached");
		expect(mocks.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: "web_search" }), {
			signal: controller.signal,
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("passes cancellation through MCP initialization and closes the transport", async () => {
		writeConfig({ provider: "parallel" });
		const controller = new AbortController();
		mocks.connect.mockImplementationOnce((_transport, options) => {
			const signal = (options as { signal: AbortSignal }).signal;
			return new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const { captured } = registerAndCapture();
		const call = captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "Parallel search MCP" }, controller.signal, undefined as never, createMockCtx());

		controller.abort(new Error("cancelled during initialization"));
		await expect(call).rejects.toThrow("cancelled during initialization");
		expect(mocks.connect).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
		expect(mocks.transportClose).toHaveBeenCalledOnce();
	});

	it("bounds stalled session termination before returning search results", async () => {
		vi.useFakeTimers();
		try {
			writeConfig({ provider: "parallel" });
			let markCleanupStarted = () => {};
			const cleanupStarted = new Promise<void>((resolve) => {
				markCleanupStarted = resolve;
			});
			mocks.terminateSession.mockImplementationOnce(() => {
				markCleanupStarted();
				return new Promise<void>(() => {});
			});
			const { captured } = registerAndCapture();
			const call = captured.tools
				.get("web_search")
				?.execute?.(
					"tc",
					{ query: "Parallel search MCP" },
					undefined as never,
					undefined as never,
					createMockCtx(),
				);

			await cleanupStarted;
			await vi.advanceTimersByTimeAsync(1_000);
			await expect(call).resolves.toMatchObject({
				details: { backend: "parallel", resultCount: 2 },
			});
			expect(mocks.close).toHaveBeenCalledOnce();
			expect(mocks.transportClose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
