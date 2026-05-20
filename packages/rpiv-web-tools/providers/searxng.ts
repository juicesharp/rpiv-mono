import { assertTextContentType, extractBodyAsText, fetchUrlOrThrow } from "./fetch-helpers.js";
import type { FetchResponse, SearchProvider, SearchResponse, SearchResult } from "./types.js";

export const SEARXNG_API_KEY_ENV_VAR = "SEARXNG_API_KEY";
export const SEARXNG_URL_ENV_VAR = "SEARXNG_URL";
export const SEARXNG_DEFAULT_URL = "http://localhost:8080";

export const SEARXNG_PROVIDER_META = {
	name: "searxng",
	label: "SearXNG",
	envVar: SEARXNG_API_KEY_ENV_VAR,
} as const;

interface SearxngRawResult {
	title?: string;
	url?: string;
	content?: string;
}

interface SearxngRawResponse {
	results?: SearxngRawResult[];
}

function normalizeSearxngResults(raw: SearxngRawResponse, maxResults: number): SearchResult[] {
	return (raw.results ?? []).slice(0, maxResults).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

function stripTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface SearxngProviderOptions {
	apiKey?: string;
	baseUrl: string;
}

export class SearxngProvider implements SearchProvider {
	readonly name = SEARXNG_PROVIDER_META.name;
	readonly label = SEARXNG_PROVIDER_META.label;
	readonly envVar = SEARXNG_PROVIDER_META.envVar;

	private readonly apiKey?: string;
	private readonly baseUrl: string;

	constructor(options: SearxngProviderOptions) {
		this.apiKey = options.apiKey?.trim() || undefined;
		this.baseUrl = stripTrailingSlash(options.baseUrl?.trim() ?? "");
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.baseUrl) {
			throw new Error(
				`${SEARXNG_URL_ENV_VAR} is not set. Run /web-search-config to configure, or export the env var.`,
			);
		}

		// The SearXNG API exposes only `pageno` for pagination, not `count`/`limit`
		// (https://docs.searxng.org/dev/search_api.html), so we ask for a single
		// page and slice to maxResults client-side.
		const url = new URL(`${this.baseUrl}/search`);
		url.searchParams.set("q", query);
		url.searchParams.set("format", "json");
		url.searchParams.set("safesearch", "0");

		const headers: Record<string, string> = {
			Accept: "application/json",
		};
		// SearXNG itself has no native auth; the optional Bearer key is for
		// instances fronted by a reverse-proxy that gates on Authorization.
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

		const res = await fetch(url.toString(), { method: "GET", headers, signal });

		if (!res.ok) {
			const text = await res.text();
			// 403 from a default SearXNG install almost always means JSON output is
			// disabled — the docs explicitly warn that "Requesting an unset format
			// will return a 403 Forbidden error". Surface the actionable fix.
			const hint =
				res.status === 403
					? " (the SearXNG instance may have JSON output disabled; enable 'json' under 'search.formats' in its settings.yml)"
					: "";
			throw new Error(`${this.label} Search API error (${res.status})${hint}: ${text}`);
		}

		const raw = (await res.json()) as SearxngRawResponse;
		return { query, results: normalizeSearxngResults(raw, maxResults) };
	}

	// No guard: SearXNG's fetch() wraps the built-in HTTP+htmlToText pipeline
	// and does not call the SearXNG instance — same contract as Brave/Serper.
	async fetch(url: string, raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		const res = await fetchUrlOrThrow(url, signal);
		const contentType = res.headers.get("content-type") ?? "";
		assertTextContentType(contentType);

		const { text, title } = await extractBodyAsText(res, contentType, raw);
		const contentLengthHeader = res.headers.get("content-length");
		return {
			text,
			title,
			contentType: contentType || undefined,
			contentLength: contentLengthHeader ? Number(contentLengthHeader) : undefined,
		};
	}
}
