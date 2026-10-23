import { describe, expect, it } from "vitest";
import { FLAG_DEBUG, MSG_TYPE_GIT_CONTEXT, MSG_TYPE_GUIDANCE } from "./constants.ts";

describe("rpiv-core constants", () => {
	it("FLAG_DEBUG is the canonical debug-flag name", () => {
		expect(FLAG_DEBUG).toBe("rpiv-debug");
	});
	it("MSG_TYPE_GIT_CONTEXT is the canonical git-context message type", () => {
		expect(MSG_TYPE_GIT_CONTEXT).toBe("rpiv-git-context");
	});
	it("MSG_TYPE_GUIDANCE is the canonical guidance message type", () => {
		expect(MSG_TYPE_GUIDANCE).toBe("rpiv-guidance");
	});
});
