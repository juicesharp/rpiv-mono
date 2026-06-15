import type { FetchResponse, FullProvider, SearchResponse, SearchResult } from "./types.js";

const JINA_SEARCH_API_URL = "https://s.jina.ai/";
const JINA_READER_API_URL = "https://r.jina.ai/";
export const JINA_API_KEY_ENV_VAR = "JINA_API_KEY";
export const JINA_PROVIDER_META = {
	name: "jina",
	label: "Jina",
	envVar: JINA_API_KEY_ENV_VAR,
	roles: ["search", "fetch"] as const,
} as const;

interface JinaSearchResult {
	title?: string;
	url?: string;
	description?: string;
}

interface JinaSearchResponse {
	code?: number;
	status?: number;
	data?:
		| JinaSearchResult[]
		| {
				query?: string;
				total?: number;
				results?: JinaSearchResult[];
		  };
}

function normalizeJinaResults(results: JinaSearchResult[]): SearchResult[] {
	return results.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

export class JinaProvider implements FullProvider {
	readonly name = JINA_PROVIDER_META.name;
	readonly label = JINA_PROVIDER_META.label;
	readonly envVar = JINA_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		// Jina s.jina.ai uses the URL path for the query. The `num` query param
		// is not documented as supported — pass it for forward-compat, then
		// slice client-side so we always honor maxResults regardless of vendor
		// behavior.
		const url = new URL(`${JINA_SEARCH_API_URL}${encodeURIComponent(query)}`);
		url.searchParams.set("num", String(maxResults));

		const res = await fetch(url.toString(), {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Search API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as JinaSearchResponse;
		const results = normalizeJinaResults(Array.isArray(raw.data) ? raw.data : (raw.data?.results ?? [])).slice(
			0,
			maxResults,
		);
		return { query, results };
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		// No Accept header = Reader returns markdown by default. Setting
		// Accept: text/plain would strip formatting and contradict the
		// contentType: "text/markdown" we report below.
		const res = await fetch(`${JINA_READER_API_URL}${url}`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
			},
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Fetch API error (${res.status}): ${text}`);
		}

		const text = await res.text();
		if (!text.trim()) {
			throw new Error(`${this.label} Fetch API error: no content returned for ${url}`);
		}
		return {
			text,
			contentType: "text/markdown",
		};
	}
}
