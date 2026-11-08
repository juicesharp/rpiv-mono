import type { FetchResponse, FullProvider, SearchResponse, SearchResult } from "./types.ts";

const OUTCRAWL_API_URL = "https://api.outcrawl.ai/v1";
export const OUTCRAWL_API_KEY_ENV_VAR = "OUTCRAWL_API_KEY";
export const OUTCRAWL_PROVIDER_META = {
	name: "outcrawl",
	label: "Outcrawl",
	envVar: OUTCRAWL_API_KEY_ENV_VAR,
	roles: ["search", "fetch"] as const,
} as const;

interface OutcrawlSearchHit {
	title?: string;
	url?: string;
	snippet?: string;
}

interface OutcrawlSearchResponse {
	hits?: OutcrawlSearchHit[];
}

interface OutcrawlScrapeResponse {
	markdown?: string;
	metadata?: {
		title?: string;
	};
}

function normalizeOutcrawlResults(hits: OutcrawlSearchHit[]): SearchResult[] {
	return hits.map((h) => ({
		title: h.title ?? "",
		url: h.url ?? "",
		snippet: h.snippet ?? "",
	}));
}

export class OutcrawlProvider implements FullProvider {
	readonly name = OUTCRAWL_PROVIDER_META.name;
	readonly label = OUTCRAWL_PROVIDER_META.label;
	readonly envVar = OUTCRAWL_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const res = await fetch(`${OUTCRAWL_API_URL}/search`, {
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

		const raw = (await res.json()) as OutcrawlSearchResponse;
		return { query, results: normalizeOutcrawlResults(raw.hits ?? []) };
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const res = await fetch(`${OUTCRAWL_API_URL}/scrape`, {
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

		const raw = (await res.json()) as OutcrawlScrapeResponse;

		if (!raw.markdown) {
			throw new Error(`${this.label} Fetch API error: no content returned for ${url}`);
		}

		return {
			text: raw.markdown,
			title: raw.metadata?.title || undefined,
			contentType: "text/markdown",
		};
	}
}
