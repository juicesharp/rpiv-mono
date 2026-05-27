import { assertTextContentType, extractBodyAsText, fetchUrlOrThrow } from "./fetch-helpers.js";
import {
	type FetchResponse,
	isCancellation,
	type ProviderConfigChange,
	type ProviderConfigCurrent,
	type ProviderConfigUi,
	type ProviderMeta,
	type SearchProvider,
	type SearchResponse,
	type SearchResult,
} from "./types.js";

export const SEARXNG_API_KEY_ENV_VAR = "SEARXNG_API_KEY";
export const SEARXNG_URL_ENV_VAR = "SEARXNG_URL";
export const SEARXNG_DEFAULT_URL = "http://localhost:8080";

// SearXNG search API knobs (per https://docs.searxng.org/dev/search_api.html).
const SEARXNG_SEARCH_PATH = "/search";
const SEARXNG_FORMAT_JSON = "json";
const SEARXNG_SAFESEARCH_OFF = "0"; // 0/1/2 = none/moderate/strict

// Number of leading + trailing characters preserved when masking a Bearer key
// in the config prompt. Mirrors API_KEY_MASK_VISIBLE_CHARS in web-tools.ts.
const MASK_VISIBLE_CHARS = 4;

// SearXNG-specific aliases of the generic config shapes — preserved for
// backward compatibility with the symbols exported in v1.11.0. New providers
// should consume the generic ProviderConfig* types from ./types.js directly.
export type SearxngConfigUi = ProviderConfigUi;
export type SearxngConfigCurrent = ProviderConfigCurrent;
export type SearxngConfigChange = ProviderConfigChange;

export const SEARXNG_PROVIDER_META: ProviderMeta = {
	name: "searxng",
	label: "SearXNG",
	envVar: SEARXNG_API_KEY_ENV_VAR,
	baseUrlEnvVar: SEARXNG_URL_ENV_VAR,
	defaultBaseUrl: SEARXNG_DEFAULT_URL,
	configure: (ui, current) => configureSearxng(ui, current),
};

interface SearxngRawResult {
	title?: string;
	url?: string;
	content?: string;
}

interface SearxngRawResponse {
	results?: SearxngRawResult[];
}

function normalizeSearxngResults(raw: SearxngRawResponse, maxResults: number): SearchResult[] {
	return (raw.results ?? []).slice(0, maxResults).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

// Reject anything that isn't an http(s) URL — a user-supplied SEARXNG_URL
// must not be allowed to silently become `file://`, `javascript:`, `data:`
// or any other scheme that `new URL()` accepts but we'd misuse downstream.
function assertHttpUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${SEARXNG_URL_ENV_VAR} is not a valid URL (got: ${url})`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`${SEARXNG_URL_ENV_VAR} must use http:// or https:// (got: ${parsed.protocol.replace(":", "")}://)`,
		);
	}
}

// 401 ≈ reverse-proxy auth rejected the Bearer token. 403 from a default
// SearXNG install almost always means JSON output is disabled — the docs
// explicitly warn that "Requesting an unset format will return a 403
// Forbidden error". Surface the actionable fix for each.
function hintForSearchStatus(status: number): string {
	if (status === 401) {
		return ` (the SearXNG instance's reverse-proxy rejected the Bearer token; check ${SEARXNG_API_KEY_ENV_VAR} or apiKeys.searxng)`;
	}
	if (status === 403) {
		return " (the SearXNG instance may have JSON output disabled; enable 'json' under 'search.formats' in its settings.yml)";
	}
	return "";
}

interface SearxngProviderOptions {
	apiKey?: string;
	baseUrl: string;
}

export class SearxngProvider implements SearchProvider {
	readonly name = "searxng";
	readonly label = "SearXNG";
	readonly envVar = SEARXNG_API_KEY_ENV_VAR;

	private readonly apiKey?: string;
	private readonly baseUrl: string;

	constructor(options: SearxngProviderOptions) {
		this.apiKey = options.apiKey?.trim() || undefined;
		const trimmed = stripTrailingSlashes(options.baseUrl?.trim() ?? "");
		if (trimmed) assertHttpUrl(trimmed);
		this.baseUrl = trimmed;
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		this.requireBaseUrl();
		const res = await fetch(this.buildSearchUrl(query), {
			method: "GET",
			headers: this.buildAuthHeaders(),
			signal,
		});
		if (!res.ok) throw await this.searchApiError(res);
		const raw = (await res.json()) as SearxngRawResponse;
		return { query, results: normalizeSearxngResults(raw, maxResults) };
	}

