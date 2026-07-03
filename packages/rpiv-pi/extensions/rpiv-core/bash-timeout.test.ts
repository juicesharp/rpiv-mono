/**
 * bash-timeout tests — the per-command bash watchdog over a child AgentSession.
 *
 * Drives `armBashWatchdog` against a fake session (captured subscribe listener +
 * abort spy) under fake timers: a bash call that overruns aborts once and records a
 * reason; one that finishes in time never fires; non-bash tools are ignored; dispose
 * unsubscribes + cancels pending timers. Plus the env-override clamp on the ceiling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armBashWatchdog, bashTimeoutReason, resolveBashTimeoutMs } from "./bash-timeout.js";

type AnyEvent = { type: string; [k: string]: unknown };

function fakeSession() {
	let listener: ((e: AnyEvent) => void) | undefined;
	const abort = vi.fn(async () => {});
	const session = {
		subscribe: vi.fn((l: (e: AnyEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		}),
		abort,
	};
	return {
		session: session as unknown as Parameters<typeof armBashWatchdog>[0],
		abort,
		emit: (e: AnyEvent) => listener?.(e),
		subscribed: () => listener !== undefined,
	};
}

const bashStart = (id: string, command: string): AnyEvent => ({
	type: "tool_execution_start",
	toolCallId: id,
	toolName: "bash",
	args: { command },
});
const bashEnd = (id: string): AnyEvent => ({
	type: "tool_execution_end",
	toolCallId: id,
	toolName: "bash",
	result: "",
	isError: false,
});

describe("armBashWatchdog", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("aborts once and records the reason when a bash call overruns the ceiling", () => {
		const f = fakeSession();
		const wd = armBashWatchdog(f.session, 1000);

		f.emit(bashStart("c1", "find / -name x"));
		expect(f.abort).not.toHaveBeenCalled();
		expect(wd.timedOut()).toBeUndefined();

		vi.advanceTimersByTime(1000);

		expect(f.abort).toHaveBeenCalledTimes(1);
		expect(wd.timedOut()?.reason).toContain("per-command timeout");
		expect(wd.timedOut()?.reason).toContain("find / -name x");
	});

	it("does not fire when the bash call finishes before the ceiling", () => {
		const f = fakeSession();
		const wd = armBashWatchdog(f.session, 1000);

		f.emit(bashStart("c1", "ls"));
		vi.advanceTimersByTime(500);
		f.emit(bashEnd("c1"));
		vi.advanceTimersByTime(5000);

		expect(f.abort).not.toHaveBeenCalled();
		expect(wd.timedOut()).toBeUndefined();
	});

	it("ignores non-bash tool calls", () => {
		const f = fakeSession();
		const wd = armBashWatchdog(f.session, 1000);

		f.emit({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "x" } });
		vi.advanceTimersByTime(5000);

		expect(f.abort).not.toHaveBeenCalled();
		expect(wd.timedOut()).toBeUndefined();
	});

	it("records a single abort when two concurrent bash calls both overrun (first wins)", () => {
		const f = fakeSession();
		const wd = armBashWatchdog(f.session, 1000);

		f.emit(bashStart("c1", "find / a"));
		f.emit(bashStart("c2", "find / b"));
		vi.advanceTimersByTime(1000);

		expect(f.abort).toHaveBeenCalledTimes(1);
		expect(wd.timedOut()?.reason).toContain("find / a");
	});

	it("dispose() unsubscribes and cancels a pending timer (no late abort)", () => {
		const f = fakeSession();
		const wd = armBashWatchdog(f.session, 1000);

		f.emit(bashStart("c1", "sleep 999"));
		wd.dispose();
		expect(f.subscribed()).toBe(false);

		vi.advanceTimersByTime(5000);
		expect(f.abort).not.toHaveBeenCalled();
		expect(wd.timedOut()).toBeUndefined();
	});
});

describe("resolveBashTimeoutMs", () => {
	it("defaults to 180s when the override is absent or non-numeric", () => {
		expect(resolveBashTimeoutMs(undefined)).toBe(180_000);
		expect(resolveBashTimeoutMs("not-a-number")).toBe(180_000);
		expect(resolveBashTimeoutMs("0")).toBe(180_000);
		expect(resolveBashTimeoutMs("-5")).toBe(180_000);
	});

	it("honours a valid override, clamped to [5s, 30min]", () => {
		expect(resolveBashTimeoutMs("60000")).toBe(60_000);
		expect(resolveBashTimeoutMs("1000")).toBe(5_000); // below floor → clamped up
		expect(resolveBashTimeoutMs("9999999")).toBe(30 * 60_000); // above cap → clamped down
	});
});

describe("bashTimeoutReason", () => {
	it("names the ceiling in seconds and echoes the command", () => {
		expect(bashTimeoutReason("find /", 180_000)).toBe(
			"bash command exceeded the 180s per-command timeout and was aborted: `find /`",
		);
	});

	it("truncates a long command", () => {
		const reason = bashTimeoutReason("x".repeat(300), 180_000);
		expect(reason).toContain("...");
		expect(reason.length).toBeLessThan(300);
	});
});
