import type { FetchResponse, FullProvider, SearchResponse, SearchResult } from "./types.js";

const EXA_API_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_API_URL = "https://api.exa.ai/contents";
export const EXA_API_KEY_ENV_VAR = "EXA_API_KEY";
export const EXA_PROVIDER_META = {
	name: "exa",
	label: "Exa",
	envVar: EXA_API_KEY_ENV_VAR,
	roles: ["search", "fetch"] as const,
} as const;
const EXA_MAX_SNIPPET_CHARACTERS = 300;
// Exa's documented maximum is 10 000 characters (OpenAPI schema has
// `maximum: 10000`), but the live API accepts up to 1 000 000.
// Using the higher value lets rpiv-web-tools' own truncation
// (DEFAULT_MAX_BYTES = 50 KiB) take over, which appends a
// truncation footer and spills full content to a temp file so
// the model can recover it with the read tool.
const EXA_MAX_FETCH_CHARACTERS = 1_000_000;

interface ExaRawResult {
	title?: string;
	url?: string;
	text?: string;
}

interface ExaRawResponse {
	results?: ExaRawResult[];
	error?: string;
}

function normalizeExaResults(results: ExaRawResult[]): SearchResult[] {
	return results.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.text ?? "",
	}));
}

export class ExaProvider implements FullProvider {
	readonly name = EXA_PROVIDER_META.name;
	readonly label = EXA_PROVIDER_META.label;
	readonly envVar = EXA_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const res = await fetch(EXA_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
			},
			body: JSON.stringify({
				query,
				numResults: maxResults,
				contents: {
					text: { maxCharacters: EXA_MAX_SNIPPET_CHARACTERS },
				},
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Search API error (${res.status}): ${text}`);
		}

		const raw = (await res.json()) as ExaRawResponse;
		return { query, results: normalizeExaResults(raw.results ?? []) };
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-tools to configure, or export the env var.`);
		}

		const res = await fetch(EXA_CONTENTS_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
			},
			body: JSON.stringify({
				ids: [url],
				text: { maxCharacters: EXA_MAX_FETCH_CHARACTERS },
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${this.label} Fetch API error (${res.status}): ${text}`);
		}

		const data = (await res.json()) as ExaRawResponse;
		const result = data.results?.[0];

		if (!result?.text) {
			throw new Error(`${this.label} Fetch API error: no content returned for ${url}`);
		}

		return {
			text: result.text,
			title: result.title || undefined,
			contentType: "text/plain",
		};
	}
}
