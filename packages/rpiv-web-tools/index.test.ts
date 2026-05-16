import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi, stubFetch } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, type vi } from "vitest";
import registerWebTools from "./index.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-web-tools", "config.json");

function registerAndCapture() {
	const { pi, captured } = createMockPi();
	registerWebTools(pi);
	return { pi, captured };
}

function writeConfig(contents: unknown) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

beforeEach(() => {
	delete process.env.BRAVE_SEARCH_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.SERPER_API_KEY;
	delete process.env.EXA_API_KEY;
	delete process.env.JINA_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
	rmSync(CONFIG_PATH, { force: true });
});

describe("registerWebTools — registration", () => {
	it("registers web_search + web_fetch tools", () => {
		const { captured } = registerAndCapture();
		expect(captured.tools.has("web_search")).toBe(true);
		expect(captured.tools.has("web_fetch")).toBe(true);
	});

	it("registers /web-search-config command", () => {
		const { captured } = registerAndCapture();
		expect(captured.commands.has("web-search-config")).toBe(true);
	});

	it("web_search schema declares min:1, max:10, default:5", () => {
		const { captured } = registerAndCapture();
		const params = captured.tools.get("web_search")?.parameters as unknown as {
			properties: { max_results: { minimum: number; maximum: number; default: number } };
		};
		expect(params.properties.max_results).toMatchObject({ minimum: 1, maximum: 10, default: 5 });
	});
});

const PROVIDER_MATRIX = [
	{
		provider: "brave",
		envVar: "BRAVE_SEARCH_API_KEY",
		urlMatcher: (u: string) => u.includes("api.search.brave.com"),
		buildResponse: () =>
			JSON.stringify({
				web: { results: [{ title: "T", url: "https://x", description: "snip" }] },
			}),
		emptyResponse: () => JSON.stringify({ web: { results: [] } }),
		authHeader: "X-Subscription-Token" as string | null,
	},
	{
		provider: "tavily",
		envVar: "TAVILY_API_KEY",
		urlMatcher: (u: string) => u.includes("api.tavily.com"),
		buildResponse: () => JSON.stringify({ results: [{ title: "T", url: "https://x", content: "snip" }] }),
		emptyResponse: () => JSON.stringify({ results: [] }),
		authHeader: null,
	},
	{
		provider: "serper",
		envVar: "SERPER_API_KEY",
		urlMatcher: (u: string) => u.includes("google.serper.dev"),
		buildResponse: () => JSON.stringify({ organic: [{ title: "T", link: "https://x", snippet: "snip" }] }),
		emptyResponse: () => JSON.stringify({ organic: [] }),
		authHeader: "X-API-KEY" as string | null,
	},
	{
		provider: "exa",
		envVar: "EXA_API_KEY",
		urlMatcher: (u: string) => u.includes("api.exa.ai"),
		buildResponse: () => JSON.stringify({ results: [{ title: "T", url: "https://x", text: "snip" }] }),
		emptyResponse: () => JSON.stringify({ results: [] }),
		authHeader: "x-api-key" as string | null,
	},
	{
		provider: "jina",
		envVar: "JINA_API_KEY",
		urlMatcher: (u: string) => u.includes("s.jina.ai"),
		buildResponse: () =>
			JSON.stringify({
				code: 200,
				status: 20000,
				data: {
					results: [{ title: "T", url: "https://x", description: "snip" }],
				},
			}),
		emptyResponse: () => JSON.stringify({ code: 200, status: 20000, data: { results: [] } }),
		authHeader: "Authorization" as string | null,
	},
	{
		provider: "firecrawl",
		envVar: "FIRECRAWL_API_KEY",
		urlMatcher: (u: string) => u.includes("api.firecrawl.dev"),
		buildResponse: () =>
			JSON.stringify({
				success: true,
				data: [{ title: "T", url: "https://x", description: "snip" }],
			}),
		emptyResponse: () => JSON.stringify({ success: true, data: [] }),
		authHeader: "Authorization" as string | null,
	},
] as const;

