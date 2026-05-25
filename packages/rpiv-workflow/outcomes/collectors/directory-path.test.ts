import { describe, expect, it } from "vitest";
import type { BranchEntry } from "../../transcript.js";
import { directoryPathCollector } from "./directory-path.js";

const asst = (text: string): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

const ctxOf = (branch: BranchEntry[]) => ({
	cwd: "/tmp",
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch,
	branchOffset: undefined,
	snapshot: undefined,
	skill: "test",
});

describe("directoryPathCollector", () => {
	it("throws when dir is missing or empty", () => {
		// @ts-expect-error — intentional misuse
		expect(() => directoryPathCollector({})).toThrow(/dir.*required/);
		expect(() => directoryPathCollector({ dir: "" })).toThrow(/dir.*required/);
	});

	it("matches files under the directory with any extension when ext omitted", async () => {
		const collector = directoryPathCollector({ dir: "docs/adr" });
		const ctx = ctxOf([asst("Wrote docs/adr/0042-init.md and docs/adr/notes.txt")]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "fs",
			path: "docs/adr/notes.txt",
		});
	});

	it("narrows by extension when supplied", async () => {
		const collector = directoryPathCollector({ dir: "docs/adr", ext: "md" });
		const ctx = ctxOf([asst("Wrote docs/adr/0042-init.md and docs/adr/notes.txt")]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "fs",
			path: "docs/adr/0042-init.md",
		});
	});

	it("escapes regex metacharacters in dir (e.g. dots in subfolder names)", async () => {
		const collector = directoryPathCollector({ dir: ".rpiv/artifacts/research.v2", ext: "md" });
		const ctx = ctxOf([asst("Result: .rpiv/artifacts/research.v2/topic.md")]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "fs",
			path: ".rpiv/artifacts/research.v2/topic.md",
		});
	});

	it("fatals when nothing matches the directory", async () => {
		const collector = directoryPathCollector({ dir: "docs/adr", ext: "md" });
		const ctx = ctxOf([asst("Wrote elsewhere/file.md")]);
		const result = await collector.collect(ctx);
		expect(result.kind).toBe("fatal");
	});
});
