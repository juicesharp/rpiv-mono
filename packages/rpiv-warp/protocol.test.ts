import { beforeEach, describe, expect, it } from "vitest";
import {
	BROKEN_VERSIONS,
	detectWarpEnvironment,
	hasStructuredProtocol,
	isBrokenVersion,
	isWarpTerminal,
	negotiateProtocolVersion,
	PLUGIN_MAX_PROTOCOL_VERSION,
	parseWarpVersion,
	readClientVersion,
	supportsStructured,
	tupleLeq,
	type VersionTuple,
} from "./protocol.js";

const WARP_ENV_VARS = ["TERM_PROGRAM", "WARP_CLI_AGENT_PROTOCOL_VERSION", "WARP_CLIENT_VERSION"] as const;

beforeEach(() => {
	for (const k of WARP_ENV_VARS) delete process.env[k];
});

describe("isWarpTerminal", () => {
	it("returns true when TERM_PROGRAM === WarpTerminal", () => {
		process.env.TERM_PROGRAM = "WarpTerminal";
		expect(isWarpTerminal()).toBe(true);
	});
	it("returns false when TERM_PROGRAM is unset", () => {
		expect(isWarpTerminal()).toBe(false);
	});
	it("returns false for other terminals", () => {
		process.env.TERM_PROGRAM = "iTerm.app";
		expect(isWarpTerminal()).toBe(false);
	});
});

describe("hasStructuredProtocol / readClientVersion", () => {
	it("hasStructuredProtocol returns true on any non-empty value", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		expect(hasStructuredProtocol()).toBe(true);
	});
	it("hasStructuredProtocol returns false when unset", () => {
		expect(hasStructuredProtocol()).toBe(false);
	});
	it("hasStructuredProtocol returns false on empty string", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "";
		expect(hasStructuredProtocol()).toBe(false);
	});
	it("readClientVersion returns the env value or undefined", () => {
		expect(readClientVersion()).toBeUndefined();
		process.env.WARP_CLIENT_VERSION = "v0.2026.04.01.00.00.stable_01";
		expect(readClientVersion()).toBe("v0.2026.04.01.00.00.stable_01");
	});
});

describe("negotiateProtocolVersion", () => {
	it("returns PLUGIN_MAX_PROTOCOL_VERSION when env unset", () => {
		expect(negotiateProtocolVersion()).toBe(PLUGIN_MAX_PROTOCOL_VERSION);
	});
	it("returns 1 when env='1'", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		expect(negotiateProtocolVersion()).toBe(1);
	});
	it("clamps to plugin max when env='2'", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "2";
		expect(negotiateProtocolVersion()).toBe(PLUGIN_MAX_PROTOCOL_VERSION);
	});
	it("returns 0 when env='0' (Math.min picks the smaller)", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "0";
		expect(negotiateProtocolVersion()).toBe(0);
	});
	it("falls back to PLUGIN_MAX_PROTOCOL_VERSION on NaN env='abc'", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "abc";
		expect(negotiateProtocolVersion()).toBe(PLUGIN_MAX_PROTOCOL_VERSION);
	});
	it("falls back to PLUGIN_MAX_PROTOCOL_VERSION on empty string", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "";
		expect(negotiateProtocolVersion()).toBe(PLUGIN_MAX_PROTOCOL_VERSION);
	});
});

describe("parseWarpVersion", () => {
	it("returns null on undefined", () => {
		expect(parseWarpVersion(undefined)).toBeNull();
	});
	it("returns null on garbage", () => {
		expect(parseWarpVersion("not-a-version")).toBeNull();
	});
	it("parses a stable build", () => {
		const r = parseWarpVersion("v0.2026.04.10.12.34.stable_07");
		expect(r?.channel).toBe("stable");
		expect(r?.tuple).toEqual([2026, 4, 10, 12, 34, 7, 7]);
	});
	it("parses a preview build", () => {
		expect(parseWarpVersion("v0.2026.04.10.12.34.preview_07")?.channel).toBe("preview");
	});
	it("parses a dev build", () => {
		expect(parseWarpVersion("v0.2026.04.10.12.34.dev_07")?.channel).toBe("dev");
	});
});

