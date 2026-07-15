import type { FetchResponse, FullProvider, SearchResponse, SearchResult } from "./types.js";

const YOUCOM_SEARCH_URL = "https://api.you.com/v1/agents/search";
const YOUCOM_CONTENTS_URL = "https://api.ydc-index.io/v1/contents";
export const YOUCOM_API_KEY_ENV_VAR = "YDC_API_KEY";
export const YOUCOM_PROVIDER_META = {
	name: "youcom",
	label: "You.com",
	envVar: YOUCOM_API_KEY_ENV_VAR,
	roles: ["search", "fetch"] as const,
} as const;

// Agents search endpoint returns a flat array of results.
interface YouComAgentsResult {
	title?: string;
	url?: string;
	snippet?: string;
}

// Legacy ydc-index.io search endpoint returns nested { web: [...], news: [...] }.
interface YouComWebResult {
	url?: string;
	title?: string;
	description?: string;
	snippets?: string[];
}

interface YouComSearchResponse {
	results?: YouComAgentsResult[] | { web?: YouComWebResult[] };
}

interface YouComContentsResponseItem {
	url: string;
	title?: string;
	markdown?: string | null;
}

function normalizeYouComResults(raw: YouComSearchResponse["results"]): SearchResult[] {
	if (!raw) return [];

	// Agents API (api.you.com/v1/agents/search) returns a flat array.
	if (Array.isArray(raw)) {
		return raw.map((r) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			snippet: r.snippet ?? "",
		}));
	}

	// Legacy ydc-index.io/v1/search returns { web: [...], news: [...] }.
	return (raw.web ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.snippets?.[0] ?? r.description ?? "",
	}));
}

export class YouComProvider implements FullProvider {
	readonly name = YOUCOM_PROVIDER_META.name;
	readonly label = YOUCOM_PROVIDER_META.label;
	readonly envVar = YOUCOM_API_KEY_ENV_VAR;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const res = await fetch(YOUCOM_SEARCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": this.apiKey,
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

		const raw = (await res.json()) as YouComSearchResponse;
		return { query, results: normalizeYouComResults(raw.results) };
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const res = await fetch(YOUCOM_CONTENTS_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": this.apiKey,
			},
			body: JSON.stringify({
				urls: [url],
				formats: ["markdown"],
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Fetch API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as YouComContentsResponseItem[];
		const item = raw[0];

		if (!item?.markdown) {
			throw new Error(`${this.label} Fetch API error: no content returned for ${url}`);
		}

		return {
			text: item.markdown,
			title: item.title || undefined,
			contentType: "text/markdown",
		};
	}
}
