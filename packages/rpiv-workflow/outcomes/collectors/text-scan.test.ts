import { describe, expect, it } from "vitest";
import { type ArtifactHandle, fs } from "../../handle.js";
import type { BranchEntry } from "../../transcript.js";
import { textScanCollector } from "./text-scan.js";

const asst = (text: string): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

const ctxOf = (branch: BranchEntry[], skill = "build") => ({
	cwd: "/tmp",
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch,
	branchOffset: undefined,
	snapshot: undefined,
	skill,
});

describe("textScanCollector", () => {
	it("emits a single primary artifact via toHandle on match", async () => {
		const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
		expect(await c.collect(ctxOf([asst("done — see outputs/run-1.md for the result")]) as never)).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "fs", path: "outputs/run-1.md" }, role: "primary" }],
		});
	});

	it("is fatal with the noun-templated message on miss", async () => {
		const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
		const result = await c.collect(ctxOf([asst("nothing here")]) as never);
		expect(result.kind).toBe("fatal");
		expect((result as { message: string }).message).toMatch(/build finished without producing a path matching/);
	});

	it("honours a custom toHandle (url)", async () => {
		const url = (href: string): ArtifactHandle => ({ kind: "url", href });
		const c = textScanCollector({ pattern: /https:\/\/[\w.]+/g, toHandle: url, noun: "URL" });
		expect(await c.collect(ctxOf([asst("deployed at https://example.com")]) as never)).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "url", href: "https://example.com" }, role: "primary" }],
		});
	});
});
