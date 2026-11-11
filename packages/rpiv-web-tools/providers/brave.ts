import type { SearchProvider, SearchResponse, SearchResult } from "./types.ts";

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_API_KEY_ENV_VAR = "BRAVE_SEARCH_API_KEY";
export const BRAVE_PROVIDER_META = {
	name: "brave",
	label: "Brave",
	envVar: BRAVE_API_KEY_ENV_VAR,
	roles: ["search"] as const,
} as const;

interface BraveRawResponse {
	web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

function normalizeBraveResults(raw: BraveRawResponse): SearchResult[] {
	return (raw.web?.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

export class BraveProvider implements SearchProvider {
	readonly name = BRAVE_PROVIDER_META.name;
	readonly label = BRAVE_PROVIDER_META.label;
	readonly envVar = BRAVE_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const url = new URL(BRAVE_SEARCH_API_URL);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(maxResults));

		const res = await fetch(url.toString(), {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": this.apiKey,
			},
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Search API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as BraveRawResponse;
		return { query, results: normalizeBraveResults(raw) };
	}
}
