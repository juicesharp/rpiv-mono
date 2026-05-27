import { beforeEach, describe, expect, it, vi } from "vitest";
import { isEventEnabled, validateEventAllowlist } from "./config.js";
import type { TelemetryEventKind } from "./types/events.js";

describe("validateEventAllowlist", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns '*' when events is undefined (all events enabled)", () => {
		expect(validateEventAllowlist(undefined)).toBe("*");
	});

	it("returns '*' when events is explicitly '*'", () => {
		expect(validateEventAllowlist("*")).toBe("*");
	});

	it("returns [] when events is empty array (none enabled)", () => {
		expect(validateEventAllowlist([])).toEqual([]);
	});

	it("returns [] when all entries are invalid (I1 — allow none, not allow all)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = validateEventAllowlist(["not_a_real_kind", "also_fake"]);
		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not_a_real_kind"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("also_fake"));
	});

	it("filters to valid entries only", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = validateEventAllowlist(["session_start", "invalid_kind", "tool_execution_end"]);
		expect(result).toEqual(["session_start", "tool_execution_end"]);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("invalid_kind"));
	});

	it("returns all entries when all are valid", () => {
		const result = validateEventAllowlist(["session_start", "agent_start"]);
		expect(result).toEqual(["session_start", "agent_start"]);
	});

	it("warns on rejected event kinds (Q2)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		validateEventAllowlist(["session_start", "bogus_event"]);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rpiv-telemetry]"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bogus_event"));
	});
});

describe("isEventEnabled", () => {
	it("returns true when allowedEvents is '*' (all enabled)", () => {
		expect(isEventEnabled("session_start", "*")).toBe(true);
	});

	it("returns false when allowedEvents is [] (none enabled)", () => {
		expect(isEventEnabled("session_start", [])).toBe(false);
	});

	it("returns true when kind is in the allowlist", () => {
		expect(isEventEnabled("session_start", ["session_start", "agent_start"] as TelemetryEventKind[])).toBe(true);
	});

	it("returns false when kind is not in the allowlist", () => {
		expect(isEventEnabled("session_start", ["agent_start", "turn_start"] as TelemetryEventKind[])).toBe(false);
	});
});
