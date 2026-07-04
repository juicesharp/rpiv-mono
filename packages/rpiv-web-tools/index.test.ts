import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { createMockCtx, createMockPi, stubFetch } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, type vi } from "vitest";
import registerWebTools from "./index.js";
import {
	clearCloneCache,
	configureSearxng,
	SEARXNG_DEFAULT_URL,
	SEARXNG_PROVIDER_META,
	SearxngProvider,
} from "./providers/index.js";

const CONFIG_PATH = configPath("rpiv-web-tools");

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
	clearCloneCache();
	delete process.env.BRAVE_SEARCH_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.SERPER_API_KEY;
	delete process.env.EXA_API_KEY;
	delete process.env.YOUCOM_API_KEY;
	delete process.env.JINA_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
	delete process.env.PERPLEXITY_API_KEY;
	delete process.env.SEARXNG_API_KEY;
	delete process.env.SEARXNG_URL;
	delete process.env.OLLAMA_API_KEY;
	delete process.env.OLLAMA_HOST;
	delete process.env.GITHUB_TOKEN;
	delete process.env.WEB_SEARCH_PROVIDER;
	rmSync(CONFIG_PATH, { force: true });
});

describe("registerWebTools — registration", () => {
	it("registers web_search + web_fetch tools", () => {
		const { captured } = registerAndCapture();
		expect(captured.tools.has("web_search")).toBe(true);
		expect(captured.tools.has("web_fetch")).toBe(true);
	});

	it("registers /web-tools command", () => {
		const { captured } = registerAndCapture();
		expect(captured.commands.has("web-tools")).toBe(true);
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
				data: [{ title: "T", url: "https://x", description: "snip" }],
			}),
		emptyResponse: () => JSON.stringify({ code: 200, status: 20000, data: [] }),
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
	{
		provider: "perplexity",
		envVar: "PERPLEXITY_API_KEY",
		urlMatcher: (u: string) => u.includes("api.perplexity.ai"),
		buildResponse: () => JSON.stringify({ results: [{ title: "T", url: "https://x", snippet: "snip" }] }),
		emptyResponse: () => JSON.stringify({ results: [] }),
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
			if (provider === "jina" || provider === "firecrawl" || provider === "perplexity") {
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
			if (provider === "jina" || provider === "firecrawl" || provider === "perplexity") {
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

	it("treats empty-string env key as unset", async () => {
		process.env.EXA_API_KEY = "";
		writeConfig({ provider: "exa", apiKeys: { exa: "" } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/EXA_API_KEY is not set/);
	});

	it("treats empty-string legacy brave apiKey as unset", async () => {
		writeConfig({ provider: "brave", apiKey: "   " });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/BRAVE_SEARCH_API_KEY is not set/);
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

	it.each([
		"http://localhost/",
		"http://127.0.0.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://172.16.0.1/",
		"http://[::1]/",
	])("refuses private/loopback host %s", async (url) => {
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/private\/loopback/);
	});

	// The previous it.each runs against the default provider (brave). SearXNG is
	// structurally interesting because its baseUrl is allowed to point at
	// loopback (self-hosted) — that exemption must NOT leak to web_fetch, which
	// retrieves arbitrary URLs returned by search. The guard sits in
	// parseAndAssertHttpUrl *before* the provider is consulted, so it should
	// still fire when the active provider is searxng.
	it("refuses private/loopback host when active provider is searxng", async () => {
		writeConfig({ provider: "searxng", baseUrls: { searxng: "http://localhost:8080" } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "http://127.0.0.1/secret" },
					undefined as never,
					undefined as never,
					createMockCtx(),
				),
		).rejects.toThrow(/private\/loopback/);
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

// Extraction providers — those with native fetch endpoints. Each entry drives
// the per-provider error-path assertions below: no-key throw + labeled non-2xx.
// Search-only providers (Brave/Serper/SearXNG) no longer have their own fetch()
// after the role split; their fallback path is asserted once in the
// "search-only providers fall back to generic HTML fetch" block.
const FETCH_ERROR_MATRIX: ReadonlyArray<{
	provider: string;
	envVar: string;
	fetchUrlMatcher: (u: string) => boolean;
	label: string;
}> = [
	{
		provider: "tavily",
		envVar: "TAVILY_API_KEY",
		fetchUrlMatcher: (u) => u.includes("api.tavily.com/extract"),
		label: "Tavily",
	},
	{ provider: "exa", envVar: "EXA_API_KEY", fetchUrlMatcher: (u) => u.includes("api.exa.ai/contents"), label: "Exa" },
	{ provider: "jina", envVar: "JINA_API_KEY", fetchUrlMatcher: (u) => u.includes("r.jina.ai"), label: "Jina" },
	{
		provider: "firecrawl",
		envVar: "FIRECRAWL_API_KEY",
		fetchUrlMatcher: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
		label: "Firecrawl",
	},
	{
		provider: "youcom",
		envVar: "YOUCOM_API_KEY",
		fetchUrlMatcher: (u) => u.includes("ydc-index.io/v1/contents"),
		label: "You.com",
	},
];

describe.each(FETCH_ERROR_MATRIX)("web_fetch.execute — $provider error paths", ({
	provider,
	envVar,
	fetchUrlMatcher,
	label,
}) => {
	it(`fetch throws when no key configured for ${provider}`, async () => {
		writeConfig({ provider });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${envVar} is not set`));
	});

	it(`fetch wraps non-2xx as '${label} Fetch API error (429)'`, async () => {
		process.env[envVar] = "k";
		writeConfig({ provider });
		stubFetch([
			{
				match: fetchUrlMatcher,
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${label} Fetch API error \\(429\\)`));
	});
});

// Brave/Serper/SearXNG are SearchProvider-only after the role split: the
// orchestrator falls through to `fetchViaGenericHtml`. The dispatch is
// provider-agnostic — one assertion per behavior is enough.
describe.each([
	{ provider: "brave", envVar: "BRAVE_SEARCH_API_KEY" },
	{ provider: "serper", envVar: "SERPER_API_KEY" },
	{ provider: "searxng", envVar: "SEARXNG_API_KEY" },
	{ provider: "perplexity", envVar: "PERPLEXITY_API_KEY" },
])("web_fetch.execute — $provider falls back to generic HTML", ({ provider, envVar }) => {
	it("does not throw on missing key (raw HTTP doesn't authenticate to the target)", async () => {
		writeConfig({ provider });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () => new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("ok") });
	});

	it("wraps non-2xx as generic HTTP error from fetchViaGenericHtml", async () => {
		process.env[envVar] = "k";
		writeConfig({ provider });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/HTTP 429/);
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

	it("jina fetch throws when response body is empty", async () => {
		process.env.JINA_API_KEY = "k";
		writeConfig({ provider: "jina" });
		stubFetch([
			{
				match: (u) => u.includes("r.jina.ai"),
				response: () => new Response("", { status: 200 }),
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

	it("firecrawl fetch throws on success=true with empty markdown", async () => {
		process.env.FIRECRAWL_API_KEY = "k";
		writeConfig({ provider: "firecrawl" });
		stubFetch([
			{
				match: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
				response: () =>
					new Response(JSON.stringify({ success: true, data: { metadata: { title: "T" } } }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/no content returned/);
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

	// Branch coverage for Brave/Serper fetch(): the ?? "" content-type fallback,
	// the "" -> undefined contentType collapse, and the undefined contentLength
	// path when the response omits the header.
	describe.each([
		{ provider: "brave", envVar: "BRAVE_SEARCH_API_KEY" },
		{ provider: "serper", envVar: "SERPER_API_KEY" },
	])("$provider fetch — header fallbacks", ({ provider, envVar }) => {
		it("returns undefined contentType/contentLength when headers are absent", async () => {
			process.env[envVar] = "k";
			writeConfig({ provider });
			stubFetch([
				{
					match: (u) => u.includes("example.com"),
					// Blob with empty type stops Response from auto-deriving a content-type,
					// so res.headers.get("content-type") returns null. content-length is
					// likewise omitted unless we set it.
					response: () => new Response(new Blob(["plain body"], { type: "" }), { status: 200 }),
				},
			]);
			const { captured } = registerAndCapture();
			const r = await captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "https://example.com", raw: true },
					undefined as never,
					undefined as never,
					createMockCtx(),
				);
			// toMatchObject treats `undefined` as "key absent or undefined", so use
			// hasOwnProperty + direct equality to assert both.
			const details = r?.details as Record<string, unknown> | undefined;
			expect(details?.contentType).toBeUndefined();
			expect(details?.contentLength).toBeUndefined();
		});

		it("parses Number(contentLength) when the header is present", async () => {
			process.env[envVar] = "k";
			writeConfig({ provider });
			stubFetch([
				{
					match: (u) => u.includes("example.com"),
					response: () =>
						new Response("plain body", {
							status: 200,
							headers: { "content-type": "text/plain", "content-length": "10" },
						}),
				},
			]);
			const { captured } = registerAndCapture();
			const r = await captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "https://example.com", raw: true },
					undefined as never,
					undefined as never,
					createMockCtx(),
				);
			expect(r?.details).toMatchObject({ contentType: "text/plain", contentLength: 10 });
		});
	});

	// Branch coverage for normalizeBraveResults: each result field is null-coalesced
	// to "" so a partial vendor row (missing title/url/description) must not throw
	// and must round-trip as empty strings.
	it("brave search tolerates missing fields in organic results", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () => new Response(JSON.stringify({ web: { results: [{}] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		// Empty fields land as empty strings, not crashes.
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
	});

	// Branch coverage for normalizeSerperResults: same shape as Brave above.
	it("serper search tolerates missing fields in organic results", async () => {
		process.env.SERPER_API_KEY = "k";
		writeConfig({ provider: "serper" });
		stubFetch([
			{
				match: (u) => u.includes("google.serper.dev"),
				response: () => new Response(JSON.stringify({ organic: [{}] }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
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
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("firecrawl");
		expect(saved.apiKeys.brave).toBe("brave-key");
		expect(saved.apiKeys.tavily).toBe("tavily-key");
		expect(saved.apiKeys.jina).toBe("jina-key");
		expect(saved.apiKeys.firecrawl).toBe("new-firecrawl-key");
	});
});

describe("/web-tools command", () => {
	it("!hasUI notifies error", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("--show displays all providers with masked keys", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "sk-live-abcdefghijklmnop";
		writeConfig({ provider: "brave", apiKeys: { brave: "sk-cfg-abcdefghijklmnop" } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("sk-l...mnop");
		expect(msg).toContain("sk-c...mnop");
		expect(msg).toContain("active provider: brave");
	});

	it("--show shows '(not set)' when nothing configured", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("(not set)");
	});

	it("two-step: select provider then enter key", async () => {
		writeConfig({ apiKey: "old", otherField: "keep" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Tavily");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("  tavily-key  ");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
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
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
	});

	it("input cancelled after select leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Serper");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
	});

	it("empty input after select leaves config untouched when no existing key", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		// Selecting Exa: no apiKeys.exa, no env var, legacy apiKey only applies to brave.
		// existingKey for Exa = undefined, so empty input falls through to cancel.
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Exa");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("   ");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
		expect(saved.provider).toBeUndefined();
	});

	it("empty input keeps existing key and persists provider switch", async () => {
		writeConfig({ provider: "brave", apiKeys: { brave: "brave-key", exa: "exa-key" } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Exa");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("exa");
		expect(saved.apiKeys.exa).toBe("exa-key");
		expect(saved.apiKeys.brave).toBe("brave-key");
	});

	it("migrates legacy apiKey to apiKeys on save", async () => {
		writeConfig({ apiKey: "legacy-key", otherField: "keep" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Brave");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("brave");
		expect(saved.apiKeys).toEqual({ brave: "new-key" });
		expect(saved.apiKey).toBeUndefined();
		expect(saved.otherField).toBe("keep");
	});

	it("lists active provider first with a ✓ marker", async () => {
		writeConfig({ provider: "exa", apiKeys: { exa: "exa-key" } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Exa ✓ (configured)");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-exa-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);

		const selectCall = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
		const labels = selectCall[1] as string[];
		expect(labels[0]).toBe("Exa ✓ (configured)");
		expect(labels.slice(1)).toEqual([
			"Brave",
			"Tavily",
			"Serper",
			"You.com",
			"Jina",
			"Firecrawl",
			"Perplexity",
			"SearXNG",
			"Ollama",
		]);
		expect(labels.filter((l) => l.includes("✓"))).toHaveLength(1);

		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("exa");
		expect(saved.apiKeys.exa).toBe("new-exa-key");
	});

	it("marks every provider with a saved key as (configured)", async () => {
		writeConfig({
			provider: "exa",
			apiKeys: { exa: "exa-key", brave: "brave-key", tavily: "tavily-key" },
		});
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(labels[0]).toBe("Exa ✓ (configured)");
		expect(labels).toContain("Brave (configured)");
		expect(labels).toContain("Tavily (configured)");
		expect(labels).toContain("Serper");
		expect(labels).toContain("Jina");
		expect(labels).toContain("Firecrawl");
	});

	it("marks provider as (configured) when key is in env var", async () => {
		process.env.JINA_API_KEY = "env-jina-key";
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(labels).toContain("Jina (configured)");
	});

	it("defaults to brave-first when no provider is configured", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(labels[0]).toBe("Brave ✓");
	});

	it("notifies error and skips 'Saved …' when the underlying write fails", async () => {
		// Force saveJsonConfig to fail by placing a directory at CONFIG_PATH so
		// writeFileSync throws EISDIR. This drives the same control flow that disk
		// full / EACCES / EROFS would in production.
		if (process.platform === "win32") return;
		mkdirSync(CONFIG_PATH, { recursive: true });
		try {
			const { captured } = registerAndCapture();
			const ctx = createMockCtx({ hasUI: true });
			(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Brave");
			(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-key");
			await captured.commands.get("web-tools")?.handler("", ctx as never);

			const notifyMock = ctx.ui.notify as ReturnType<typeof vi.fn>;
			const calls = notifyMock.mock.calls;
			expect(calls.some(([msg, level]) => /Failed to save/.test(String(msg)) && level === "error")).toBe(true);
			expect(calls.some(([msg]) => /^Saved /.test(String(msg)))).toBe(false);
		} finally {
			rmSync(CONFIG_PATH, { recursive: true, force: true });
		}
	});
});

// SearXNG is structurally unlike the six hosted providers: it is self-hosted
// (needs a base URL), API key is optional (only for proxy-fronted instances),
// and the JSON API exposes no `count` parameter. Kept out of PROVIDER_MATRIX
// because the "throws when no key" assumption doesn't hold.
describe("web_search.execute — searxng", () => {
	const SEARXNG_OK_BODY = JSON.stringify({
		results: [
			{ title: "T1", url: "https://result.example/1", content: "snippet 1" },
			{ title: "T2", url: "https://result.example/2", content: "snippet 2" },
		],
	});

	it("uses env URL (wins over config and default)", async () => {
		process.env.SEARXNG_URL = "http://env-host:9000";
		writeConfig({ provider: "searxng", baseUrls: { searxng: "http://config-host:7000" } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://env-host:9000/"),
				response: () => new Response(SEARXNG_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello" }, undefined as never, undefined as never, createMockCtx());
		const url = new URL(stub.calls[0].url);
		expect(`${url.protocol}//${url.host}`).toBe("http://env-host:9000");
		expect(url.pathname).toBe("/search");
		expect(url.searchParams.get("q")).toBe("hello");
		expect(url.searchParams.get("format")).toBe("json");
		expect(url.searchParams.get("safesearch")).toBe("0");
		expect(url.searchParams.has("count")).toBe(false);
	});

	it("falls back to config URL when env is unset", async () => {
		writeConfig({ provider: "searxng", baseUrls: { searxng: "http://config-host:7000" } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://config-host:7000/"),
				response: () => new Response(SEARXNG_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("config-host:7000");
	});

	it("falls back to default URL (http://localhost:8080) when neither env nor config is set", async () => {
		writeConfig({ provider: "searxng" });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://localhost:8080/"),
				response: () => new Response(SEARXNG_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("localhost:8080");
	});

	it("trailing slash on baseUrl does not produce a double-slash", async () => {
		process.env.SEARXNG_URL = "http://host:8080/";
		writeConfig({ provider: "searxng" });
		const stub = stubFetch([
			{ match: (u) => u.includes("host:8080"), response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(stub.calls[0].url).not.toMatch(/\/\/search/);
		expect(new URL(stub.calls[0].url).pathname).toBe("/search");
	});

	it("multiple trailing slashes on baseUrl are all stripped", async () => {
		process.env.SEARXNG_URL = "http://host:8080///";
		writeConfig({ provider: "searxng" });
		const stub = stubFetch([
			{ match: (u) => u.includes("host:8080"), response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(stub.calls[0].url).not.toMatch(/\/\/search/);
		expect(new URL(stub.calls[0].url).pathname).toBe("/search");
	});

	it("sends Bearer Authorization only when an API key is configured", async () => {
		process.env.SEARXNG_API_KEY = "env-bearer";
		writeConfig({ provider: "searxng" });
		const stub = stubFetch([{ match: () => true, response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer env-bearer");
	});

	it("omits Authorization when no API key is configured", async () => {
		writeConfig({ provider: "searxng" });
		const stub = stubFetch([{ match: () => true, response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("falls back to config apiKeys.searxng when env is unset", async () => {
		writeConfig({ provider: "searxng", apiKeys: { searxng: "config-bearer" } });
		const stub = stubFetch([{ match: () => true, response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer config-bearer");
	});

	it("slices results to max_results", async () => {
		writeConfig({ provider: "searxng" });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response(
						JSON.stringify({
							results: Array.from({ length: 8 }, (_, i) => ({
								title: `T${i}`,
								url: `https://r/${i}`,
								content: `snip ${i}`,
							})),
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", max_results: 3 }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { results: Array<{ title: string; url: string; snippet: string }> }).results).toHaveLength(
			3,
		);
	});

	it("returns no-results envelope on empty results array", async () => {
		writeConfig({ provider: "searxng" });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it("wraps non-2xx as 'SearXNG Search API error (status)'", async () => {
		writeConfig({ provider: "searxng" });
		stubFetch([{ match: () => true, response: () => new Response("oops", { status: 500 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/SearXNG Search API error \(500\)/);
	});

	it("403 attaches the 'JSON output may be disabled' hint", async () => {
		writeConfig({ provider: "searxng" });
		stubFetch([{ match: () => true, response: () => new Response("forbidden", { status: 403 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/JSON output disabled/);
	});

	it("401 attaches the 'reverse-proxy rejected the Bearer token' hint", async () => {
		writeConfig({ provider: "searxng", apiKeys: { searxng: "bad-bearer" } });
		stubFetch([{ match: () => true, response: () => new Response("unauthorized", { status: 401 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/rejected the Bearer token.*SEARXNG_API_KEY/);
	});

	it("normalizes missing fields on result rows to empty strings", async () => {
		writeConfig({ provider: "searxng" });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
	});
});

describe("/web-tools command — searxng", () => {
	it("prompts URL first, then optional key, and persists both", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG");
		const inputMock = ctx.ui.input as ReturnType<typeof vi.fn>;
		inputMock.mockResolvedValueOnce("http://my-searx:8080").mockResolvedValueOnce("my-bearer");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved).toMatchObject({
			provider: "searxng",
			baseUrls: { searxng: "http://my-searx:8080" },
			apiKeys: { searxng: "my-bearer" },
		});
		// Two input prompts: URL first, then API key
		expect(inputMock.mock.calls).toHaveLength(2);
		expect(String(inputMock.mock.calls[0][0])).toMatch(/URL/i);
		expect(String(inputMock.mock.calls[1][0])).toMatch(/key/i);
	});

	it("empty URL input falls back to the default URL and leaves key unset", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("searxng");
		expect(saved.baseUrls.searxng).toBe("http://localhost:8080");
		expect(saved.apiKeys?.searxng).toBeUndefined();
	});

	it("URL cancel (undefined) leaves config untouched", async () => {
		writeConfig({ provider: "brave", apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("brave");
		expect(saved.apiKey).toBe("existing");
	});

	it("keeps existing URL and key when both inputs are empty", async () => {
		writeConfig({
			provider: "searxng",
			baseUrls: { searxng: "http://existing:8080" },
			apiKeys: { searxng: "existing-key" },
		});
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG ✓ (configured)");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.baseUrls.searxng).toBe("http://existing:8080");
		expect(saved.apiKeys.searxng).toBe("existing-key");
	});

	it("marks searxng (configured) when SEARXNG_URL env is set, but not when only the default applies", async () => {
		// Default URL alone is not "configured" — keep the (configured) marker
		// meaningful so it tells the user they've intentionally set something.
		{
			const { captured } = registerAndCapture();
			const ctx = createMockCtx({ hasUI: true });
			(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
			await captured.commands.get("web-tools")?.handler("", ctx as never);
			const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
			expect(labels).toContain("SearXNG");
			expect(labels).not.toContain("SearXNG (configured)");
		}
		process.env.SEARXNG_URL = "http://my-searx:8080";
		{
			const { captured } = registerAndCapture();
			const ctx = createMockCtx({ hasUI: true });
			(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
			await captured.commands.get("web-tools")?.handler("", ctx as never);
			const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
			expect(labels).toContain("SearXNG (configured)");
		}
	});

	it("--show surfaces the resolved searxng URL and its source (env)", async () => {
		process.env.SEARXNG_URL = "http://my-searx:8080";
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("searxng url: http://my-searx:8080");
		expect(msg).toContain("source: env");
	});

	it("--show surfaces the resolved searxng URL and its source (config)", async () => {
		writeConfig({ baseUrls: { searxng: "http://config-host:7000" } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("searxng url: http://config-host:7000");
		expect(msg).toContain("source: config");
	});

	it("--show surfaces the resolved searxng URL and its source (default)", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain(`searxng url: ${SEARXNG_DEFAULT_URL}`);
		expect(msg).toContain("source: default");
	});
});

describe("SEARXNG_PROVIDER_META", () => {
	// The meta drives downstream introspection (which env var activates a
	// provider, which surfaces in `--show`, etc.). `envVar` and `baseUrlEnvVar`
	// are distinct concepts and the fix that introduced `baseUrlEnvVar` is
	// only meaningful if both fields are set correctly.
	it("declares envVar as SEARXNG_API_KEY (optional Bearer key)", () => {
		expect(SEARXNG_PROVIDER_META.envVar).toBe("SEARXNG_API_KEY");
	});

	it("declares baseUrlEnvVar as SEARXNG_URL (the URL that actually activates it)", () => {
		expect(SEARXNG_PROVIDER_META.baseUrlEnvVar).toBe("SEARXNG_URL");
	});
});

describe("SearxngProvider constructor", () => {
	// A user-supplied SEARXNG_URL must not be allowed to silently become a
	// non-http(s) scheme. `new URL()` accepts file://, javascript:, data:, etc.,
	// so we reject anything outside http/https up front instead of letting it
	// reach the fetch path.
	it("accepts http baseUrl", () => {
		expect(() => new SearxngProvider({ baseUrl: "http://localhost:8080" })).not.toThrow();
	});

	it("accepts https baseUrl", () => {
		expect(() => new SearxngProvider({ baseUrl: "https://searx.example/" })).not.toThrow();
	});

	it("accepts an empty baseUrl (deferred-config state — search() then throws)", () => {
		expect(() => new SearxngProvider({ baseUrl: "" })).not.toThrow();
	});

	it("rejects file:// scheme", () => {
		expect(() => new SearxngProvider({ baseUrl: "file:///etc/passwd" })).toThrow(/must use http/);
	});

	it("rejects javascript: scheme", () => {
		expect(() => new SearxngProvider({ baseUrl: "javascript:alert(1)" })).toThrow(/must use http/);
	});

	it("rejects an unparseable URL", () => {
		expect(() => new SearxngProvider({ baseUrl: "not a url" })).toThrow(/is not a valid URL/);
	});
});

// The integrated paths (web_search.execute, /web-tools) always supply
// a baseUrl via resolveSearxngBaseUrl, which falls back to SEARXNG_DEFAULT_URL.
// The "is not set" error path inside SearxngProvider.search() is therefore
// only reachable for direct programmatic consumers — the class is exported,
// so it's still part of the public surface. Pin it directly.
describe("SearxngProvider.search() — direct unit tests", () => {
	it("throws 'SEARXNG_URL is not set' when constructed with an empty baseUrl", async () => {
		const provider = new SearxngProvider({ baseUrl: "" });
		await expect(provider.search("q", 5)).rejects.toThrow(/SEARXNG_URL is not set/);
	});
});

// Direct unit tests for the extracted helper — covers the prompt/keep/default
// logic that the /web-tools integration tests above also exercise via
// the caller, but at finer resolution and without needing the full registration.
describe("configureSearxng", () => {
	function makeUi(inputs: Array<string | null | undefined>) {
		const calls: Array<{ label: string; placeholder: string }> = [];
		const ui = {
			async input(label: string, placeholder: string) {
				calls.push({ label, placeholder });
				return inputs.shift();
			},
		};
		return { ui, calls };
	}

	it("returns null when the user cancels at the URL prompt", async () => {
		const { ui } = makeUi([undefined]);
		expect(await configureSearxng(ui, {})).toBeNull();
	});

	it("returns null when the user cancels at the API-key prompt", async () => {
		const { ui } = makeUi(["http://h:8080", undefined]);
		expect(await configureSearxng(ui, {})).toBeNull();
	});

	it("uses SEARXNG_DEFAULT_URL and null apiKey when both inputs are empty and no current values exist", async () => {
		const { ui } = makeUi(["", ""]);
		expect(await configureSearxng(ui, {})).toEqual({ baseUrl: SEARXNG_DEFAULT_URL, apiKey: null });
	});

	it("keeps current values when both inputs are empty", async () => {
		const { ui } = makeUi(["", ""]);
		expect(await configureSearxng(ui, { baseUrl: "http://kept:8080", apiKey: "kept-key" })).toEqual({
			baseUrl: "http://kept:8080",
			apiKey: "kept-key",
		});
	});

	it("uses fresh values when both inputs are non-empty", async () => {
		const { ui } = makeUi(["  http://new:8080  ", "  new-key  "]);
		expect(await configureSearxng(ui, { baseUrl: "http://kept:8080", apiKey: "kept-key" })).toEqual({
			baseUrl: "http://new:8080",
			apiKey: "new-key",
		});
	});

	it("prompts URL first, then key, with placeholders that reflect current values", async () => {
		const { ui, calls } = makeUi(["", ""]);
		await configureSearxng(ui, { baseUrl: "http://existing:8080", apiKey: "existing-key" });
		expect(calls).toHaveLength(2);
		expect(calls[0].label).toMatch(/URL/i);
		expect(calls[0].placeholder).toContain("http://existing:8080");
		expect(calls[1].label).toMatch(/key/i);
		// Mask hides the middle but reveals the first/last 4 chars
		expect(calls[1].placeholder).toContain("exis...-key");
	});
});

// ---------------------------------------------------------------------------
// Ollama provider-specific tests
// ---------------------------------------------------------------------------
// Ollama is structurally similar to SearXNG: self-hosted with configurable
// baseUrl, optional API key, and vendor fetch endpoint. Kept out of
// PROVIDER_MATRIX because the optional key breaks the generic "no key" test.

describe("web_search.execute — ollama", () => {
	const OLLAMA_OK_BODY = JSON.stringify({
		results: [
			{ title: "T1", url: "https://result.example/1", content: "snippet 1" },
			{ title: "T2", url: "https://result.example/2", content: "snippet 2" },
		],
	});

	it("uses env URL (wins over config and default)", async () => {
		process.env.OLLAMA_HOST = "http://env-host:9000";
		writeConfig({ provider: "ollama", baseUrls: { ollama: "http://config-host:7000" } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://env-host:9000/"),
				response: () => new Response(OLLAMA_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello" }, undefined as never, undefined as never, createMockCtx());
		const callUrl = new URL(stub.calls[0].url);
		expect(`${callUrl.protocol}//${callUrl.host}`).toBe("http://env-host:9000");
		expect(callUrl.pathname).toBe("/api/web_search");
		const body = JSON.parse(stub.calls[0].init?.body as string);
		expect(body.query).toBe("hello");
		expect(body.max_results).toBeDefined();
	});

	it("falls back to config URL when env is unset", async () => {
		writeConfig({ provider: "ollama", baseUrls: { ollama: "http://config-host:7000" } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://config-host:7000/"),
				response: () => new Response(OLLAMA_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("config-host:7000");
	});

	it("falls back to default URL (http://localhost:11434) when neither env nor config is set", async () => {
		writeConfig({ provider: "ollama" });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://localhost:11434/"),
				response: () => new Response(OLLAMA_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("localhost:11434");
	});

	it("trailing slash on baseUrl does not produce a double-slash", async () => {
		process.env.OLLAMA_HOST = "http://host:11434/";
		writeConfig({ provider: "ollama" });
		const stub = stubFetch([
			{ match: (u) => u.includes("host:11434"), response: () => new Response(OLLAMA_OK_BODY, { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(stub.calls[0].url).not.toMatch(/\/\/api/);
	});

	it("sends Bearer Authorization when API key is configured", async () => {
		process.env.OLLAMA_API_KEY = "test-key";
		writeConfig({ provider: "ollama" });
		const stub = stubFetch([{ match: () => true, response: () => new Response(OLLAMA_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-key");
	});

	it("omits Authorization when no API key is configured", async () => {
		writeConfig({ provider: "ollama" });
		const stub = stubFetch([{ match: () => true, response: () => new Response(OLLAMA_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("returns no-results envelope on empty results array", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it("wraps non-2xx as 'Ollama Search API error (status)'", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([{ match: () => true, response: () => new Response("oops", { status: 500 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Ollama Search API error \(500\)/);
	});

	it("401 attaches the 'ollama signin' hint", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([{ match: () => true, response: () => new Response("unauthorized", { status: 401 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/ollama signin/);
	});

	it("404 attaches the 'may not support web search' hint", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([{ match: () => true, response: () => new Response("not found", { status: 404 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/may not support web search/);
	});

	it("normalizes missing fields on result rows to empty strings", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const result = (r?.details as { results: Array<{ title: string; url: string; snippet: string }> }).results[0];
		expect(result.title).toBe("");
		expect(result.url).toBe("");
		expect(result.snippet).toBe("");
	});
});

describe("web_fetch.execute — ollama vendor fetch", () => {
	it("ollama fetch uses /api/experimental/web_fetch endpoint", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([
			{
				match: (u) => u.includes("/api/experimental/web_fetch"),
				response: () =>
					new Response(
						JSON.stringify({ title: "Test Page", content: "extracted text", links: ["https://example.com"] }),
						{
							status: 200,
						},
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted text") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Test Page") });
	});

	it("ollama fetch throws when content is empty", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([
			{
				match: (u) => u.includes("/api/experimental/web_fetch"),
				response: () => new Response(JSON.stringify({ title: "Empty", content: "", links: [] }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/no content returned/);
	});

	it("ollama fetch wraps non-2xx as 'Ollama Fetch API error (status)'", async () => {
		writeConfig({ provider: "ollama" });
		stubFetch([
			{
				match: (u) => u.includes("/api/experimental/web_fetch"),
				response: () => new Response("bad", { status: 502 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Ollama Fetch API error \(502\)/);
	});
});

describe("web_search.execute — ollama network errors", () => {
	it("surfaces connection-refused with actionable hint", async () => {
		writeConfig({ provider: "ollama" });
		const connRefusedError = new TypeError("fetch failed");
		(connRefusedError as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
		stubFetch([
			{
				match: () => true,
				response: () => {
					throw connRefusedError;
				},
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Could not connect to Ollama.*Make sure Ollama is running/);
	});
});

describe("/web-tools command — ollama", () => {
	it("prompts URL first, then optional key, and persists both", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama");
		const inputMock = ctx.ui.input as ReturnType<typeof vi.fn>;
		inputMock.mockResolvedValueOnce("http://my-ollama:11434").mockResolvedValueOnce("my-api-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved).toMatchObject({
			provider: "ollama",
			baseUrls: { ollama: "http://my-ollama:11434" },
			apiKeys: { ollama: "my-api-key" },
		});
		expect(inputMock.mock.calls).toHaveLength(2);
		expect(String(inputMock.mock.calls[0][0])).toMatch(/URL/i);
		expect(String(inputMock.mock.calls[1][0])).toMatch(/key/i);
	});

	it("empty URL input falls back to the default URL and leaves key unset", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("ollama");
		expect(saved.baseUrls.ollama).toBe("http://localhost:11434");
		expect(saved.apiKeys?.ollama).toBeUndefined();
	});

	it("URL cancel (undefined) leaves config untouched", async () => {
		writeConfig({ provider: "brave", apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("brave");
		expect(saved.apiKey).toBe("existing");
	});

	it("keeps existing URL and key when both inputs are empty", async () => {
		writeConfig({
			provider: "ollama",
			baseUrls: { ollama: "http://existing:11434" },
			apiKeys: { ollama: "existing-key" },
		});
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama ✓ (configured)");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.baseUrls.ollama).toBe("http://existing:11434");
		expect(saved.apiKeys.ollama).toBe("existing-key");
	});
});

// You.com has a dedicated test block (like SearXNG/Ollama) for fine-grained assertions.
describe("web_search.execute — youcom", () => {
	it("uses env key", async () => {
		process.env.YOUCOM_API_KEY = "env-key";
		writeConfig({ provider: "youcom" });
		const stub = stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () =>
					new Response(
						JSON.stringify({
							results: { web: [{ title: "T", url: "https://x", description: "snip", snippets: ["snip"] }] },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello", max_results: 3 }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBe("env-key");
	});

	it("falls back to config key", async () => {
		writeConfig({ provider: "youcom", apiKeys: { youcom: "config-key" } });
		const stub = stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () =>
					new Response(
						JSON.stringify({
							results: { web: [{ title: "T", url: "https://x", description: "snip", snippets: ["snip"] }] },
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
		expect(headers["X-API-Key"]).toBe("config-key");
	});

	it("throws when no key configured", async () => {
		writeConfig({ provider: "youcom" });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/YOUCOM_API_KEY is not set/);
	});

	it("returns no-results envelope on empty results", async () => {
		process.env.YOUCOM_API_KEY = "k";
		writeConfig({ provider: "youcom" });
		stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () => new Response(JSON.stringify({ results: {} }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it("wraps non-2xx as 'You.com Search API error (status)'", async () => {
		process.env.YOUCOM_API_KEY = "k";
		writeConfig({ provider: "youcom" });
		stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/You\.com Search API error \(429\)/);
	});

	it("tolerates missing fields in results", async () => {
		process.env.YOUCOM_API_KEY = "k";
		writeConfig({ provider: "youcom" });
		stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () => new Response(JSON.stringify({ results: { web: [{}] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
	});
});

describe("web_fetch.execute — github intercept", () => {
	it("default OFF: github.com URLs go straight to active provider (no interceptor registered)", async () => {
		// No consumer opt-in, no user config — chain is empty. github.com URL
		// is fetched by the active provider just like any other URL.
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>plain github page</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi); // no opts → interceptor stays off
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/blob/main/file.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("plain github page") });
	});

	it("user config wins: { interceptors: { github: false } } overrides consumer opt-in", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave", interceptors: { github: false } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>plain github page</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi, { interceptors: { github: true } });
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/blob/main/file.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("plain github page") });
	});

	it("falls back to provider.fetch when parseGitHubUrl returns null (non-code github URL)", async () => {
		// Even with the interceptor enabled, github.com/owner/repo/issues lands
		// in NON_CODE_SEGMENTS, so intercept() returns null and the chain falls
		// through to the active provider's fetch.
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave", interceptors: { github: true } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>GitHub Issues page</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ type: "text" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("GitHub Issues page") });
	});

	it("does not intercept non-GitHub URLs — active provider handles them", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave", interceptors: { github: true } });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () =>
					new Response("<html><body>Not GitHub</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ type: "text" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Not GitHub") });
	});

	it("SSRF guard fires before github.com hostname check — refuses private/loopback addresses", async () => {
		// Confirms parseAndAssertHttpUrl() runs first; private IPs cannot sneak
		// through by having a github.com-shaped path segment.
		writeConfig({ interceptors: { github: true } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "http://192.168.1.1/owner/repo/blob/main/file.ts" },
					undefined as never,
					undefined as never,
					createMockCtx(),
				),
		).rejects.toThrow(/private|loopback/i);
	});
});

describe("formatShowConfigMessage — URL interceptors block", () => {
	it("--show lists 'github: disabled' with how-to-enable hint when interceptor is off", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("URL interceptors:");
		expect(msg).toContain("github: disabled");
		expect(msg).toMatch(/enable.*interceptors.*github.*true/);
	});

	it("--show lists 'github: enabled' with token + clonePath when opted in", async () => {
		process.env.GITHUB_TOKEN = "ghp_abcdefgh1234";
		writeConfig({ interceptors: { github: true } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("URL interceptors:");
		expect(msg).toContain("github: enabled");
		expect(msg).toContain("GITHUB_TOKEN: ghp_");
		expect(msg).toContain("clonePath:");
	});
});

// Per-call provider override — web_search accepts an optional `provider` param
// that routes the call to a different backend than `config.provider` without
// mutating persisted state. Key/URL resolution still reads from env/config
// under the named provider, so the override must have its own credentials.
describe("web_search.execute — per-call provider override", () => {
	it("routes to the override provider when its key is configured", async () => {
		// Active provider is brave (with key), but the call asks for tavily.
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		process.env.TAVILY_API_KEY = "tavily-key";
		writeConfig({ provider: "brave" });
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.tavily.com"),
				response: () =>
					new Response(JSON.stringify({ results: [{ title: "T", url: "https://x", content: "snip" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.(
				"tc",
				{ query: "hello", provider: "tavily" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect((r?.details as { backend: string }).backend).toBe("tavily");
		expect(stub.calls[0].url).toContain("api.tavily.com");
		const body = JSON.parse(stub.calls[0].init?.body as string);
		expect(body.api_key).toBe("tavily-key");
	});

	it("override works with config-file key (no env var)", async () => {
		writeConfig({ provider: "brave", apiKeys: { brave: "brave-key", exa: "exa-config-key" } });
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.exa.ai"),
				response: () =>
					new Response(JSON.stringify({ results: [{ title: "T", url: "https://x", text: "snip" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", provider: "exa" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { backend: string }).backend).toBe("exa");
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("exa-config-key");
	});

	it("override resolves baseUrl for self-hosted providers (searxng)", async () => {
		process.env.SEARXNG_URL = "http://override-host:9090";
		// Active provider is brave; override to searxng should pick up SEARXNG_URL.
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		writeConfig({ provider: "brave" });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://override-host:9090/"),
				response: () =>
					new Response(
						JSON.stringify({
							results: [{ title: "T", url: "https://x", content: "snip" }],
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.(
				"tc",
				{ query: "x", provider: "searxng" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect((r?.details as { backend: string }).backend).toBe("searxng");
		expect(new URL(stub.calls[0].url).host).toBe("override-host:9090");
	});

	it("override throws when the named provider has no key configured (no silent fallback)", async () => {
		// Active provider brave has a key, but the override (exa) does not.
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		writeConfig({ provider: "brave" });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x", provider: "exa" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/EXA_API_KEY is not set/);
	});

	it("override with an unknown provider name throws a clear error", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		writeConfig({ provider: "brave" });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.(
					"tc",
					{ query: "x", provider: "nonexistent" },
					undefined as never,
					undefined as never,
					createMockCtx(),
				),
		).rejects.toThrow(/Unknown web_search provider: "nonexistent"/);
	});

	it("override omitted falls back to config.provider (default path unchanged)", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		writeConfig({ provider: "brave" });
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

	it("schema declares the provider enum with all known names", () => {
		const { captured } = registerAndCapture();
		const params = captured.tools.get("web_search")?.parameters as unknown as {
			properties: { provider: { anyOf: Array<{ const: string }> } };
		};
		const literals = params.properties.provider?.anyOf?.map((e) => e.const) ?? [];
		expect(literals).toEqual(
			expect.arrayContaining([
				"brave",
				"tavily",
				"serper",
				"exa",
				"youcom",
				"jina",
				"firecrawl",
				"perplexity",
				"searxng",
				"ollama",
			]),
		);
		expect(literals).toHaveLength(10);
	});
});

// WEB_SEARCH_PROVIDER — middle precedence tier between the per-call override
// and config.provider. Lets an operator pin a backend via env without editing
// config.json; validated like the override so a bogus name throws (no silent
// fallback) rather than degrading to default.
describe("web_search.execute — WEB_SEARCH_PROVIDER precedence", () => {
	it("WEB_SEARCH_PROVIDER beats config.provider", async () => {
		process.env.WEB_SEARCH_PROVIDER = "tavily";
		process.env.TAVILY_API_KEY = "tavily-key";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: (u) => u.includes("api.tavily.com"),
				response: () =>
					new Response(JSON.stringify({ results: [{ title: "T", url: "https://x", content: "snip" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { backend: string }).backend).toBe("tavily");
	});

	it("per-call provider override beats WEB_SEARCH_PROVIDER", async () => {
		process.env.WEB_SEARCH_PROVIDER = "tavily";
		process.env.TAVILY_API_KEY = "tavily-key";
		process.env.EXA_API_KEY = "exa-key";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: (u) => u.includes("api.exa.ai"),
				response: () =>
					new Response(JSON.stringify({ results: [{ title: "T", url: "https://x", text: "snip" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", provider: "exa" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { backend: string }).backend).toBe("exa");
	});

	it("valid per-call override succeeds even when WEB_SEARCH_PROVIDER is bogus", async () => {
		// The override is the documented per-call escape hatch: when present it
		// wins without consulting the env tier, so a misconfigured env var must
		// not abort the call. (Regression guard for the unconditional-validation
		// interaction — env is validated only when it actually resolves.)
		process.env.WEB_SEARCH_PROVIDER = "bogus";
		process.env.EXA_API_KEY = "exa-key";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: (u) => u.includes("api.exa.ai"),
				response: () =>
					new Response(JSON.stringify({ results: [{ title: "T", url: "https://x", text: "snip" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", provider: "exa" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { backend: string }).backend).toBe("exa");
	});

	it("whitespace-only WEB_SEARCH_PROVIDER is treated as unset (config wins)", async () => {
		process.env.WEB_SEARCH_PROVIDER = "   ";
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({ web: { results: [{ title: "T", url: "https://x", description: "snip" }] } }),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { backend: string }).backend).toBe("brave");
	});

	it("unknown WEB_SEARCH_PROVIDER name throws (no silent fallback)", async () => {
		process.env.WEB_SEARCH_PROVIDER = "bogus";
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		writeConfig({ provider: "brave" });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Unknown web_search provider: "bogus"/);
	});
});

// --show surfaces the active provider's source so an env pin is discoverable
// rather than invisible. Mirrors the URL-line `source: env|config|default`
// pattern already used for self-hosted base URLs.
describe("/web-tools --show — active provider source", () => {
	it("reports source: env when WEB_SEARCH_PROVIDER is set", async () => {
		process.env.WEB_SEARCH_PROVIDER = "tavily";
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("active provider: tavily (source: env)");
	});

	it("reports source: config when config.provider is set and no env", async () => {
		writeConfig({ provider: "brave" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("active provider: brave (source: config)");
	});

	it("reports source: default when neither env nor config is set", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("--show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("active provider: brave (source: default)");
	});
});

// Picker honors WEB_SEARCH_PROVIDER: the env-named provider sorts first and is
// the only one carrying ✓. With no key configured it shows no "(configured)".
describe("/web-tools picker — WEB_SEARCH_PROVIDER drives ordering", () => {
	it("lists the env-named provider first and marks only it ✓ when no config", async () => {
		process.env.WEB_SEARCH_PROVIDER = "tavily";
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(labels[0]).toBe("Tavily ✓");
		expect(labels.filter((l) => l.includes("✓"))).toHaveLength(1);
	});
});

// web_fetch has no per-call override, so WEB_SEARCH_PROVIDER is its winning
// tier whenever set: the env-pinned provider's fetch path is used, and a
// bogus name throws exactly as it does for web_search.
describe("web_fetch.execute — WEB_SEARCH_PROVIDER precedence", () => {
	it("WEB_SEARCH_PROVIDER beats config.provider (env-pinned tavily fetch)", async () => {
		process.env.WEB_SEARCH_PROVIDER = "tavily";
		process.env.TAVILY_API_KEY = "k";
		writeConfig({ provider: "brave" });
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

	it("unknown WEB_SEARCH_PROVIDER name throws (no silent fallback)", async () => {
		process.env.WEB_SEARCH_PROVIDER = "bogus";
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		writeConfig({ provider: "brave" });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Unknown web_search provider: "bogus"/);
	});
});
