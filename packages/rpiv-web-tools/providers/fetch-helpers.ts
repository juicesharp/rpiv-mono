/**
 * Shared fetch helpers — HTTP client, content-type guards, and HTML-to-text
 * extraction used by providers that wrap the built-in pipeline (Brave, Serper).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT = "Mozilla/5.0 (compatible; rpiv-pi/1.0)";
const FETCH_ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const BINARY_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/"];
const HTML_CONTENT_TYPE_TOKEN = "text/html";

// ---------------------------------------------------------------------------
// HTML-to-text extraction
// ---------------------------------------------------------------------------

const SCRIPT_BLOCK_REGEX = /<script[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_REGEX = /<style[\s\S]*?<\/style>/gi;
const NOSCRIPT_BLOCK_REGEX = /<noscript[\s\S]*?<\/noscript>/gi;
const BLOCK_CLOSER_REGEX =
	/<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav|details|summary)>/gi;
const SELF_CLOSING_BR_REGEX = /<br\s*\/?>/gi;
const ANY_REMAINING_TAG_REGEX = /<[^>]+>/g;
const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;
const NUMERIC_HTML_ENTITY_REGEX = /&#(\d+);/g;
const HORIZONTAL_WHITESPACE_RUN = /[ \t]+/g;
const BLANK_LINE_RUN = /\n{3,}/g;

function stripNonContentBlocks(html: string): string {
	return html.replace(SCRIPT_BLOCK_REGEX, "").replace(STYLE_BLOCK_REGEX, "").replace(NOSCRIPT_BLOCK_REGEX, "");
}

function convertBlockTagsToNewlines(text: string): string {
	return text.replace(BLOCK_CLOSER_REGEX, "\n").replace(SELF_CLOSING_BR_REGEX, "\n");
}

function stripRemainingTags(text: string): string {
	return text.replace(ANY_REMAINING_TAG_REGEX, " ");
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(NUMERIC_HTML_ENTITY_REGEX, (_, code) => String.fromCharCode(Number(code)));
}

function collapseWhitespace(text: string): string {
	return text.replace(HORIZONTAL_WHITESPACE_RUN, " ").replace(BLANK_LINE_RUN, "\n\n");
}

export function htmlToText(html: string): string {
	let text = stripNonContentBlocks(html);
	text = convertBlockTagsToNewlines(text);
	text = stripRemainingTags(text);
	text = decodeHtmlEntities(text);
	text = collapseWhitespace(text);
	return text.trim();
}

export function extractTitle(html: string): string | undefined {
	const match = html.match(TITLE_TAG_REGEX);
	if (!match) return undefined;
	return match[1].replace(ANY_REMAINING_TAG_REGEX, "").trim() || undefined;
}

// ---------------------------------------------------------------------------
// URL + content-type guards
// ---------------------------------------------------------------------------

export function isHtmlContentType(contentType: string): boolean {
	return contentType.includes(HTML_CONTENT_TYPE_TOKEN);
}

export function assertTextContentType(contentType: string): void {
	if (BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.includes(prefix))) {
		throw new Error(`Unsupported content type: ${contentType}. web_fetch supports text pages only.`);
	}
}

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

export function buildFetchRequestInit(signal: AbortSignal | undefined): RequestInit {
	return {
		signal,
		redirect: "follow",
		headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT_HEADER },
	};
}

export async function fetchUrlOrThrow(url: string, signal: AbortSignal | undefined): Promise<Response> {
	const res = await fetch(url, buildFetchRequestInit(signal));
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
	}
	return res;
}

export async function extractBodyAsText(
	res: Response,
	contentType: string,
	raw: boolean,
): Promise<{ text: string; title?: string }> {
	const body = await res.text();
	if (!raw && isHtmlContentType(contentType)) {
		return { text: htmlToText(body), title: extractTitle(body) };
	}
	return { text: body };
}
