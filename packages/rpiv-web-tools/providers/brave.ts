import { assertTextContentType, extractBodyAsText, fetchUrlOrThrow } from "./fetch-helpers.js";
import type { FetchResponse, SearchProvider, SearchResponse, SearchResult } from "./types.js";

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_API_KEY_ENV_VAR = "BRAVE_SEARCH_API_KEY";
export const BRAVE_PROVIDER_META = {
	name: "brave",
	label: "Brave",
	envVar: BRAVE_API_KEY_ENV_VAR,
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
			throw new Error(`${this.envVar} is not set. Run /web-search-config to configure, or export the env var.`);
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

	// No apiKey guard: Brave's fetch() wraps the built-in HTTP+htmlToText
	// pipeline and does not call any vendor endpoint. Adding a guard would
	// break the "use any provider for fetch" contract.
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
