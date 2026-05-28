import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEvent } from "./types/events.js";
import type { TelemetryProvider } from "./types/provider.js";

vi.mock("./config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./config.js")>();
	return {
		...actual,
		loadTelemetryConfig: vi.fn(actual.loadTelemetryConfig),
	};
});

import { loadTelemetryConfig } from "./config.js";
import {
	dispatchTelemetryEvent,
	registerTelemetryProvider,
	resetTelemetryDispatcher,
	shutdownTelemetryDispatcher,
} from "./dispatcher.js";

function makeProvider(overrides: Partial<TelemetryProvider> & { name?: string } = {}): TelemetryProvider {
	const { name = "test", ...rest } = overrides;
	return {
		meta: { name, label: name === "test" ? "Test" : name },
		trackEvent: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
		shutdown: vi.fn(async () => {}),
		...rest,
	};
}

describe("dispatcher", () => {
	beforeEach(() => {
		// Default: all events enabled, no providers configured
		vi.mocked(loadTelemetryConfig).mockReturnValue({
			providers: {},
			events: "*",
			llmPayload: "off",
			dispatcher: { maxQueueSize: 100 },
		});
		resetTelemetryDispatcher();
	});

	it("dispatches events to all registered providers", async () => {
		const events: TelemetryEvent[] = [];
		const provider = makeProvider({
			trackEvent: vi.fn(async (e: TelemetryEvent) => {
				events.push(e);
			}),
		});
		registerTelemetryProvider(provider);
		const event: TelemetryEvent = {
			kind: "session_start",
			sessionId: "s1",
			reason: "startup",
			timestamp: 1,
		};
		dispatchTelemetryEvent(event);
		// Give setImmediate a tick to drain
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(event);
	});

	it("dispatches to multiple providers", async () => {
		const eventsA: TelemetryEvent[] = [];
		const eventsB: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				name: "a",
				trackEvent: vi.fn(async (e) => {
					eventsA.push(e);
				}),
			}),
		);
		registerTelemetryProvider(
			makeProvider({
				name: "b",
				trackEvent: vi.fn(async (e) => {
					eventsB.push(e);
				}),
			}),
		);
		dispatchTelemetryEvent({
			kind: "agent_start",
			sessionId: "s1",
			timestamp: 1,
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(eventsA).toHaveLength(1);
		expect(eventsB).toHaveLength(1);
	});

	it("one provider failure does not block others", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const events: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				name: "bad",
				trackEvent: vi.fn(async () => {
					throw new Error("boom");
				}),
			}),
		);
		registerTelemetryProvider(
			makeProvider({
				name: "good",
				trackEvent: vi.fn(async (e) => {
					events.push(e);
				}),
			}),
		);
		dispatchTelemetryEvent({
			kind: "session_start",
			sessionId: "s1",
			reason: "startup",
			timestamp: 1,
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toHaveLength(1);
	});

	it("filters events by allowlist", async () => {
		vi.mocked(loadTelemetryConfig).mockReturnValue({
			providers: {},
			events: ["tool_execution_start", "tool_execution_end"],
			llmPayload: "off",
			dispatcher: { maxQueueSize: 100 },
		});
		// Refresh cached config
		resetTelemetryDispatcher();

		const events: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				trackEvent: vi.fn(async (e) => {
					events.push(e);
				}),
			}),
		);

		// This should be filtered out
		dispatchTelemetryEvent({
			kind: "session_start",
			sessionId: "s1",
			reason: "startup",
			timestamp: 1,
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toHaveLength(0);

		// This should pass through
		dispatchTelemetryEvent({
			kind: "tool_execution_start",
			sessionId: "s1",
			toolCallId: "t1",
			toolName: "read",
			timestamp: 2,
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("tool_execution_start");
	});

	it("drops oldest events under backpressure (>100 queued)", async () => {
		// drain() captures the queue by reference on the first call (i=0).
		// After that, events accumulate in the queue while the loop runs.
		// The queue caps at MAX_QUEUE_SIZE=100 via shift(), so events 1-49
		// are dropped. The second drain (setImmediate) captures events 50-149.
		// Total reaching providers: 1 (first drain) + 100 (second drain) = 101.
		const events: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				trackEvent: vi.fn(async (e) => {
					events.push(e);
				}),
			}),
		);

		for (let i = 0; i < 150; i++) {
			dispatchTelemetryEvent({
				kind: "turn_start",
				sessionId: "s1",
				turnIndex: i,
				timestamp: i,
			});
		}

		await new Promise((r) => setTimeout(r, 100));
		// 150 dispatched, 49 dropped by backpressure → 101 processed
		expect(events).toHaveLength(101);
		// First batch: event 0
		expect((events[0] as { turnIndex: number }).turnIndex).toBe(0);
		// Second batch: events 50-149 (queue capped at 100)
		expect((events[1] as { turnIndex: number }).turnIndex).toBe(50);
		expect((events[events.length - 1] as { turnIndex: number }).turnIndex).toBe(149);
	});

	it("shutdown flushes and shuts down all providers", async () => {
		const flushed = vi.fn(async () => {});
		const shutDown = vi.fn(async () => {});
		registerTelemetryProvider(makeProvider({ flush: flushed, shutdown: shutDown }));
		await shutdownTelemetryDispatcher();
		expect(flushed).toHaveBeenCalled();
		expect(shutDown).toHaveBeenCalled();
	});

	it("shutdown drains queued events before flushing", async () => {
		const events: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				trackEvent: vi.fn(async (e) => {
					events.push(e);
				}),
			}),
		);
		dispatchTelemetryEvent({
			kind: "session_start",
			sessionId: "s1",
			reason: "startup",
			timestamp: 1,
		});
		// Don't wait for drain — call shutdown immediately
		await shutdownTelemetryDispatcher();
		expect(events).toHaveLength(1);
	});

	it("dispatchTelemetryEvent returns synchronously", () => {
		const events: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				trackEvent: vi.fn(async (e) => {
					events.push(e);
				}),
			}),
		);
		// Should not throw or return a promise
		const result = dispatchTelemetryEvent({
			kind: "agent_start",
			sessionId: "s1",
			timestamp: 1,
		});
		expect(result).toBeUndefined();
	});

	// Q4 fix: shutdown guard
	it("dispatch after shutdown is a no-op", async () => {
		const events: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				trackEvent: vi.fn(async (e) => {
					events.push(e);
				}),
			}),
		);

		await shutdownTelemetryDispatcher();

		// Attempt dispatch after shutdown
		dispatchTelemetryEvent({
			kind: "session_start",
			sessionId: "s1",
			reason: "startup",
			timestamp: 1,
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toHaveLength(0);
	});

	// Q4 fix: resetTelemetryDispatcher resets shuttingDown
	it("resetTelemetryDispatcher resets shuttingDown so dispatch works again", async () => {
		const events: TelemetryEvent[] = [];
		const provider = makeProvider({
			trackEvent: vi.fn(async (e) => {
				events.push(e);
			}),
		});
		registerTelemetryProvider(provider);

		await shutdownTelemetryDispatcher();
		resetTelemetryDispatcher();
		// reset() also clears providers, so re-register for the post-reset dispatch.
		registerTelemetryProvider(provider);

		// Should dispatch normally after reset
		dispatchTelemetryEvent({
			kind: "agent_start",
			sessionId: "s1",
			timestamp: 1,
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toHaveLength(1);
	});

	// D3/Q7 fix: no providers = skip dispatch
	it("dispatch with no providers is a no-op (D3/Q7)", async () => {
		// No providers registered
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		dispatchTelemetryEvent({
			kind: "session_start",
			sessionId: "s1",
			reason: "startup",
			timestamp: 1,
		});
		await new Promise((r) => setTimeout(r, 10));
		// Nothing should have queued or errored
		expect(warnSpy).not.toHaveBeenCalled();
	});

	// L2-04: provider failure tracking — warn once per failure transition
	it("warns once on first provider failure and once on recovery", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		let shouldFail = true;
		registerTelemetryProvider(
			makeProvider({
				name: "flaky",
				trackEvent: vi.fn(async () => {
					if (shouldFail) throw new Error("boom");
				}),
			}),
		);

		// Three failures in a row — should warn exactly once.
		for (let i = 0; i < 3; i++) {
			dispatchTelemetryEvent({
				kind: "turn_start",
				sessionId: "s1",
				turnIndex: i,
				timestamp: i,
			});
		}
		await new Promise((r) => setTimeout(r, 50));

		const failureWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("rejected event"));
		expect(failureWarns).toHaveLength(1);
		expect(failureWarns[0][0]).toContain("flaky");
		expect(failureWarns[0][0]).toContain("boom");

		// Now provider recovers — should warn exactly once about recovery.
		shouldFail = false;
		for (let i = 0; i < 3; i++) {
			dispatchTelemetryEvent({
				kind: "turn_start",
				sessionId: "s1",
				turnIndex: 10 + i,
				timestamp: 10 + i,
			});
		}
		await new Promise((r) => setTimeout(r, 50));

		const recoveryWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("recovered"));
		expect(recoveryWarns).toHaveLength(1);
		expect(recoveryWarns[0][0]).toContain("flaky");
	});

	// L2-04: separate providers track independently
	it("tracks failures per provider independently", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerTelemetryProvider(
			makeProvider({
				name: "a",
				trackEvent: vi.fn(async () => {
					throw new Error("a-fail");
				}),
			}),
		);
		registerTelemetryProvider(
			makeProvider({
				name: "b",
				trackEvent: vi.fn(async () => {
					throw new Error("b-fail");
				}),
			}),
		);

		dispatchTelemetryEvent({
			kind: "agent_start",
			sessionId: "s1",
			timestamp: 1,
		});
		await new Promise((r) => setTimeout(r, 50));

		const failureWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("rejected event"));
		expect(failureWarns).toHaveLength(2);
		expect(failureWarns.some((c) => String(c[0]).includes("a"))).toBe(true);
		expect(failureWarns.some((c) => String(c[0]).includes("b"))).toBe(true);
	});

	// L2-05: dispatcher.maxQueueSize is config-driven (default 100)
	it("honours config.dispatcher.maxQueueSize for backpressure cap", async () => {
		vi.mocked(loadTelemetryConfig).mockReturnValue({
			providers: {},
			events: "*",
			llmPayload: "off",
			dispatcher: { maxQueueSize: 5 },
		});
		resetTelemetryDispatcher();

		const events: TelemetryEvent[] = [];
		registerTelemetryProvider(
			makeProvider({
				trackEvent: vi.fn(async (e) => {
					events.push(e);
				}),
			}),
		);

		// Queue 20 synchronously — with cap of 5, expect 1 (first drain) + 5 = 6.
		for (let i = 0; i < 20; i++) {
			dispatchTelemetryEvent({
				kind: "turn_start",
				sessionId: "s1",
				turnIndex: i,
				timestamp: i,
			});
		}
		await new Promise((r) => setTimeout(r, 50));
		expect(events).toHaveLength(6);
	});

	// Q3 fix: backpressure drop counting and warning
	it("warns on every 10th backpressure drop (Q3)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerTelemetryProvider(
			makeProvider({
				trackEvent: vi.fn(async () => {
					// Slow provider — forces queue growth
					await new Promise((r) => setTimeout(r, 50));
				}),
			}),
		);

		// Queue 120 events synchronously — 20 will be dropped (queue caps at 100)
		for (let i = 0; i < 120; i++) {
			dispatchTelemetryEvent({
				kind: "turn_start",
				sessionId: "s1",
				turnIndex: i,
				timestamp: i,
			});
		}

		await new Promise((r) => setTimeout(r, 200));
		// dropCount reaches 20 → warn at 10th and 20th drop
		const backpressureWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("dropped"));
		expect(backpressureWarns.length).toBeGreaterThanOrEqual(1);
		expect(backpressureWarns[0][0]).toContain("dropped 10 events due to backpressure");
	});
});
