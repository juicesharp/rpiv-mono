import { describe, expect, it } from "vitest";
import {
	AGENT_ENABLEMENT_GRANTS,
	installedExtensionNames,
	mergeCsvAdditions,
	mergeFlowSeqAdditions,
	resolveAgentEnablement,
} from "./agent-enablement.js";

describe("mergeCsvAdditions", () => {
	it("returns additions alone when existing is undefined", () => {
		expect(mergeCsvAdditions(undefined, ["a", "b"])).toBe("a, b");
	});

	it("returns undefined for absent existing and empty additions (no key emitted)", () => {
		expect(mergeCsvAdditions(undefined, [])).toBeUndefined();
	});

	it("preserves base order and appends absent additions in given order", () => {
		expect(mergeCsvAdditions("grep, find", ["ls", "grep", "ext:sib/tool"])).toBe("grep, find, ls, ext:sib/tool");
	});

	it("normalizes spacing and dedupes within the existing value itself", () => {
		expect(mergeCsvAdditions("grep,find, grep", ["find"])).toBe("grep, find");
	});

	it("is a fixed point: additions already present leave canonical output unchanged", () => {
		const once = mergeCsvAdditions("grep, find, ls", ["ext:sib/tool"]);
		expect(mergeCsvAdditions(once, ["ext:sib/tool", "ls"])).toBe(once);
	});

	it("skips boolean-ish sentinels", () => {
		for (const sentinel of ["true", "false", "none", "True", "NONE"]) {
			expect(mergeCsvAdditions(sentinel, ["a"])).toBeUndefined();
		}
	});

	it("skips non-scalar forms for the CSV context", () => {
		expect(mergeCsvAdditions("[grep, find]", ["a"])).toBeUndefined(); // flow sequence
		expect(mergeCsvAdditions("", ["a"])).toBeUndefined(); // empty scalar / block-sequence head
	});
});

describe("mergeFlowSeqAdditions", () => {
	it("returns additions alone (rendered as a flow sequence) when existing is undefined", () => {
		expect(mergeFlowSeqAdditions(undefined, ["rpiv-warp"])).toBe("[rpiv-warp]");
		expect(mergeFlowSeqAdditions(undefined, [])).toBeUndefined();
	});

	it("merges into an existing flow sequence preserving base order", () => {
		expect(mergeFlowSeqAdditions("[rpiv-web-tools]", ["rpiv-warp"])).toBe("[rpiv-web-tools, rpiv-warp]");
	});

	it("accepts a bare scalar as a one-element base", () => {
		expect(mergeFlowSeqAdditions("rpiv-web-tools", ["rpiv-warp"])).toBe("[rpiv-web-tools, rpiv-warp]");
	});

	it("is a fixed point on canonical output", () => {
		const once = mergeFlowSeqAdditions("[rpiv-web-tools]", ["rpiv-warp"]);
		expect(mergeFlowSeqAdditions(once, ["rpiv-warp", "rpiv-web-tools"])).toBe(once);
	});

	it("skips sentinels and non-scalar forms for the flow-sequence context", () => {
		expect(mergeFlowSeqAdditions("false", ["a"])).toBeUndefined();
		expect(mergeFlowSeqAdditions("a, b", ["c"])).toBeUndefined(); // CSV form
		expect(mergeFlowSeqAdditions("[a", ["b"])).toBeUndefined(); // unclosed bracket
		expect(mergeFlowSeqAdditions("", ["a"])).toBeUndefined();
	});
});

describe("resolveAgentEnablement", () => {
	const GATE_ON = new Set(["rpiv-warp"]);
	// Fixture grants map (injected): the shipped AGENT_ENABLEMENT_GRANTS is
	// deliberately empty, so the map-resolution semantics are pinned against a
	// fixture — the shape the rpiv-lsp experiment used (backup/lsp-experiment).
	const GRANTS = {
		"integration-scanner": {
			extensions: ["rpiv-warp"],
			tools: ["ext:rpiv-warp/tool_a"],
		},
	} as const;

	it("returns the map entry for a granted agent when every provider is installed", () => {
		expect(resolveAgentEnablement("integration-scanner", undefined, GATE_ON, GRANTS)).toEqual({
			extensions: ["rpiv-warp"],
			tools: ["ext:rpiv-warp/tool_a"],
		});
	});

	it("the shipped grants map is empty — map-only resolution is inactive for every agent", () => {
		expect(Object.keys(AGENT_ENABLEMENT_GRANTS)).toEqual([]);
		expect(resolveAgentEnablement("integration-scanner", undefined, GATE_ON)).toBeUndefined();
		expect(resolveAgentEnablement("codebase-analyzer", undefined, GATE_ON)).toBeUndefined();
	});

	it("is inactive when installedExtensions is undefined (gate closed)", () => {
		expect(resolveAgentEnablement("integration-scanner", undefined, undefined, GRANTS)).toBeUndefined();
	});

	it("is inactive when a named provider is not installed", () => {
		expect(resolveAgentEnablement("integration-scanner", undefined, new Set(), GRANTS)).toBeUndefined();
		// Tool provider missing even though the extension list checks out.
		expect(
			resolveAgentEnablement("integration-scanner", { tools: ["ext:other-sib/x"] }, GATE_ON, GRANTS),
		).toBeUndefined();
		// Extension provider missing.
		expect(
			resolveAgentEnablement("integration-scanner", { extensions: ["other-sib"] }, GATE_ON, GRANTS),
		).toBeUndefined();
	});

	it("replaces a map field wholesale with a configured array (including [])", () => {
		expect(
			resolveAgentEnablement("integration-scanner", { tools: ["ext:rpiv-warp/tool_b"] }, GATE_ON, GRANTS),
		).toEqual({
			extensions: ["rpiv-warp"],
			tools: ["ext:rpiv-warp/tool_b"],
		});
		expect(resolveAgentEnablement("integration-scanner", { tools: [] }, GATE_ON, GRANTS)).toEqual({
			extensions: ["rpiv-warp"],
			tools: [],
		});
	});

	it("grants config-only enablement to agents outside the map (the shipped-empty-map path)", () => {
		expect(resolveAgentEnablement("claim-verifier", { tools: ["ext:rpiv-warp/tool_a"] }, GATE_ON)).toEqual({
			extensions: [],
			tools: ["ext:rpiv-warp/tool_a"],
		});
	});

	it("plain (non-ext:) tool selectors need no installed provider", () => {
		expect(resolveAgentEnablement("integration-scanner", { extensions: [], tools: ["read"] }, new Set())).toEqual({
			extensions: [],
			tools: ["read"],
		});
	});

	it("returns undefined for an unconfigured agent outside the map", () => {
		expect(resolveAgentEnablement("claim-verifier", undefined, GATE_ON, GRANTS)).toBeUndefined();
	});
});

describe("installedExtensionNames", () => {
	it("derives the extension name from npm-scoped spec strings", () => {
		expect(installedExtensionNames(["npm:@juicesharp/rpiv-warp"])).toEqual(new Set(["rpiv-warp"]));
		expect(installedExtensionNames(["@juicesharp/rpiv-web-tools", "rpiv-todo"])).toEqual(
			new Set(["rpiv-web-tools", "rpiv-todo"]),
		);
	});

	it("returns an empty set for no packages", () => {
		expect(installedExtensionNames([])).toEqual(new Set());
	});
});
