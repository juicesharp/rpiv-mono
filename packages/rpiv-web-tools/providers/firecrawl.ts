import type { FetchResponse, SearchProvider, SearchResponse, SearchResult } from "./types.js";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1";
export const FIRECRAWL_API_KEY_ENV_VAR = "FIRECRAWL_API_KEY";
export const FIRECRAWL_PROVIDER_META = {
	name: "firecrawl",
	label: "Firecrawl",
	envVar: FIRECRAWL_API_KEY_ENV_VAR,
} as const;

interface FirecrawlSearchResult {
	title?: string;
	url?: string;
	description?: string;
}

interface FirecrawlSearchResponse {
	success?: boolean;
	data?: FirecrawlSearchResult[];
	error?: string;
}

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: {
		markdown?: string;
		html?: string;
		metadata?: {
			title?: string;
			description?: string;
			language?: string;
			statusCode?: number;
		};
	};
	error?: string;
}

function normalizeFirecrawlResults(results: FirecrawlSearchResult[]): SearchResult[] {
	return results.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

export class FirecrawlProvider implements SearchProvider {
	readonly name = FIRECRAWL_PROVIDER_META.name;
	readonly label = FIRECRAWL_PROVIDER_META.label;
	readonly envVar = FIRECRAWL_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-search-config to configure, or export the env var.`);
		}

		const res = await fetch(`${FIRECRAWL_API_URL}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				query,
				limit: maxResults,
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Search API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as FirecrawlSearchResponse;
		return { query, results: normalizeFirecrawlResults(raw.data ?? []) };
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-search-config to configure, or export the env var.`);
		}

		const res = await fetch(`${FIRECRAWL_API_URL}/scrape`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				url,
				formats: ["markdown"],
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Fetch API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as FirecrawlScrapeResponse;

		if (!raw.success) {
			throw new Error(`${this.label} Fetch API error: ${raw.error ?? "scrape failed"}`);
		}

		if (!raw.data?.markdown) {
			throw new Error(`${this.label} Fetch API error: no content returned for ${url}`);
		}

		return {
			text: raw.data.markdown,
			title: raw.data.metadata?.title || undefined,
			contentType: "text/markdown",
		};
	}
}
