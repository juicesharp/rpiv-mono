/**
 * Frontmatter utilities for rpiv-core.
 *
 * Pure functions — no ExtensionAPI, no side effects, fail-soft.
 */

import { parse } from "yaml";

// ---------------------------------------------------------------------------
// YAML frontmatter parse
// ---------------------------------------------------------------------------

/**
 * Parse a document's YAML frontmatter into an object plus the trimmed body.
 *
 * Byte-for-byte the contract of Pi's `parseFrontmatter` (pi-coding-agent
 * `utils/frontmatter`), kept local so the built-in workflows load under hosts
 * that are not Pi (the Claude Code runner in rpiv-claude). Strips a BOM,
 * normalises CRLF/CR, requires a leading `---` and a closing `\n---`; anything
 * else yields `{ frontmatter: {}, body }`. Invalid YAML throws, as Pi's does.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = (content.startsWith("\uFEFF") ? content.slice(1) : content)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter: {}, body: normalized };
	const parsed = parse(normalized.slice(4, endIndex));
	return { frontmatter: (parsed ?? {}) as Record<string, unknown>, body: normalized.slice(endIndex + 4).trim() };
}

// ---------------------------------------------------------------------------
// Frontmatter bounds
// ---------------------------------------------------------------------------

/**
 * Find the line indices of the YAML frontmatter block in `content`.
 *
 * Returns `{ start, end }` where `start` is the 0-based line index of the
 * opening `---` and `end` is the 0-based line index of the closing `---`.
 * Returns `null` when the content has no valid frontmatter block (missing
 * opening fence, missing closing fence, or empty content).
 *
 * Takes a pre-split lines array so callers can reuse the same split for
 * both bounds detection and subsequent mutation without double-splitting.
 */
export function parseFrontmatterBounds(lines: string[]): { start: number; end: number } | null {
	if (lines[0] !== "---") return null;

	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") {
			return { start: 0, end: i };
		}
	}

	return null; // unclosed frontmatter
}

/**
 * Read the raw scalar value of `key` within the frontmatter bounds.
 *
 * Returns the trimmed text after `${key}:` on the key's own line, or
 * `undefined` when the key is absent from the block. Single-line scalars
 * only — a key whose value lives on following lines (block sequence) reads
 * as "", and callers treat that as an unmergeable form. The read
 * counterpart to applyKeyUpdates in agents.ts.
 */
export function readFrontmatterKey(
	lines: string[],
	bounds: { start: number; end: number },
	key: string,
): string | undefined {
	for (let i = bounds.start + 1; i < bounds.end; i++) {
		const line = lines[i];
		if (!line.startsWith(`${key}:`)) continue;
		return line.slice(key.length + 1).trim();
	}
	return undefined;
}
