import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { setDisabledForModels } from "./advisor/index.js";
import { isModelBlocked } from "./advisor/policy.js";

const opus = { provider: "anthropic", id: "opus", name: "Opus" } as unknown as Model<Api>;
const sonnet = { provider: "anthropic", id: "sonnet", name: "Sonnet" } as unknown as Model<Api>;

beforeEach(() => {
	setDisabledForModels([]);
});

describe("isModelBlocked", () => {
	it("returns false when model is undefined", () => {
		setDisabledForModels(["anthropic:sonnet"]);
		expect(isModelBlocked(undefined)).toBe(false);
	});

	it("returns false when blocklist is empty", () => {
		expect(isModelBlocked(sonnet)).toBe(false);
	});

	it("returns true on string entry exact match", () => {
		setDisabledForModels(["anthropic:sonnet"]);
		expect(isModelBlocked(sonnet)).toBe(true);
	});

	it("returns false on string entry non-match", () => {
		setDisabledForModels(["anthropic:sonnet"]);
		expect(isModelBlocked(opus)).toBe(false);
	});

	it("returns true on object entry without minEffort (always blocked)", () => {
		setDisabledForModels([{ model: "anthropic:sonnet" }]);
		expect(isModelBlocked(sonnet)).toBe(true);
		expect(isModelBlocked(sonnet, "minimal")).toBe(true);
		expect(isModelBlocked(sonnet, "xhigh")).toBe(true);
		expect(isModelBlocked(sonnet, "max")).toBe(true);
	});

	it("returns false on object entry when model key does not match", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "low" }]);
		expect(isModelBlocked(opus, "high")).toBe(false);
	});

	it("returns true when executor effort equals threshold (>=)", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "high")).toBe(true);
	});

	it("returns true when executor effort above threshold", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "xhigh")).toBe(true);
		expect(isModelBlocked(sonnet, "max")).toBe(true);
	});

	it("returns false when executor effort below threshold", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "low")).toBe(false);
		expect(isModelBlocked(sonnet, "medium")).toBe(false);
	});

	it("returns false when executor effort is undefined with a minEffort threshold", () => {
		// indexOf(undefined) === -1, which is below any threshold ordinal.
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "minimal" }]);
		expect(isModelBlocked(sonnet, undefined)).toBe(false);
	});

	it("returns true when any entry in a mixed list matches", () => {
		setDisabledForModels(["openai:gpt-5", { model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "high")).toBe(true);
	});

	it("returns false when no entry in a mixed list matches", () => {
		setDisabledForModels(["openai:gpt-5", { model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(opus, "high")).toBe(false);
	});
});
