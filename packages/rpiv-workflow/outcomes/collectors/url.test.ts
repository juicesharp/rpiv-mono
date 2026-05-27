import { describe, expect, it } from "vitest";
import type { BranchEntry } from "../../transcript.js";
import { urlCollector } from "./url.js";

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

describe("urlCollector", () => {
	it("emits a url() handle for an https URL in assistant text", async () => {
		const collector = urlCollector();
		const ctx = ctxOf([asst("Opened https://github.com/owner/repo/pull/42 for review.")]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "url",
			href: "https://github.com/owner/repo/pull/42",
		});
	});

	it("trims trailing prose punctuation (.,;:!?))", async () => {
		const collector = urlCollector();
		const ctx = ctxOf([asst("See https://example.com/page.")]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "url",
			href: "https://example.com/page",
		});
	});

	it("returns the last URL when multiple appear", async () => {
		const collector = urlCollector();
		const ctx = ctxOf([asst("first: https://a.com second: https://b.com")]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "url", href: "https://b.com" });
	});

	it("fatals when no URL is found", async () => {
		const collector = urlCollector();
		const ctx = ctxOf([asst("no link here")]);
		const result = await collector.collect(ctx);
		expect(result.kind).toBe("fatal");
	});

	it("accepts a narrower pattern (e.g. only linear.app URLs)", async () => {
		const collector = urlCollector({ pattern: /https:\/\/linear\.app\/[^\s)]+/g });
		const ctx = ctxOf([
			asst("Filed https://github.com/owner/r/issues/1 and https://linear.app/team/issue/ENG-42 — see linear."),
		]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "url",
			href: "https://linear.app/team/issue/ENG-42",
		});
	});
});
