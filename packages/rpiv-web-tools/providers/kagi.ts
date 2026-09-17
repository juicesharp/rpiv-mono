import type { SearchProvider, SearchResponse, SearchResult } from "./types.js";

const KAGI_SEARCH_API_URL = "https://kagi.com/api/v1/search";
export const KAGI_API_KEY_ENV_VAR = "KAGI_API_KEY";
export const KAGI_PROVIDER_META = {
	name: "kagi",
	label: "Kagi",
	envVar: KAGI_API_KEY_ENV_VAR,
	roles: ["search"] as const,
} as const;

interface KagiRawResult {
	title?: string;
	url?: string;
	snippet?: string;
}

interface KagiRawResponse {
	data?: {
		search?: KagiRawResult[];
	};
}

function normalizeKagiResults(raw: KagiRawResponse): SearchResult[] {
	return (raw.data?.search ?? []).map((result) => ({
		title: result.title ?? "",
		url: result.url ?? "",
		snippet: result.snippet ?? "",
	}));
}

export class KagiProvider implements SearchProvider {
	readonly name = KAGI_PROVIDER_META.name;
	readonly label = KAGI_PROVIDER_META.label;
	readonly envVar = KAGI_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const response = await fetch(KAGI_SEARCH_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, limit: maxResults }),
			signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`${this.label} Search API error (${response.status}): ${text}`);
		}

		const raw = (await response.json()) as KagiRawResponse;
		return { query, results: normalizeKagiResults(raw) };
	}
}
