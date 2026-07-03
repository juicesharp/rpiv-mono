import { describe, expect, it } from "vitest";
import { shortFailureReason } from "./lane-failure.js";

describe("shortFailureReason", () => {
	it("returns undefined for an absent/empty reason", () => {
		expect(shortFailureReason(undefined)).toBeUndefined();
		expect(shortFailureReason("")).toBeUndefined();
		expect(shortFailureReason("   ")).toBeUndefined();
	});

	it("cuts at the first ` — ` separator (the FailureText.error form)", () => {
		expect(shortFailureReason("vet truncated — model hit output-length cap mid-reply")).toBe("vet truncated");
		expect(shortFailureReason("blueprint aborted by user (ESC)")).toBe("blueprint aborted by user (ESC)");
	});

	it("returns the whole trimmed string when there is no separator", () => {
		const reason = "blueprint finished without producing a path matching .rpiv/artifacts/plans/...";
		expect(shortFailureReason(`  ${reason}  `)).toBe(reason);
	});
});
