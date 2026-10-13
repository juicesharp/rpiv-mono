import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it } from "vitest";
import registerArgs, { LOADED_MARKER } from "./index.js";

const slots = globalThis as Record<symbol, unknown>;

// rpiv-pi's sibling detection reads this slot (SIBLINGS, rpiv-pi siblings.ts):
// rpiv-args registers no tool or command it could find by source path (#216).
describe("rpiv-args presence marker", () => {
	afterEach(() => {
		delete slots[Symbol.for(LOADED_MARKER)];
	});

	it("uses the key rpiv-pi's sibling registry expects", () => {
		expect(LOADED_MARKER).toBe("@juicesharp/rpiv-args:loaded");
	});

	it("is set when the extension loads", () => {
		delete slots[Symbol.for(LOADED_MARKER)];
		registerArgs(createMockPi().pi);
		expect(slots[Symbol.for(LOADED_MARKER)]).toBe(true);
	});
});
