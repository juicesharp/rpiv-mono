import { afterEach, describe, expect, it, vi } from "vitest";
import { ParallelProvider } from "./parallel.js";

describe("Parallel provider transport cancellation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("aborts a stalled initialized notification when the caller cancels during connect", async () => {
		let markNotificationStarted = () => {};
		const notificationStarted = new Promise<void>((resolve) => {
			markNotificationStarted = resolve;
		});
		let releaseNotification: (() => void) | undefined;
		let notificationSignal: AbortSignal | undefined;
		let notificationAborted = false;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const method = request.method.toUpperCase();

				if (method === "GET") return new Response(null, { status: 405 });
				if (method === "DELETE") return new Response(null, { status: 200 });
				if (method !== "POST") throw new Error(`Unexpected MCP method: ${method}`);

				const body = (await request.clone().json()) as {
					id?: number | string;
					method?: string;
					params?: { protocolVersion?: string };
				};

				if (body.method === "initialize") {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: body.params?.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name: "fixture", version: "1.0.0" },
							},
						}),
						{ status: 200, headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" } },
					);
				}

				if (body.method === "notifications/initialized") {
					notificationSignal = request.signal;
					markNotificationStarted();
					return new Promise<Response>((resolve, reject) => {
						releaseNotification = () => resolve(new Response(null, { status: 202 }));
						const abort = () => {
							notificationAborted = true;
							reject(request.signal.reason ?? new Error("Notification request aborted."));
						};
						if (request.signal.aborted) abort();
						else request.signal.addEventListener("abort", abort, { once: true });
					});
				}

				throw new Error(`Unexpected MCP notification: ${body.method ?? "unknown"}`);
			}),
		);

		const controller = new AbortController();
		const search = new ParallelProvider().search("cancellable query", 3, controller.signal);
		const settledSearch = search.then(
			() => ({ type: "resolved" as const }),
			(error: unknown) => ({ type: "rejected" as const, error }),
		);

		await notificationStarted;
		controller.abort(new Error("cancelled during initialization notification"));

		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const outcome = await Promise.race([
				settledSearch,
				new Promise<{ type: "pending" }>((resolve) => {
					timeout = setTimeout(() => resolve({ type: "pending" }), 1_500);
				}),
			]);
			expect(outcome.type).toBe("rejected");
			if (outcome.type === "rejected") {
				expect(outcome.error).toHaveProperty("message", "cancelled during initialization notification");
			}
			expect(notificationSignal?.aborted).toBe(true);
			expect(notificationAborted).toBe(true);
		} finally {
			if (timeout) clearTimeout(timeout);
			releaseNotification?.();
			await settledSearch;
		}
	});
});
