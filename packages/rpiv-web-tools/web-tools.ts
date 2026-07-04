/**
 * rpiv-web-tools — body
 *
 * Provides `web_search` and `web_fetch` tools backed by configurable search
 * providers (Brave, Tavily, Serper, Exa), plus the `/web-tools`
 * slash command for provider and API key configuration.
 *
 * API key resolution precedence per provider (first wins):
 *   1. Per-provider environment variable (e.g. BRAVE_SEARCH_API_KEY, TAVILY_API_KEY)
 *   2. apiKeys[provider] field in ~/.config/rpiv-web-tools/config.json
 *   3. (Brave only, legacy) apiKey field in config.json
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { validateGuidanceFields } from "@juicesharp/rpiv-config";
import { Type } from "typebox";
import { getConfigPath, readConfig, type WebToolsConfig, writeConfig } from "./providers/config.js";
import { createSearchProvider } from "./providers/factory.js";
import { fetchViaGenericHtml } from "./providers/fetch-helpers.js";
import { PROVIDERS } from "./providers/index.js";
import { GITHUB_TOKEN_ENV_VAR, getActiveGitHubInterceptor, getInterceptors } from "./providers/interceptors/index.js";
import type { FetchResponse, FullProvider, ProviderMeta, SearchProvider, SearchResult } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Tunables and external surface
// ---------------------------------------------------------------------------

const MIN_SEARCH_RESULTS = 1;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 5;

const SEARCH_RESULT_PREVIEW_LIMIT = 5;
const FETCH_PREVIEW_LINE_LIMIT = 15;
const API_KEY_MASK_VISIBLE_CHARS = 4;

const FETCH_TEMP_DIR_PREFIX = "rpiv-fetch-";
const FETCH_TEMP_FILE_NAME = "content.txt";

const CONFIG_PATH = getConfigPath();

const SUPPORTED_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

const WEB_TOOLS_COMMAND_NAME = "web-tools";
const SHOW_FLAG = "--show";
const UNSET_LABEL = "(not set)";

const DEFAULT_PROVIDER_NAME = "brave";

// Brave is the only provider whose key was historically stored at the top
// level (config.apiKey) before the per-provider apiKeys map. The legacy
// field is auto-migrated to apiKeys.brave on the next save by
// /web-tools (the dispatch deletes apiKey from the saved object).
const LEGACY_TOP_LEVEL_KEY_PROVIDER = "brave";

// ---------------------------------------------------------------------------
// Config persistence — schema + reader/writer live in providers/config.ts.
// The two local aliases keep the call-site shape identical to pre-refactor
// (loadConfig / saveConfig) so the rest of this file reads unchanged.
// ---------------------------------------------------------------------------

const loadConfig = readConfig;
const saveConfig = writeConfig;

// ---------------------------------------------------------------------------
// Executor guidance — overrides + defaults
// ---------------------------------------------------------------------------

// validateGuidanceFields is now imported from @juicesharp/rpiv-config

export const DEFAULT_WEB_SEARCH_SNIPPET = "Search the web for up-to-date information";
export const DEFAULT_WEB_SEARCH_GUIDELINES: string[] = [
	"Use web_search for information beyond your training data — recent events, current library versions, live API documentation.",
	'Use the current year from "Current date:" in your context when searching for recent information or documentation.',
	'After answering using search results, include a "Sources:" section listing relevant URLs as markdown hyperlinks: [Title](URL). Never skip this.',
	"Domain filtering is supported to include or block specific websites.",
	"If no API key is configured, ask the user to run /web-tools before proceeding.",
];

export const DEFAULT_WEB_FETCH_SNIPPET = "Fetch and read content from a specific URL";
export const DEFAULT_WEB_FETCH_GUIDELINES: string[] = [
	"Use web_fetch to read the full content of a specific URL — documentation pages, blog posts, API references found via web_search.",
	"web_fetch is complementary to web_search: search finds URLs, fetch reads them.",
	'After answering using fetched content, include a "Sources:" section with a markdown hyperlink to the fetched URL.',
	"Large responses are truncated and spilled to a temp file — the temp path is reported in the result details.",
];

// ---------------------------------------------------------------------------
// API key resolution + masking
// ---------------------------------------------------------------------------

function resolveProviderApiKey(providerName: string, config: WebToolsConfig): string | undefined {
	const meta = PROVIDERS.find((p) => p.name === providerName);
	if (!meta) return undefined;

	const envKey = meta.envVar ? process.env[meta.envVar]?.trim() : undefined;
	if (envKey) return envKey;

	const configKey = config.apiKeys?.[providerName]?.trim();
	if (configKey) return configKey;

	if (providerName === LEGACY_TOP_LEVEL_KEY_PROVIDER) {
		return config.apiKey?.trim() || undefined;
	}

	return undefined;
}

// Generic per-provider base-URL resolution: env → config.baseUrls[name] →
// meta.defaultBaseUrl → "". Providers without baseUrlEnvVar (hosted ones)
// short-circuit to "". The orchestrator only calls this for providers that
// declare baseUrlEnvVar, so the empty-string fallback is a safety net rather
// than a runtime path.
function resolveProviderBaseUrl(meta: ProviderMeta, config: WebToolsConfig): string {
	if (!meta.baseUrlEnvVar) return "";
	const envUrl = process.env[meta.baseUrlEnvVar]?.trim();
	if (envUrl) return envUrl;
	const configUrl = config.baseUrls?.[meta.name]?.trim();
	if (configUrl) return configUrl;
	return meta.defaultBaseUrl ?? "";
}

// Known provider names — derived once from PROVIDERS so the schema enum,
// the per-call override validation, and the error messages all stay in sync
// when a provider is added or removed.
const KNOWN_PROVIDER_NAMES = PROVIDERS.map((p) => p.name) as readonly string[];

// Uniform "unknown provider" error for both the per-call override path and the
// WEB_SEARCH_PROVIDER env path so misconfiguration surfaces the same shape.
function assertKnownProvider(name: string): void {
	if (!KNOWN_PROVIDER_NAMES.includes(name)) {
		throw new Error(`Unknown web_search provider: "${name}". Valid providers: ${KNOWN_PROVIDER_NAMES.join(", ")}.`);
	}
}

// Active-provider resolution for display + selection surfaces (env over config
// over default). Returns the raw name + its source — does NOT validate. A bogus
// WEB_SEARCH_PROVIDER renders in --show/picker (honest display) and only throws
// on the next web_search, via instantiateProvider's assertKnownProvider.
function resolveActiveProviderName(config: WebToolsConfig): {
	name: string;
	source: "env" | "config" | "default";
} {
	const envProvider = process.env.WEB_SEARCH_PROVIDER?.trim();
	if (envProvider) return { name: envProvider, source: "env" };
	if (config.provider) return { name: config.provider, source: "config" };
	return { name: DEFAULT_PROVIDER_NAME, source: "default" };
}

// Centralized instantiation: resolve provider name + creds, build via the
// factory. Called by both registerWebSearchTool and registerWebFetchTool.
//
// `override` lets a single tool call target a different provider than the
// active one without mutating persisted state. Resolution (4-tier, first wins):
//   providerName = override ?? WEB_SEARCH_PROVIDER ?? config.provider ?? DEFAULT_PROVIDER_NAME
//   1. override (per-call `provider` param) — validated against PROVIDERS;
//      unknown names throw so callers can detect misconfiguration.
//   2. WEB_SEARCH_PROVIDER env var — validated like the override, but ONLY
//      when it is the resolving tier: an override wins without consulting
//      (or validating) the env, so a bogus env var cannot defeat a valid
//      per-call override. Lets an operator pin a backend without editing
//      config.json.
//   3. config.provider (the /web-tools-selected default)
//   4. DEFAULT_PROVIDER_NAME ("brave")
// Key/baseURL resolution always reads from env/config under the resolved
// provider name, so an override/env pin still needs its own credentials.
function instantiateProvider(
	config: WebToolsConfig,
	override?: string,
): {
	providerName: string;
	provider: SearchProvider | FullProvider;
} {
	let providerName: string;
	if (override !== undefined) {
		assertKnownProvider(override);
		providerName = override;
	} else {
		// Single env read via the shared resolver (one snapshot — no double
		// read), validated only when env actually won the resolution.
		const active = resolveActiveProviderName(config);
		if (active.source === "env") assertKnownProvider(active.name);
		providerName = active.name;
	}
	const apiKey = resolveProviderApiKey(providerName, config);
	const meta = PROVIDERS.find((p) => p.name === providerName);
	const baseUrl = meta?.baseUrlEnvVar ? resolveProviderBaseUrl(meta, config) : undefined;
	const provider = createSearchProvider(providerName, { apiKey: apiKey ?? "", baseUrl });
	return { providerName, provider };
}

function maskApiKey(key: string | undefined): string {
	if (!key) return UNSET_LABEL;
	const head = key.slice(0, API_KEY_MASK_VISIBLE_CHARS);
	const tail = key.slice(-API_KEY_MASK_VISIBLE_CHARS);
	return `${head}...${tail}`;
}

function clampSearchResultCount(requested: number | undefined): number {
	const value = requested ?? DEFAULT_SEARCH_RESULTS;
	return Math.min(Math.max(value, MIN_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
}

// ---------------------------------------------------------------------------
// URL guard
// ---------------------------------------------------------------------------

function isPrivateOrLoopbackHostname(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	// IPv6 loopback / unspecified / link-local / unique-local
	if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
	// IPv4 literals
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	if (a === 0 || a === 127 || a === 10) return true; // 0.0.0.0/8, loopback, RFC1918
	if (a === 169 && b === 254) return true; // link-local (incl. AWS metadata 169.254.169.254)
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
	if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
	return false;
}

function parseAndAssertHttpUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (!SUPPORTED_HTTP_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http and https are supported.`);
	}
	if (isPrivateOrLoopbackHostname(parsed.hostname)) {
		throw new Error(`Refusing to fetch private/loopback address: ${parsed.hostname}`);
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// web_fetch helpers
// ---------------------------------------------------------------------------

interface FetchDetails {
	url: string;
	title?: string;
	contentType?: string;
	contentLength?: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

async function spillFullContentToTempFile(content: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), FETCH_TEMP_DIR_PREFIX));
	const tempFile = join(tempDir, FETCH_TEMP_FILE_NAME);
	await writeFile(tempFile, content, "utf8");
	return tempFile;
}

function formatTruncationFooter(truncation: TruncationResult, tempFile: string): string {
	const truncatedLines = truncation.totalLines - truncation.outputLines;
	const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
	return (
		`\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
		` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
		` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.` +
		` Full content saved to: ${tempFile}]`
	);
}

function formatFetchHeader(url: string, title: string | undefined, contentType: string): string {
	const lines = [`**Fetched:** ${url}`];
	if (title) lines.push(`**Title:** ${title}`);
	if (contentType) lines.push(`**Content-Type:** ${contentType}`);
	return `${lines.join("\n")}\n\n`;
}

// ---------------------------------------------------------------------------
// web_search result rendering
// ---------------------------------------------------------------------------

function formatSearchResultsBody(response: { query: string; results: SearchResult[] }): string {
	let text = `**Search results for "${response.query}":**\n\n`;
	response.results.forEach((r, i) => {
		text += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n\n`;
	});
	return text.trimEnd();
}

function buildEmptyResultsEnvelope(query: string, providerName: string) {
	return {
		content: [{ type: "text" as const, text: `No results found for "${query}".` }],
		details: { query, backend: providerName, resultCount: 0 },
	};
}

// ---------------------------------------------------------------------------
// Tool registrars
// ---------------------------------------------------------------------------

export function registerWebSearchTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance?.web_search);

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information. Returns a list of results with titles, URLs, and snippets. Use when you need current information not in your training data.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_WEB_SEARCH_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_WEB_SEARCH_GUIDELINES,
		parameters: Type.Object({
			query: Type.String({
				description: "The search query. Be specific and use natural language.",
			}),
			max_results: Type.Optional(
				Type.Number({
					description: `Maximum number of results to return (${MIN_SEARCH_RESULTS}-${MAX_SEARCH_RESULTS}). Default: ${DEFAULT_SEARCH_RESULTS}.`,
					default: DEFAULT_SEARCH_RESULTS,
					minimum: MIN_SEARCH_RESULTS,
					maximum: MAX_SEARCH_RESULTS,
				}),
			),
			provider: Type.Optional(
				Type.Union(
					KNOWN_PROVIDER_NAMES.map((name) => Type.Literal(name)),
					{
						description:
							"Search provider to use for this call only, overriding the active provider set via /web-tools. " +
							`Valid values: ${KNOWN_PROVIDER_NAMES.join(", ")}. ` +
							"Omit to use the configured active provider. The named provider must have its API key/URL configured (via env var or /web-tools) or the call throws — there is no silent fallback.",
					},
				),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const maxResults = clampSearchResultCount(params.max_results);
			const config = loadConfig();
			const { providerName, provider } = instantiateProvider(config, params.provider);

			onUpdate?.({
				content: [{ type: "text", text: `Searching ${provider.label} for: "${params.query}"...` }],
				details: { query: params.query, backend: providerName, resultCount: 0 },
			});

			const response = await provider.search(params.query, maxResults, signal);

			if (response.results.length === 0) {
				return buildEmptyResultsEnvelope(params.query, providerName);
			}

			return {
				content: [{ type: "text", text: formatSearchResultsBody(response) }],
				details: {
					query: params.query,
					backend: providerName,
					resultCount: response.results.length,
					results: response.results,
				},
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebSearch "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.provider) {
				text += theme.fg("dim", ` via ${args.provider}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}
			const details = result.details as { resultCount?: number; results?: SearchResult[] };
			const count = details?.resultCount ?? 0;
			let text = theme.fg("success", `✓ ${count} result${count !== 1 ? "s" : ""}`);
			if (expanded && details?.results) {
				text += renderSearchResultsPreview(details.results, theme);
			}
			return new Text(text, 0, 0);
		},
	});
}

function renderSearchResultsPreview(results: SearchResult[], theme: Theme): string {
	let text = "";
	for (const r of results.slice(0, SEARCH_RESULT_PREVIEW_LIMIT)) {
		text += `\n  ${theme.fg("dim", `• ${r.title}`)}`;
	}
	if (results.length > SEARCH_RESULT_PREVIEW_LIMIT) {
		text += `\n  ${theme.fg("dim", `... and ${results.length - SEARCH_RESULT_PREVIEW_LIMIT} more`)}`;
	}
	return text;
}

export function registerWebFetchTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance?.web_fetch);

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch the content of a specific URL. Returns text content for HTML pages (tags stripped), raw text for plain text or JSON. Supports http and https only. Content is truncated to avoid overwhelming the context window.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_WEB_FETCH_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_WEB_FETCH_GUIDELINES,
		parameters: Type.Object({
			url: Type.String({
				description: "The URL to fetch. Must be http or https.",
			}),
			raw: Type.Optional(
				Type.Boolean({
					description: "If true, return the raw HTML instead of extracted text. Default: false.",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { url, raw = false } = params;
			parseAndAssertHttpUrl(url);

			onUpdate?.({
				content: [{ type: "text", text: `Fetching: ${url}...` }],
				details: { url } as FetchDetails,
			});

			const config = loadConfig();
			const { provider } = instantiateProvider(config);

			// Three-way capability dispatch:
			//   1. URL interceptors (currently just GitHub) — opt-in URL specialists
			//      that handle their own host pattern. Cheap-reject to null for
			//      unrelated URLs; empty chain (interceptor disabled) is a no-op.
			//   2. Provider's native fetch — full providers (Tavily, Exa, Jina,
			//      Firecrawl, Ollama) have vendor endpoints worth using.
			//   3. Generic HTML fallback — for search-only providers (Brave, Serper,
			//      SearXNG) or any provider that doesn't carry a `fetch` method.
			let fetchResponse: FetchResponse | undefined;
			for (const interceptor of getInterceptors()) {
				const r = await interceptor.intercept(url, { raw, signal });
				if (r) {
					fetchResponse = r;
					break;
				}
			}
			if (!fetchResponse && "fetch" in provider) {
				fetchResponse = await provider.fetch(url, raw, signal);
			}
			if (!fetchResponse) {
				fetchResponse = await fetchViaGenericHtml(url, raw, signal);
			}
			const { text: bodyText, title, contentType, contentLength } = fetchResponse;

			const truncation = truncateHead(bodyText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: FetchDetails = {
				url,
				title,
				contentType,
				contentLength,
			};

			let output = truncation.content;
			if (truncation.truncated) {
				const tempFile = await spillFullContentToTempFile(bodyText);
				details.truncation = truncation;
				details.fullOutputPath = tempFile;
				output += formatTruncationFooter(truncation, tempFile);
			}

			return {
				content: [{ type: "text", text: formatFetchHeader(url, title, contentType ?? "") + output }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebFetch "));
			text += theme.fg("accent", args.url);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}
			const details = result.details as FetchDetails | undefined;
			let text = theme.fg("success", "✓ Fetched");
			if (details?.title) text += theme.fg("muted", `: ${details.title}`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					text += renderFetchedContentPreview(content.text, theme);
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

function renderFetchedContentPreview(content: string, theme: Theme): string {
	const lines = content.split("\n");
	const visible = lines.slice(0, FETCH_PREVIEW_LINE_LIMIT);
	let text = "";
	for (const line of visible) {
		text += `\n  ${theme.fg("dim", line)}`;
	}
	if (lines.length > FETCH_PREVIEW_LINE_LIMIT) {
		text += `\n  ${theme.fg("muted", "... (use read tool to see full content)")}`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// /web-tools command
// ---------------------------------------------------------------------------

function formatShowConfigMessage(current: WebToolsConfig): string {
	const lines = ["Web search config:", `  config file: ${CONFIG_PATH}`];

	const { name: providerName, source: providerSource } = resolveActiveProviderName(current);
	lines.push(`  active provider: ${providerName} (source: ${providerSource})`);

	for (const meta of PROVIDERS) {
		const envKey = meta.envVar ? process.env[meta.envVar]?.trim() : undefined;
		const configKey = current.apiKeys?.[meta.name]?.trim();
		const legacyKey = meta.name === LEGACY_TOP_LEVEL_KEY_PROVIDER ? current.apiKey?.trim() : undefined;
		const resolved = envKey ?? configKey ?? legacyKey;
		lines.push(
			`  ${meta.name}: ${maskApiKey(resolved)} (env: ${maskApiKey(envKey)}, config: ${maskApiKey(configKey ?? legacyKey)})`,
		);
	}

	// One URL line per provider that declares baseUrlEnvVar. Today this is
	// only SearXNG, but a second self-hosted provider lands without touching
	// this loop.
	for (const meta of PROVIDERS) {
		if (!meta.baseUrlEnvVar) continue;
		const envUrl = process.env[meta.baseUrlEnvVar]?.trim();
		const configUrl = current.baseUrls?.[meta.name]?.trim();
		const resolvedUrl = envUrl || configUrl || meta.defaultBaseUrl || "";
		const urlSource = envUrl ? "env" : configUrl ? "config" : "default";
		lines.push(`  ${meta.name} url: ${resolvedUrl} (source: ${urlSource})`);
	}

	lines.push("");
	lines.push("URL interceptors:");
	const githubInterceptor = getActiveGitHubInterceptor();
	if (githubInterceptor) {
		const opts = githubInterceptor.resolvedOptions;
		const token = process.env[GITHUB_TOKEN_ENV_VAR]?.trim();
		lines.push(
			`  github: enabled (${GITHUB_TOKEN_ENV_VAR}: ${maskApiKey(token)}, maxRepoSizeMB: ${opts.maxRepoSizeMB}, clonePath: ${opts.clonePath})`,
		);
	} else {
		lines.push("  github: disabled");
		lines.push('  ↳ enable:  add  "interceptors": { "github": true }   to config.json');
		lines.push('  ↳ disable: set  "interceptors": { "github": false }  to override a consumer-enabled default');
	}

	return lines.join("\n");
}

export function registerWebSearchConfigCommand(pi: ExtensionAPI): void {
	pi.registerCommand(WEB_TOOLS_COMMAND_NAME, {
		description: "Configure the search provider and API key used by web_search",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui?.notify?.(`/${WEB_TOOLS_COMMAND_NAME} requires interactive mode`, "error");
				return;
			}

			const current = loadConfig();

			if (typeof args === "string" && args.includes(SHOW_FLAG)) {
				ctx.ui.notify(formatShowConfigMessage(current), "info");
				return;
			}

			const activeProvider = resolveActiveProviderName(current).name;
			const orderedMetas = [
				...PROVIDERS.filter((p) => p.name === activeProvider),
				...PROVIDERS.filter((p) => p.name !== activeProvider),
			];
			const hasKey = (p: ProviderMeta) => {
				// Self-hosted providers are "configured" once they have a base URL
				// (env or config). The bare default URL doesn't count — it's just a
				// hint that the user hasn't touched the setting yet.
				if (p.baseUrlEnvVar) {
					return Boolean(process.env[p.baseUrlEnvVar]?.trim() || current.baseUrls?.[p.name]?.trim());
				}
				return resolveProviderApiKey(p.name, current) !== undefined;
			};
			const labelOf = (p: (typeof PROVIDERS)[number]) => {
				const markers: string[] = [];
				if (p.name === activeProvider) markers.push("✓");
				if (hasKey(p)) markers.push("(configured)");
				return markers.length > 0 ? `${p.label} ${markers.join(" ")}` : p.label;
			};

			const selectedLabel = await ctx.ui.select("Search provider", orderedMetas.map(labelOf), {});
			if (selectedLabel === undefined || selectedLabel === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			// Match by prefix on the original provider label — robust to any marker
			// suffix (✓, (configured), or any future additions to labelOf above).
			const selectedMeta = PROVIDERS.find(
				(p) => selectedLabel === p.label || selectedLabel.startsWith(`${p.label} `),
			);
			if (!selectedMeta) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}
			const selectedProvider = selectedMeta.name;

			// Providers that declare a `configure` callback own their prompt flow
			// (e.g. SearXNG: URL prompt then optional Bearer key). The orchestrator
			// dispatches generically and owns persistence + notifications.
			if (selectedMeta.configure) {
				const result = await selectedMeta.configure(ctx.ui, {
					baseUrl: current.baseUrls?.[selectedProvider],
					apiKey: current.apiKeys?.[selectedProvider],
				});
				if (!result) {
					ctx.ui.notify("Web search config unchanged", "info");
					return;
				}
				const toSave: WebToolsConfig = {
					...current,
					provider: selectedProvider,
					...(result.baseUrl !== undefined && {
						baseUrls: { ...current.baseUrls, [selectedProvider]: result.baseUrl },
					}),
					...(result.apiKey ? { apiKeys: { ...current.apiKeys, [selectedProvider]: result.apiKey } } : {}),
				};
				delete (toSave as { apiKey?: string }).apiKey;
				if (!saveConfig(toSave)) {
					ctx.ui.notify(
						`Failed to save ${selectedMeta.label} config to ${CONFIG_PATH} — disk write failed`,
						"error",
					);
					return;
				}
				ctx.ui.notify(
					result.baseUrl
						? `Saved ${selectedMeta.label} config (url: ${result.baseUrl}) to ${CONFIG_PATH}`
						: `Saved ${selectedMeta.label} config to ${CONFIG_PATH}`,
					"info",
				);
				return;
			}

			const existingKey =
				current.apiKeys?.[selectedProvider] ??
				(selectedProvider === LEGACY_TOP_LEVEL_KEY_PROVIDER ? current.apiKey : undefined);
			const input = await ctx.ui.input(
				`${selectedMeta.label} API key`,
				existingKey ? `Press Enter to keep current (${maskApiKey(existingKey)}), or type new key` : "...",
			);

			if (input === undefined || input === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const trimmed = input.trim();
			const keyToWrite = trimmed || existingKey;
			if (!keyToWrite) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const toSave: WebToolsConfig = {
				...current,
				provider: selectedProvider,
				apiKeys: { ...current.apiKeys, [selectedProvider]: keyToWrite },
			};
			delete (toSave as { apiKey?: string }).apiKey;
			if (!saveConfig(toSave)) {
				// Don't lie about persistence — a "Saved …" message followed by an
				// auth error on the next web_search would point the user at the
				// wrong surface (vendor) instead of the actual cause (disk write).
				ctx.ui.notify(
					`Failed to save ${selectedMeta.label} API key to ${CONFIG_PATH} — disk write failed`,
					"error",
				);
				return;
			}
			ctx.ui.notify(
				trimmed
					? `Saved ${selectedMeta.label} API key to ${CONFIG_PATH}`
					: `Active provider set to ${selectedMeta.label}; existing key kept`,
				"info",
			);
		},
	});
}