describe.each(PROVIDER_MATRIX)("web_search.execute — $provider", ({
	provider,
	envVar,
	urlMatcher,
	buildResponse,
	emptyResponse,
	authHeader,
}) => {
	it(`uses env key for ${provider}`, async () => {
		process.env[envVar] = "env-key";
		writeConfig({ provider });
		const stub = stubFetch([
			{
				match: urlMatcher,
				response: () => new Response(buildResponse(), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello", max_results: 3 }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ type: "text" });
		if (authHeader) {
			const headers = stub.calls[0].init?.headers as Record<string, string>;
			const headerVal = headers[authHeader];
			if (provider === "jina" || provider === "firecrawl") {
				expect(headerVal).toBe("Bearer env-key");
			} else {
				expect(headerVal).toBe("env-key");
			}
		} else {
			const body = JSON.parse(stub.calls[0].init?.body as string);
			expect(body.api_key).toBe("env-key");
		}
	});

	it(`falls back to config key for ${provider}`, async () => {
		writeConfig({ provider, apiKeys: { [provider]: "config-key" } });
		const stub = stubFetch([
			{
				match: urlMatcher,
				response: () => new Response(buildResponse(), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		if (authHeader) {
			const headers = stub.calls[0].init?.headers as Record<string, string>;
			const headerVal = headers[authHeader];
			if (provider === "jina" || provider === "firecrawl") {
				expect(headerVal).toBe("Bearer config-key");
			} else {
				expect(headerVal).toBe("config-key");
			}
		} else {
			const body = JSON.parse(stub.calls[0].init?.body as string);
			expect(body.api_key).toBe("config-key");
		}
	});

	it(`throws when no key configured for ${provider}`, async () => {
		writeConfig({ provider });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${envVar} is not set`));
	});

	it(`returns no-results envelope for ${provider}`, async () => {
		process.env[envVar] = "k";
		writeConfig({ provider });
		stubFetch([
			{
				match: urlMatcher,
				response: () => new Response(emptyResponse(), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it(`wraps non-2xx as '${provider} Search API error (status)'`, async () => {
		const label = provider.charAt(0).toUpperCase() + provider.slice(1);
		process.env[envVar] = "k";
		writeConfig({ provider });
		stubFetch([
			{
				match: urlMatcher,
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${label} Search API error \\(429\\)`));
	});
});

describe("web_search.execute — provider-independent behavior", () => {
	it("clamps max_results to [1,10]", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", max_results: 99 }, undefined as never, undefined as never, createMockCtx());
		const url = stub.calls[0].url;
		expect(new URL(url).searchParams.get("count")).toBe("10");
	});

	it("defaults to brave when no provider configured", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({
							web: { results: [{ title: "T", url: "https://x", description: "snip" }] },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { backend: string }).backend).toBe("brave");
		expect(stub.calls[0].url).toContain("api.search.brave.com");
	});

	it("uses legacy apiKey fallback for brave", async () => {
		writeConfig({ apiKey: "legacy-key" });
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({
							web: { results: [{ title: "T", url: "https://x", description: "snip" }] },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers["X-Subscription-Token"]).toBe("legacy-key");
	});
});

describe("web_fetch.execute — URL validation", () => {
	it("throws on invalid URL", async () => {
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "not a url" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Invalid URL/);
	});
	it("throws on non-http(s) protocol", async () => {
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "ftp://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Unsupported URL protocol/);
	});
});

describe("web_fetch.execute — happy path", () => {
	it("strips HTML and extracts title for text/html", async () => {
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () =>
					new Response("<html><head><title>My Page</title></head><body><p>Hello</p></body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("My Page") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Hello") });
	});

	it("throws on non-2xx with HTTP status in message", async () => {
		stubFetch([
			{
				match: () => true,
				response: () => new Response("nope", { status: 404, statusText: "Not Found" }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/HTTP 404/);
	});

	it("throws on binary content-type", async () => {
		stubFetch([
			{
				match: () => true,
				response: () => new Response("binary", { status: 200, headers: { "content-type": "image/png" } }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Unsupported content type/);
	});

	it("returns raw=true untouched", async () => {
		stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>raw</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://x.com", raw: true },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("<p>raw</p>") });
	});

	it("sends UA + Accept headers + redirect:follow", async () => {
		const stub = stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>x</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		const init = stub.calls[0].init;
		const headers = init?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toMatch(/rpiv-pi/);
		expect(headers.Accept).toContain("text/html");
		expect(init?.redirect).toBe("follow");
	});

	it("coerces content-length to numeric details.contentLength", async () => {
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("x".repeat(100), {
						status: 200,
						headers: { "content-type": "text/plain", "content-length": "100" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { contentLength: number }).contentLength).toBe(100);
	});

	it("falls back to defaults when config file is malformed JSON", async () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "not valid json {", "utf-8");
		stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.content[0] as { text: string }).text).toContain("hi");
	});

	it("decodes numeric HTML entities in text/html bodies", async () => {
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<p>&#65;&#66;&#67;</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.content[0] as { text: string }).text).toContain("ABC");
	});

	it("spills full body to temp file and appends truncation footer when truncated", async () => {
		const fullBody = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
		stubFetch([
			{
				match: () => true,
				response: () => new Response(fullBody, { status: 200, headers: { "content-type": "text/plain" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://big.com" }, undefined as never, undefined as never, createMockCtx());

		const text = (r?.content[0] as { text: string }).text;
		expect(text).toContain("Content truncated:");
		expect(text).toContain("Full content saved to:");

		const details = r?.details as {
			truncation?: { truncated: boolean; totalLines: number };
			fullOutputPath?: string;
		};
		expect(details.truncation?.truncated).toBe(true);
		expect(details.truncation?.totalLines).toBe(3000);
		expect(details.fullOutputPath).toBeDefined();
		const spilled = readFileSync(details.fullOutputPath!, "utf-8");
		expect(spilled).toBe(fullBody);
	});
});

describe("web_fetch.execute — provider fetch", () => {
	it("brave fetch strips HTML and extracts title", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () =>
					new Response("<html><head><title>My Page</title></head><body><p>Hello</p></body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("My Page") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Hello") });
	});

	it("brave fetch returns raw HTML when raw=true", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>raw</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://x.com", raw: true },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("<p>raw</p>") });
	});

	it("tavily fetch uses /extract endpoint", async () => {
		process.env.TAVILY_API_KEY = "k";
		writeConfig({ provider: "tavily" });
		stubFetch([
			{
				match: (u) => u.includes("api.tavily.com/extract"),
				response: () =>
					new Response(JSON.stringify({ results: [{ url: "https://x.com", raw_content: "extracted text" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted text") });
	});

	it("tavily fetch handles failed_results", async () => {
		process.env.TAVILY_API_KEY = "k";
		writeConfig({ provider: "tavily" });
		stubFetch([
			{
				match: (u) => u.includes("api.tavily.com/extract"),
				response: () =>
					new Response(
						JSON.stringify({
							results: [],
							failed_results: [{ url: "https://x.com", error: "timeout" }],
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/extraction failed/);
	});

	it("exa fetch uses /contents endpoint", async () => {
		process.env.EXA_API_KEY = "k";
		writeConfig({ provider: "exa" });
		stubFetch([
			{
				match: (u) => u.includes("api.exa.ai/contents"),
				response: () =>
					new Response(
						JSON.stringify({
							results: [{ title: "Page", url: "https://x.com", text: "extracted content" }],
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted content") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Page") });
	});

	it("exa fetch throws when no content returned", async () => {
		process.env.EXA_API_KEY = "k";
		writeConfig({ provider: "exa" });
		stubFetch([
			{
				match: (u) => u.includes("api.exa.ai/contents"),
				response: () => new Response(JSON.stringify({ results: [{ url: "https://x.com" }] }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/no content returned/);
	});

	it("jina fetch uses r.jina.ai reader", async () => {
		process.env.JINA_API_KEY = "k";
		writeConfig({ provider: "jina" });
		stubFetch([
			{
				match: (u) => u.includes("r.jina.ai"),
				response: () => new Response("extracted markdown content", { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted markdown content") });
	});

	it("firecrawl fetch uses /v1/scrape endpoint", async () => {
		process.env.FIRECRAWL_API_KEY = "k";
		writeConfig({ provider: "firecrawl" });
		stubFetch([
			{
				match: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
				response: () =>
					new Response(
						JSON.stringify({
							success: true,
							data: { markdown: "# Title\nPage content", metadata: { title: "Scraped Page" } },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Page content") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Scraped Page") });
	});

	it("firecrawl fetch handles success=false", async () => {
		process.env.FIRECRAWL_API_KEY = "k";
		writeConfig({ provider: "firecrawl" });
		stubFetch([
			{
				match: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
				response: () => new Response(JSON.stringify({ success: false }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/scrape failed/);
	});

	it("extraction providers (jina) ignore raw and never strip vendor body", async () => {
		// Contract: Jina/Firecrawl/Tavily/Exa always return what their extraction
		// API gave us. raw=true must NOT trigger the htmlToText pipeline that
		// Brave/Serper run. Stub a body containing literal HTML tags and assert
		// they survive in the output (i.e. no stripping happened).
		process.env.JINA_API_KEY = "k";
		writeConfig({ provider: "jina" });
		stubFetch([
			{
				match: (u) => u.includes("r.jina.ai"),
				response: () => new Response("# heading\n<p>vendor markdown</p>", { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://x.com", raw: true },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		// If raw=true had triggered htmlToText, the <p> tag would be gone.
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("<p>vendor markdown</p>") });
	});
});

describe("config round-trip with all providers", () => {
	it("preserves keys for all providers when switching", async () => {
		writeConfig({
			provider: "brave",
			apiKeys: {
				brave: "brave-key",
				tavily: "tavily-key",
				jina: "jina-key",
				firecrawl: "firecrawl-key",
			},
		});
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Firecrawl");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-firecrawl-key");
		await captured.commands.get("web-search-config")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("firecrawl");
		expect(saved.apiKeys.brave).toBe("brave-key");
		expect(saved.apiKeys.tavily).toBe("tavily-key");
		expect(saved.apiKeys.jina).toBe("jina-key");
		expect(saved.apiKeys.firecrawl).toBe("new-firecrawl-key");
	});
});

describe("/web-search-config command", () => {
	it("!hasUI notifies error", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("web-search-config")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("--show displays all providers with masked keys", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "sk-live-abcdefghijklmnop";
		writeConfig({ provider: "brave", apiKeys: { brave: "sk-cfg-abcdefghijklmnop" } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-search-config")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("sk-l...mnop");
		expect(msg).toContain("sk-c...mnop");
		expect(msg).toContain("active provider: brave");
	});

	it("--show shows '(not set)' when nothing configured", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-search-config")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("(not set)");
	});

	it("two-step: select provider then enter key", async () => {
		writeConfig({ apiKey: "old", otherField: "keep" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Tavily");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("  tavily-key  ");
		await captured.commands.get("web-search-config")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved).toEqual({
			provider: "tavily",
			apiKeys: { tavily: "tavily-key" },
			otherField: "keep",
		});
		expect(saved.apiKey).toBeUndefined();
	});

	it("select cancelled leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-search-config")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
	});

	it("input cancelled after select leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Serper");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-search-config")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
	});

	it("empty input after select leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Exa");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("   ");
		await captured.commands.get("web-search-config")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
	});

	it("migrates legacy apiKey to apiKeys on save", async () => {
		writeConfig({ apiKey: "legacy-key", otherField: "keep" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Brave");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-key");
		await captured.commands.get("web-search-config")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("brave");
		expect(saved.apiKeys).toEqual({ brave: "new-key" });
		expect(saved.apiKey).toBeUndefined();
		expect(saved.otherField).toBe("keep");
	});
});