	// No guard: SearXNG's fetch() wraps the built-in HTTP+htmlToText pipeline
	// and does not call the SearXNG instance — same contract as Brave/Serper.
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

	private requireBaseUrl(): void {
		if (!this.baseUrl) {
			throw new Error(`${SEARXNG_URL_ENV_VAR} is not set. Run /web-tools to configure, or export the env var.`);
		}
	}

	// The SearXNG API exposes only `pageno` for pagination, not `count`/`limit`
	// (https://docs.searxng.org/dev/search_api.html), so we ask for a single
	// page and slice to maxResults client-side.
	private buildSearchUrl(query: string): string {
		const url = new URL(`${this.baseUrl}${SEARXNG_SEARCH_PATH}`);
		url.searchParams.set("q", query);
		url.searchParams.set("format", SEARXNG_FORMAT_JSON);
		url.searchParams.set("safesearch", SEARXNG_SAFESEARCH_OFF);
		return url.toString();
	}

	// SearXNG itself has no native auth; the optional Bearer key is for
	// instances fronted by a reverse-proxy that gates on Authorization.
	private buildAuthHeaders(): Record<string, string> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	private async searchApiError(res: Response): Promise<Error> {
		const body = await res.text();
		return new Error(`${this.label} Search API error (${res.status})${hintForSearchStatus(res.status)}: ${body}`);
	}
}

// ---------------------------------------------------------------------------
// /web-tools helper — SearXNG branch
// ---------------------------------------------------------------------------
// SEARXNG_PROVIDER_META.configure wires configureSearxng() in; the orchestrator
// dispatches generically through ProviderMeta.configure without naming
// SearXNG specifically.

// Mirrors web-tools.ts:maskApiKey. Duplicated here (3 lines) to keep
// providers/* free of web-tools internals; consolidate if this ever grows.
function maskKey(key: string): string {
	const head = key.slice(0, MASK_VISIBLE_CHARS);
	const tail = key.slice(-MASK_VISIBLE_CHARS);
	return `${head}...${tail}`;
}

// Returns the resolved URL string, or `undefined` if the user cancelled.
// Empty input keeps the current URL or falls back to SEARXNG_DEFAULT_URL.
async function promptForBaseUrl(ui: ProviderConfigUi, current: string | undefined): Promise<string | undefined> {
	const existing = current?.trim();
	const input = await ui.input(
		"SearXNG base URL",
		existing
			? `Press Enter to keep current (${existing}), or type new URL`
			: `Press Enter for default (${SEARXNG_DEFAULT_URL}), or type instance URL`,
	);
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || SEARXNG_DEFAULT_URL;
}

// Returns the resolved key string, `null` to leave unset, or `undefined` if
// the user cancelled. Empty input keeps the current key or leaves it unset.
async function promptForOptionalKey(
	ui: ProviderConfigUi,
	current: string | undefined,
): Promise<string | null | undefined> {
	const existing = current?.trim() || undefined;
	const input = await ui.input(
		"SearXNG API key (optional — for instances behind a Bearer-auth proxy)",
		existing
			? `Press Enter to keep current (${maskKey(existing)}), or type new key`
			: "Press Enter to leave unset, or type a key",
	);
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || null;
}

/**
 * Prompts the user for the SearXNG base URL and optional Bearer API key.
 * Returns `null` if the user cancels at either prompt.
 *
 * The caller owns persistence (loading/merging/saving WebToolsConfig) and
 * user-visible notifications. This helper only handles the prompt flow.
 */
export async function configureSearxng(
	ui: SearxngConfigUi,
	current: SearxngConfigCurrent,
): Promise<SearxngConfigChange | null> {
	const baseUrl = await promptForBaseUrl(ui, current.baseUrl);
	if (baseUrl === undefined) return null;

	const apiKey = await promptForOptionalKey(ui, current.apiKey);
	if (apiKey === undefined) return null;

	return { baseUrl, apiKey };
}
