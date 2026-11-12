/**
 * Path normalisation shared by every VCS reader in rpiv-core.
 *
 * Three rules live here because four readers must agree on them:
 *  - `unquoteGitPath` — git cquote-escapes a path that contains a space, a
 *    quote, a control character or a non-ASCII byte, and wraps the result in
 *    double quotes. A quoted spelling never matches a plan's `files:` entry and
 *    never resolves through `existsSync`, so every reader decodes it to the
 *    real on-disk spelling.
 *  - `isBookkeepingPath` — the run's own artifacts (`.rpiv/`) and the shared
 *    notes tree (`thoughts/`) are engine-owned bookkeeping, never the code
 *    under inspection. One predicate keeps the baseline, the WIP backup, both
 *    scope floors and the remediation digest on one universe.
 *  - `stripBookkeepingHunks` — the same predicate over a git patch, so the
 *    digest's change-text component is filtered like its status component.
 */

/** Top-level trees the run writes for itself. Never a scope violation, never
 *  pre-existing user work, never a digest input. */
export const BOOKKEEPING_DIRS: ReadonlySet<string> = new Set([".rpiv", "thoughts"]);

/** True when `path` (repo-relative, posix separators) sits under a bookkeeping tree. */
export const isBookkeepingPath = (path: string): boolean => BOOKKEEPING_DIRS.has(path.split("/")[0] ?? "");

/** git's named cquote escapes, as the byte each one stands for. */
const CQUOTE_ESCAPES: Readonly<Record<string, number>> = {
	a: 0x07,
	b: 0x08,
	f: 0x0c,
	n: 0x0a,
	r: 0x0d,
	t: 0x09,
	v: 0x0b,
	"\\": 0x5c,
	'"': 0x22,
};

/**
 * Decode one git cquote-escaped path into its on-disk spelling.
 *
 * git wraps a path in double quotes when it contains a space, a quote, a
 * control character or a non-ASCII byte, and escapes the offending bytes:
 * `\a \b \f \n \r \t \v \\ \"` for the named ones and `\ooo` (three octal
 * digits) for everything else. The octal form encodes a BYTE, so a multi-byte
 * UTF-8 character arrives as several escapes (`é` is `\303\251`) and must be
 * reassembled before it is decoded as text.
 *
 * A path that is not quoted is returned unchanged. A malformed escape is left
 * verbatim rather than throwing — a reader never fails on a path it cannot
 * parse.
 */
export const unquoteGitPath = (raw: string): string => {
	if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
	const body = raw.slice(1, -1);
	const bytes: number[] = [];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if (ch !== "\\") {
			bytes.push(...Buffer.from(ch, "utf-8"));
			continue;
		}
		const next = body[i + 1];
		if (next === undefined) {
			bytes.push(0x5c);
			break;
		}
		const named = CQUOTE_ESCAPES[next];
		if (named !== undefined) {
			bytes.push(named);
			i += 1;
			continue;
		}
		const octal = body.slice(i + 1, i + 4);
		if (/^[0-7]{3}$/.test(octal)) {
			bytes.push(parseInt(octal, 8));
			i += 3;
			continue;
		}
		// Unknown escape: keep the backslash and the character verbatim.
		bytes.push(0x5c, ...Buffer.from(next, "utf-8"));
		i += 1;
	}
	return Buffer.from(bytes).toString("utf-8");
};

/** A quoted-or-bare git path token: `"..."` with backslash escapes, or a run
 *  of non-space characters. */
const DIFF_PATH_TOKEN = String.raw`"(?:[^"\\]|\\.)*"|\S+`;

/** One `diff --git <old> <new>` section header, capturing the new side. The new
 *  side is the LAST token and may be quoted, so the pattern matches tokens
 *  rather than splitting on the last space — a quoted path can contain one. */
const DIFF_HEADER_RE = new RegExp(`^diff --git (?:${DIFF_PATH_TOKEN}) (${DIFF_PATH_TOKEN})$`);

/**
 * Drop every patch section whose path is bookkeeping. A git patch is a sequence
 * of `diff --git <old> <new>` sections; a section runs until the next header.
 * The new side names the path the digest cares about.
 */
export const stripBookkeepingHunks = (patch: string): string => {
	const kept: string[] = [];
	let keep = true;
	for (const line of patch.split("\n")) {
		const header = DIFF_HEADER_RE.exec(line);
		if (header) {
			const newSide = unquoteGitPath(header[1] ?? "");
			keep = !isBookkeepingPath(newSide.startsWith("b/") ? newSide.slice(2) : newSide);
		}
		if (keep) kept.push(line);
	}
	return kept.join("\n");
};
