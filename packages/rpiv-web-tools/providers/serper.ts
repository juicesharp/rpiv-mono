import { assertTextContentType, extractBodyAsText, fetchUrlOrThrow } from "./fetch-helpers.js";
import type { FetchResponse, SearchProvider, SearchResponse, SearchResult } from "./types.js";

const SERPER_API_URL = "https://google.serper.dev/search";
export const SERPER_API_KEY_ENV_VAR = "SERPER_API_KEY";
export const SERPER_PROVIDER_META = {
	name: "serper",
	label: "Serper",
	envVar: SERPER_API_KEY_ENV_VAR,
} as const;

interface SerperOrganicResult {
	title?: string;
	link?: string;
	snippet?: string;
}

interface SerperRawResponse {
	organic?: SerperOrganicResult[];
	message?: string;
}

function normalizeSerperResults(results: SerperOrganicResult[]): SearchResult[] {
	return results.map((r) => ({
		title: r.title ?? "",
		url: r.link ?? "",
		snippet: r.snippet ?? "",
	}));
}

export class SerperProvider implements SearchProvider {
	readonly name = SERPER_PROVIDER_META.name;
	readonly label = SERPER_PROVIDER_META.label;
	readonly envVar = SERPER_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-search-config to configure, or export the env var.`);
		}

		const res = await fetch(SERPER_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": this.apiKey,
			},
			body: JSON.stringify({
				q: query,
				num: maxResults,
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Search API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as SerperRawResponse;
		return { query, results: normalizeSerperResults(raw.organic ?? []) };
	}

	// No apiKey guard: Serper's fetch() wraps the built-in HTTP+htmlToText
	// pipeline and does not call any vendor endpoint. Same rationale as Brave.
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
