import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { SearchProvider, SearchResponse, SearchResult } from "./types.js";

const PARALLEL_SEARCH_MCP_URL = "https://search.parallel.ai/mcp";
// Identify this project so Parallel can measure aggregate free MCP usage.
// Keep the value project-wide; do not add user or installation identifiers.
const PACKAGE_VERSION = (
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
const PROJECT_USER_AGENT = `rpiv-web-tools/${PACKAGE_VERSION}`;

function toKeywordQuery(query: string): string {
	const words = query.trim().split(/\s+/u).filter(Boolean).slice(0, 6);
	for (const fallbackWord of ["web", "search", "results"]) {
		if (words.length >= 3) break;
		words.push(fallbackWord);
	}
	return words.join(" ");
}

export const PARALLEL_PROVIDER_META = {
	name: "parallel",
	label: "Parallel",
	roles: ["search"] as const,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResult(value: unknown): SearchResult | undefined {
	if (!isRecord(value) || typeof value.url !== "string") return undefined;

	let url: URL;
	try {
		url = new URL(value.url);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

	const excerpts = Array.isArray(value.excerpts)
		? value.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string" && excerpt.length > 0)
		: [];
	const snippet = excerpts.join(" ") || (typeof value.snippet === "string" ? value.snippet : "");
	const title = typeof value.title === "string" && value.title.length > 0 ? value.title : value.url;

	return { title, url: value.url, snippet };
}

function normalizeResults(value: unknown): SearchResult[] {
	if (!isRecord(value) || !Array.isArray(value.results)) {
		throw new Error("Parallel Search MCP returned an unexpected web_search result.");
	}

	const results = value.results.map(normalizeResult).filter((result): result is SearchResult => result !== undefined);
	if (value.results.length > 0 && results.length === 0) {
		throw new Error("Parallel Search MCP returned no results with valid HTTP URLs.");
	}
	return results;
}

function toolErrorMessage(content: unknown): string {
	if (!Array.isArray(content)) return "Parallel Search MCP web_search failed.";
	const text = content
		.filter(
			(item): item is { type: "text"; text: string } =>
				isRecord(item) && item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
	return text || "Parallel Search MCP web_search failed.";
}

export class ParallelProvider implements SearchProvider {
	readonly name = PARALLEL_PROVIDER_META.name;
	readonly label = PARALLEL_PROVIDER_META.label;

	async search(query: string, maxResults: number, signal?: AbortSignal, sessionId?: string): Promise<SearchResponse> {
		if (signal?.aborted) throw signal.reason ?? new Error("Parallel Search MCP request was aborted.");

		const client = new Client({ name: "rpiv-web-tools", version: PACKAGE_VERSION });
		const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_SEARCH_MCP_URL), {
			requestInit: { headers: { "User-Agent": PROJECT_USER_AGENT } },
		});

		try {
			await client.connect(transport);
			if (signal?.aborted) throw signal.reason ?? new Error("Parallel Search MCP request was aborted.");

			const result = await client.callTool(
				{
					name: "web_search",
					arguments: {
						objective: query,
						search_queries: [toKeywordQuery(query)],
						...(sessionId && sessionId.length <= 100 ? { session_id: sessionId } : {}),
					},
				},
				signal ? { signal } : undefined,
			);
			if (result.isError) throw new Error(toolErrorMessage(result.content));

			const results = normalizeResults(result.structuredContent).slice(0, maxResults);
			return { query, results };
		} finally {
			await transport.terminateSession().catch(() => undefined);
			await client.close().catch(() => undefined);
		}
	}
}