describe("tupleLeq", () => {
	const a: VersionTuple = [2026, 3, 25, 8, 24, 5, 5];
	it("equal tuples return true", () => {
		expect(tupleLeq(a, a)).toBe(true);
	});
	it("strictly lower returns true", () => {
		expect(tupleLeq([2026, 3, 24, 0, 0, 0, 0], a)).toBe(true);
	});
	it("strictly higher returns false", () => {
		expect(tupleLeq([2026, 3, 26, 0, 0, 0, 0], a)).toBe(false);
	});
	it("decides on first divergence", () => {
		expect(tupleLeq([2026, 3, 25, 8, 24, 5, 4], a)).toBe(true);
		expect(tupleLeq([2026, 3, 25, 8, 24, 5, 6], a)).toBe(false);
	});
});

describe("isBrokenVersion", () => {
	it("returns false on null parsed input", () => {
		expect(isBrokenVersion(null)).toBe(false);
	});
	it("returns false for dev channel (table entry is null)", () => {
		expect(isBrokenVersion(parseWarpVersion("v0.2026.03.01.00.00.dev_01"))).toBe(false);
	});
	it("returns true at the stable threshold (inclusive)", () => {
		const stableThreshold = BROKEN_VERSIONS.stable;
		expect(stableThreshold).not.toBeNull();
		const literal = `v0.${stableThreshold![0]}.${stableThreshold![1]}.${stableThreshold![2]}.${stableThreshold![3]}.${stableThreshold![4]}.stable_${stableThreshold![6]}`;
		expect(isBrokenVersion(parseWarpVersion(literal))).toBe(true);
	});
	it("returns true below the stable threshold", () => {
		expect(isBrokenVersion(parseWarpVersion("v0.2026.01.01.00.00.stable_01"))).toBe(true);
	});
	it("returns false above the stable threshold", () => {
		expect(isBrokenVersion(parseWarpVersion("v0.2026.05.01.00.00.stable_01"))).toBe(false);
	});
	it("returns true at the preview threshold", () => {
		const previewThreshold = BROKEN_VERSIONS.preview;
		const literal = `v0.${previewThreshold![0]}.${previewThreshold![1]}.${previewThreshold![2]}.${previewThreshold![3]}.${previewThreshold![4]}.preview_${previewThreshold![6]}`;
		expect(isBrokenVersion(parseWarpVersion(literal))).toBe(true);
	});
});

describe("supportsStructured", () => {
	it("returns false without WARP_CLI_AGENT_PROTOCOL_VERSION", () => {
		expect(supportsStructured()).toBe(false);
	});
	it("returns false on broken stable", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		process.env.WARP_CLIENT_VERSION = "v0.2026.01.01.00.00.stable_01";
		expect(supportsStructured()).toBe(false);
	});
	it("returns true on a newer stable build", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		process.env.WARP_CLIENT_VERSION = "v0.2026.05.01.00.00.stable_01";
		expect(supportsStructured()).toBe(true);
	});
	it("returns true on dev (channel never broken)", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		process.env.WARP_CLIENT_VERSION = "v0.2026.01.01.00.00.dev_01";
		expect(supportsStructured()).toBe(true);
	});
	it("returns true when WARP_CLIENT_VERSION is unparseable", () => {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		process.env.WARP_CLIENT_VERSION = "garbage";
		expect(supportsStructured()).toBe(true);
	});
});

describe("detectWarpEnvironment", () => {
	it("non-Warp → both flags false", () => {
		expect(detectWarpEnvironment()).toEqual({ isWarp: false, supportsStructured: false });
	});
	it("Warp + working version → both true", () => {
		process.env.TERM_PROGRAM = "WarpTerminal";
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		process.env.WARP_CLIENT_VERSION = "v0.2026.05.01.00.00.stable_01";
		expect(detectWarpEnvironment()).toEqual({ isWarp: true, supportsStructured: true });
	});
	it("Warp + broken version → isWarp true, supportsStructured false", () => {
		process.env.TERM_PROGRAM = "WarpTerminal";
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		process.env.WARP_CLIENT_VERSION = "v0.2026.01.01.00.00.stable_01";
		expect(detectWarpEnvironment()).toEqual({ isWarp: true, supportsStructured: false });
	});
});
