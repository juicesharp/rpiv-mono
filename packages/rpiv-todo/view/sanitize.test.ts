import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "./sanitize.js";

describe("sanitizeTerminalText", () => {
	it("removes terminal control characters", () => {
		expect(sanitizeTerminalText("safe\u001b[31mred\u001b[0m\u009b2J")).toBe("safe[31mred[0m2J");
	});

	it("keeps task fields on one terminal line", () => {
		expect(sanitizeTerminalText("one\ntwo\tthree\r")).toBe("one two three ");
	});
});
