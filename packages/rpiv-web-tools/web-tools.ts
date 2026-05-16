/**
 * rpiv-web-tools — body
 *
 * Provides `web_search` and `web_fetch` tools backed by configurable search
 * providers (Brave, Tavily, Serper, Exa), plus the `/web-search-config`
 * slash command for provider and API key configuration.
 *
 * API key resolution precedence per provider (first wins):
 *   1. Per-provider environment variable (e.g. BRAVE_SEARCH_API_KEY, TAVILY_API_KEY)
 *   2. apiKeys[provider] field in ~/.config/rpiv-web-tools/config.json
 *   3. (Brave only, legacy) apiKey field in config.json
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createSearchProvider } from "./providers/factory.js";
import { PROVIDERS } from "./providers/index.js";
import type { SearchResult } from "./providers/types.js";

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

const CONFIG_DIR = join(homedir(), ".config", "rpiv-web-tools");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CONFIG_FILE_MODE = 0o600;

const SUPPORTED_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

const WEB_SEARCH_CONFIG_COMMAND_NAME = "web-search-config";
const SHOW_FLAG = "--show";
const UNSET_LABEL = "(not set)";

const DEFAULT_PROVIDER_NAME = "brave";

// ---------------------------------------------------------------------------
// Config file persistence
// ---------------------------------------------------------------------------

interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface WebToolsGuidance {
	web_search?: GuidanceFields;
	web_fetch?: GuidanceFields;
}

interface WebToolsConfig {
	provider?: string;
	apiKeys?: Record<string, string>;
	apiKey?: string; // legacy — kept for backward compat
	guidance?: WebToolsGuidance;
}

function loadConfig(): WebToolsConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as WebToolsConfig;
	} catch {
		return {};
	}
}

function saveConfig(config: WebToolsConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	try {
		chmodSync(CONFIG_PATH, CONFIG_FILE_MODE);
	} catch {
		// chmod may fail on some filesystems — best effort only
	}
}

// ---------------------------------------------------------------------------
// Executor guidance — overrides + defaults
// ---------------------------------------------------------------------------

function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	return result;
}

export const DEFAULT_WEB_SEARCH_SNIPPET = "Search the web for up-to-date information";
export const DEFAULT_WEB_SEARCH_GUIDELINES: string[] = [
	"Use web_search for information beyond your training data — recent events, current library versions, live API documentation.",
	'Use the current year from "Current date:" in your context when searching for recent information or documentation.',
	'After answering using search results, include a "Sources:" section listing relevant URLs as markdown hyperlinks: [Title](URL). Never skip this.',
	"Domain filtering is supported to include or block specific websites.",
	"If no API key is configured, ask the user to run /web-search-config before proceeding.",
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

	const envKey = process.env[meta.envVar]?.trim();
	if (envKey) return envKey;

	const configKey = config.apiKeys?.[providerName]?.trim();
	if (configKey) return configKey;

	if (providerName === "brave") {
		return config.apiKey?.trim() || undefined;
	}

	return undefined;
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
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const maxResults = clampSearchResultCount(params.max_results);
			const config = loadConfig();
			const providerName = config.provider ?? DEFAULT_PROVIDER_NAME;
			const apiKey = resolveProviderApiKey(providerName, config);
			const provider = createSearchProvider(providerName, apiKey ?? "");

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
			const providerName = config.provider ?? DEFAULT_PROVIDER_NAME;
			const apiKey = resolveProviderApiKey(providerName, config);
			const provider = createSearchProvider(providerName, apiKey ?? "");

			const { text: bodyText, title, contentType, contentLength } = await provider.fetch(url, raw, signal);

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
// /web-search-config command
// ---------------------------------------------------------------------------

function formatShowConfigMessage(current: WebToolsConfig): string {
	const lines = ["Web search config:", `  config file: ${CONFIG_PATH}`];

	const providerName = current.provider ?? DEFAULT_PROVIDER_NAME;
	lines.push(`  active provider: ${providerName}`);

	for (const meta of PROVIDERS) {
		const envKey = process.env[meta.envVar]?.trim();
		const configKey = current.apiKeys?.[meta.name]?.trim();
		const legacyKey = meta.name === "brave" ? current.apiKey?.trim() : undefined;
		const resolved = envKey ?? configKey ?? legacyKey;
		lines.push(
			`  ${meta.name}: ${maskApiKey(resolved)} (env: ${maskApiKey(envKey)}, config: ${maskApiKey(configKey ?? legacyKey)})`,
		);
	}

	return lines.join("\n");
}

export function registerWebSearchConfigCommand(pi: ExtensionAPI): void {
	pi.registerCommand(WEB_SEARCH_CONFIG_COMMAND_NAME, {
		description: "Configure the search provider and API key used by web_search",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui?.notify?.(`/${WEB_SEARCH_CONFIG_COMMAND_NAME} requires interactive mode`, "error");
				return;
			}

			const current = loadConfig();

			if (typeof args === "string" && args.includes(SHOW_FLAG)) {
				ctx.ui.notify(formatShowConfigMessage(current), "info");
				return;
			}

			const selectedLabel = await ctx.ui.select(
				"Search provider",
				PROVIDERS.map((p) => p.label),
				{},
			);
			if (selectedLabel === undefined || selectedLabel === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const selectedMeta = PROVIDERS.find((p) => p.label === selectedLabel);
			if (!selectedMeta) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}
			const selectedProvider = selectedMeta.name;

			const existingKey =
				current.apiKeys?.[selectedProvider] ?? (selectedProvider === "brave" ? current.apiKey : undefined);
			const input = await ctx.ui.input(
				`${selectedLabel} API key`,
				existingKey ? "(leave empty to keep existing)" : "...",
			);

			if (input === undefined || input === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const trimmed = input.trim();
			if (!trimmed) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const toSave: WebToolsConfig = {
				...current,
				provider: selectedProvider,
				apiKeys: { ...current.apiKeys, [selectedProvider]: trimmed },
			};
			delete (toSave as { apiKey?: string }).apiKey;
			saveConfig(toSave);
			ctx.ui.notify(`Saved ${selectedLabel} API key to ${CONFIG_PATH}`, "info");
		},
	});
}
