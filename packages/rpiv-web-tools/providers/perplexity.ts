import type { SearchProvider, SearchResponse, SearchResult } from "./types.ts";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/search";
export const PERPLEXITY_API_KEY_ENV_VAR = "PERPLEXITY_API_KEY";
export const PERPLEXITY_PROVIDER_META = {
	name: "perplexity",
	label: "Perplexity",
	envVar: PERPLEXITY_API_KEY_ENV_VAR,
	roles: ["search"] as const,
} as const;

interface PerplexityRawResult {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string | null;
	last_updated?: string | null;
}

interface PerplexityRawResponse {
	results?: PerplexityRawResult[];
	id?: string;
	server_time?: string | null;
}

function normalizePerplexityResults(results: PerplexityRawResult[]): SearchResult[] {
	return results.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.snippet ?? "",
	}));
}

export class PerplexityProvider implements SearchProvider {
	readonly name = PERPLEXITY_PROVIDER_META.name;
	readonly label = PERPLEXITY_PROVIDER_META.label;
	readonly envVar = PERPLEXITY_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const res = await fetch(PERPLEXITY_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				query,
				max_results: maxResults,
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Search API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as PerplexityRawResponse;
		return { query, results: normalizePerplexityResults(raw.results ?? []) };
	}
}
