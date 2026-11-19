import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import registerWebTools from "./index.ts";

const theme = makeTheme() as unknown as Theme;

function setup() {
	const { pi, captured } = createMockPi();
	registerWebTools(pi);
	const search = captured.tools.get("web_search");
	const fetchTool = captured.tools.get("web_fetch");
	if (!search || !fetchTool) throw new Error("tools not registered");
	return { search, fetch: fetchTool };
}

function rendered(node: unknown): string {
	return (node as { text: string }).text;
}

describe("web_search renderCall", () => {
	it('emits "WebSearch" label and quoted query', () => {
		const { search } = setup();
		const node = search.renderCall?.({ query: "ai news" } as never, theme, undefined as never) as Text;
		const text = rendered(node);
		expect(text).toContain("WebSearch");
		expect(text).toContain('"ai news"');
	});
});

describe("web_search renderResult", () => {
	it('returns "Searching..." while partial', () => {
		const { search } = setup();
		const node = search.renderResult?.(
			{ content: [], details: {} } as never,
			{ isPartial: true } as never,
			theme,
			undefined as never,
		) as Text;
		expect(rendered(node)).toContain("Searching...");
	});

	it("pluralizes result count (0 → results, 1 → result, 3 → results)", () => {
		const { search } = setup();
		const node = (count: number) =>
			search.renderResult?.(
				{ content: [], details: { resultCount: count, results: [] } } as never,
				{} as never,
				theme,
				undefined as never,
			) as Text;
		expect(rendered(node(0))).toContain("0 results");
		expect(rendered(node(1))).toContain("1 result");
		expect(rendered(node(1))).not.toContain("1 results");
		expect(rendered(node(3))).toContain("3 results");
	});

	it("collapsed view shows count only (no result titles)", () => {
		const { search } = setup();
		const results = [
			{ title: "First", url: "https://a", snippet: "" },
			{ title: "Second", url: "https://b", snippet: "" },
		];
		const node = search.renderResult?.(
			{ content: [], details: { resultCount: results.length, results } } as never,
			{ expanded: false } as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("2 results");
		expect(text).not.toContain("First");
		expect(text).not.toContain("Second");
	});

	it("expanded view lists all results when count <= preview limit (5)", () => {
		const { search } = setup();
		const results = Array.from({ length: 4 }, (_, i) => ({
			title: `R${i + 1}`,
			url: `https://x/${i}`,
			snippet: "",
		}));
		const node = search.renderResult?.(
			{ content: [], details: { resultCount: 4, results } } as never,
			{ expanded: true } as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("R1");
		expect(text).toContain("R4");
		expect(text).not.toContain("more");
	});

	it("expanded view caps at 5 and shows overflow line when count > 5", () => {
		const { search } = setup();
		const results = Array.from({ length: 7 }, (_, i) => ({
			title: `R${i + 1}`,
			url: `https://x/${i}`,
			snippet: "",
		}));
		const node = search.renderResult?.(
			{ content: [], details: { resultCount: 7, results } } as never,
			{ expanded: true } as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("R1");
		expect(text).toContain("R5");
		expect(text).not.toContain("R6");
		expect(text).toContain("... and 2 more");
	});
	it("error: shows the failure reason, generic label when no reason", () => {
		const { search } = setup();
		const withReason = search.renderResult?.(
			{ content: [{ type: "text", text: "rate limited" }], details: {}, isError: true } as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		expect(rendered(withReason)).toBe("✗ Failed: rate limited");
		const withoutReason = search.renderResult?.(
			{ content: [], details: {}, isError: true } as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		expect(rendered(withoutReason)).toBe("✗ Failed");
	});
});

describe("web_fetch renderCall", () => {
	it('emits "WebFetch" label and the URL', () => {
		const { fetch } = setup();
		const node = fetch.renderCall?.({ url: "https://example.com/page" } as never, theme, undefined as never) as Text;
		const text = rendered(node);
		expect(text).toContain("WebFetch");
		expect(text).toContain("https://example.com/page");
	});
});

describe("web_fetch renderResult", () => {
	it('returns "Fetching..." while partial', () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{ content: [], details: { url: "https://x" } } as never,
			{ isPartial: true } as never,
			theme,
			undefined as never,
		) as Text;
		expect(rendered(node)).toContain("Fetching...");
	});

	it("collapsed: success marker only when no title/no truncation", () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: "body" }], details: { url: "https://x" } } as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("✓ Fetched");
		expect(text).not.toContain(":");
		expect(text).not.toContain("(truncated)");
	});

	it("collapsed: includes title suffix when details.title set", () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: "body" }], details: { url: "https://x", title: "My Page" } } as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		expect(rendered(node)).toContain(": My Page");
	});

	it("collapsed: shows (truncated) when details.truncation.truncated", () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{
				content: [{ type: "text", text: "body" }],
				details: { url: "https://x", truncation: { truncated: true } },
			} as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		expect(rendered(node)).toContain("(truncated)");
	});

	it("collapsed: shows both title and (truncated) when both present", () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{
				content: [{ type: "text", text: "body" }],
				details: { url: "https://x", title: "T", truncation: { truncated: true } },
			} as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain(": T");
		expect(text).toContain("(truncated)");
	});

	it("expanded: preview shows all lines when content has ≤ 15 lines", () => {
		const { fetch } = setup();
		const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: body }], details: { url: "https://x" } } as never,
			{ expanded: true } as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("line 1");
		expect(text).toContain("line 10");
		expect(text).not.toContain("use read tool");
	});

	it("expanded: preview caps at 15 lines and shows overflow hint when content exceeds limit", () => {
		const { fetch } = setup();
		const body = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: body }], details: { url: "https://x" } } as never,
			{ expanded: true } as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("line 1");
		expect(text).toContain("line 15");
		expect(text).not.toContain("line 16");
		expect(text).toContain("use read tool to see full content");
	});

	it("error: shows the failure reason", () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: "kr-egress [imds] blocked" }], details: {}, isError: true } as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		expect(rendered(node)).toBe("✗ Failed: kr-egress [imds] blocked");
	});

	it("error: uses the render context when the result has no flag (older pi)", () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: "blocked" }], details: {} } as never,
			{} as never,
			theme,
			{ isError: true } as never,
		) as Text;
		expect(rendered(node)).toBe("✗ Failed: blocked");
	});

	it("error: reason is one line and capped so the line fits 80 columns", () => {
		const { fetch } = setup();
		const reason = `${"x".repeat(90)}\nsecond line`;
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: reason }], details: {}, isError: true } as never,
			{} as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toBe(`✗ Failed: ${"x".repeat(70)}`);
		expect(text).not.toContain("second line");
		expect(text.length).toBeLessThanOrEqual(80);
	});

	it("error: expanded shows the reason line and the content preview", () => {
		const { fetch } = setup();
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: "rate limited\nsecond line" }], details: {}, isError: true } as never,
			{ expanded: true } as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("✗ Failed: rate limited");
		expect(text).toContain("second line");
		expect(text.split("rate limited")).toHaveLength(2);
	});

	it("error: expanded preview counts 15 lines after the reason and shows the overflow hint", () => {
		const { fetch } = setup();
		const body = ["reason", ...Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)].join("\n");
		const node = fetch.renderResult?.(
			{ content: [{ type: "text", text: body }], details: {}, isError: true } as never,
			{ expanded: true } as never,
			theme,
			undefined as never,
		) as Text;
		const text = rendered(node);
		expect(text).toContain("✗ Failed: reason");
		expect(text).toContain("line 15");
		expect(text).not.toContain("line 16");
		expect(text).toContain("use read tool to see full content");
	});
});
