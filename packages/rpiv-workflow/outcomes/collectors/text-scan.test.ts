import { describe, expect, it } from "vitest";
import { type ArtifactHandle, fs } from "../../handle.js";
import type { BranchEntry } from "../../transcript.js";
import { textScanCollector } from "./text-scan.js";

const asst = (text: string): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

const asstTool = (parts: unknown[]): BranchEntry =>
	({ type: "message", message: { role: "assistant", content: parts } }) as BranchEntry;

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

	it("an assistant-text hit still wins when tool arguments also match (text-present path unchanged)", async () => {
		const branch = [
			asstTool([
				{ type: "tool_use", name: "write", input: { path: "outputs/from-tool.md" } },
				{ type: "text", text: "wrote outputs/from-text.md" },
			]),
		];
		const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
		expect(await c.collect(ctxOf(branch) as never)).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "fs", path: "outputs/from-text.md" }, role: "primary" }],
		});
	});

	it("a tool-argument-only hit (a write-shaped use whose input value matches) collects through the same handle constructor", async () => {
		const branch = [asstTool([{ type: "tool_use", name: "write", input: { path: "outputs/only-in-tool.md" } }])];
		const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
		expect(await c.collect(ctxOf(branch) as never)).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "fs", path: "outputs/only-in-tool.md" }, role: "primary" }],
		});
	});

	it("the fatal names BOTH scanned surfaces when neither hits", async () => {
		const branch = [asstTool([{ type: "tool_use", name: "write", input: { path: "elsewhere/x.txt" } }])];
		const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
		const result = await c.collect(ctxOf(branch) as never);
		expect(result.kind).toBe("fatal");
		expect((result as { message: string }).message).toMatch(/scanned assistant text and tool-call arguments/);
	});

	it("match narrows the tool-arg fallback: a filtered-out read contributes nothing, the matching write still hits", async () => {
		const branch = [
			asstTool([
				{ type: "tool_use", name: "write", input: { path: "outputs/fresh.md" } },
				{ type: "tool_use", name: "read", input: { path: "outputs/prior.md" } },
			]),
		];
		const c = textScanCollector({
			pattern: /outputs\/[\w.-]+\.md/g,
			toHandle: fs,
			noun: "path",
			match: (tc) => tc.name === "write",
		});
		expect(await c.collect(ctxOf(branch) as never)).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "fs", path: "outputs/fresh.md" }, role: "primary" }],
		});
	});

	it("the assistant-text scan is independent of match (text hit collects even when every tool call is filtered out)", async () => {
		const branch = [
			asstTool([
				{ type: "tool_use", name: "read", input: { path: "outputs/from-tool.md" } },
				{ type: "text", text: "wrote outputs/from-text.md" },
			]),
		];
		const c = textScanCollector({
			pattern: /outputs\/[\w.-]+\.md/g,
			toHandle: fs,
			noun: "path",
			match: (tc) => tc.name === "write",
		});
		expect(await c.collect(ctxOf(branch) as never)).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "fs", path: "outputs/from-text.md" }, role: "primary" }],
		});
	});

	it("throws at construction (not collect time) when match is provided but not a function", () => {
		expect(() =>
			textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path", match: "nope" as never }),
		).toThrow(/textScanCollector: `match` must be a function when provided/);
	});

	// The host's own part spelling: `@earendil-works/pi-ai` emits
	// `{ type: "toolCall", name, arguments }`, and every persisted Pi session carries
	// it. The fixtures above use the `tool_use`/`input` wire spelling; both must
	// collect identically, or the tool-argument fallback is dead against real
	// branches while its tests stay green.
	describe("the live toolCall/arguments shape", () => {
		it("a toolCall-only hit collects exactly like a tool_use-only hit", async () => {
			const branch = [
				asstTool([
					{
						type: "toolCall",
						id: "c1",
						name: "write",
						arguments: { path: "outputs/only-in-tool.md", content: "x" },
					},
				]),
			];
			const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
			expect(await c.collect(ctxOf(branch) as never)).toEqual({
				kind: "ok",
				artifacts: [{ handle: { kind: "fs", path: "outputs/only-in-tool.md" }, role: "primary" }],
			});
		});

		it("match sees the normalised { name, input } under the toolCall spelling", async () => {
			const branch = [
				asstTool([
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "outputs/read-only.md" } },
					{ type: "toolCall", id: "c2", name: "write", arguments: { path: "outputs/written.md", content: "x" } },
					{ type: "toolCall", id: "c3", name: "read", arguments: { path: "outputs/read-later.md" } },
				]),
			];
			const c = textScanCollector({
				pattern: /outputs\/[\w.-]+\.md/g,
				toHandle: fs,
				noun: "path",
				match: (tc) => tc.name === "write",
			});
			expect(await c.collect(ctxOf(branch) as never)).toEqual({
				kind: "ok",
				artifacts: [{ handle: { kind: "fs", path: "outputs/written.md" }, role: "primary" }],
			});
		});

		it("a mixed branch (one spelling per turn) is walked in order — the later call wins", async () => {
			const branch = [
				asstTool([{ type: "tool_use", name: "write", input: { path: "outputs/first.md" } }]),
				asstTool([{ type: "toolCall", id: "c2", name: "write", arguments: { path: "outputs/second.md" } }]),
			];
			const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
			expect(await c.collect(ctxOf(branch) as never)).toEqual({
				kind: "ok",
				artifacts: [{ handle: { kind: "fs", path: "outputs/second.md" }, role: "primary" }],
			});
		});
	});

	describe("argKeys narrows which argument values the fallback consults", () => {
		it("a sibling path quoted in `content` never outranks the `path` actually written", async () => {
			const branch = [
				asstTool([
					{
						type: "toolCall",
						id: "c1",
						name: "write",
						arguments: { path: "outputs/mine.md", content: "source: outputs/sibling.md\n# body" },
					},
				]),
			];
			const c = textScanCollector({
				pattern: /outputs\/[\w.-]+\.md/g,
				toHandle: fs,
				noun: "path",
				argKeys: ["path"],
			});
			expect(await c.collect(ctxOf(branch) as never)).toEqual({
				kind: "ok",
				artifacts: [{ handle: { kind: "fs", path: "outputs/mine.md" }, role: "primary" }],
			});
		});

		it("without argKeys every string argument is scanned (unchanged default)", async () => {
			const branch = [
				asstTool([
					{
						type: "toolCall",
						id: "c1",
						name: "write",
						arguments: { path: "outputs/mine.md", content: "source: outputs/sibling.md" },
					},
				]),
			];
			const c = textScanCollector({ pattern: /outputs\/[\w.-]+\.md/g, toHandle: fs, noun: "path" });
			const r = await c.collect(ctxOf(branch) as never);
			// Object.entries order: path first, then content — the last hit is content's.
			expect(r.kind === "ok" && r.artifacts[0]?.handle).toEqual({ kind: "fs", path: "outputs/sibling.md" });
		});

		it("a key the call does not carry contributes nothing (falls to fatal)", async () => {
			const branch = [
				asstTool([{ type: "toolCall", id: "c1", name: "write", arguments: { content: "outputs/x.md" } }]),
			];
			const c = textScanCollector({
				pattern: /outputs\/[\w.-]+\.md/g,
				toHandle: fs,
				noun: "path",
				argKeys: ["path"],
			});
			expect((await c.collect(ctxOf(branch) as never)).kind).toBe("fatal");
		});

		it("throws at construction when argKeys is empty or non-string", () => {
			expect(() => textScanCollector({ pattern: /x/g, toHandle: fs, noun: "path", argKeys: [] })).toThrow(
				/textScanCollector: `argKeys` must be a non-empty array of strings when provided/,
			);
			expect(() => textScanCollector({ pattern: /x/g, toHandle: fs, noun: "path", argKeys: [1] as never })).toThrow(
				/argKeys/,
			);
		});
	});
});
