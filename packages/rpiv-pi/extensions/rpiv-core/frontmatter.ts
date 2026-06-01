/**
 * Frontmatter utilities for rpiv-core.
 *
 * Pure functions — no ExtensionAPI, no side effects, fail-soft.
 */

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
