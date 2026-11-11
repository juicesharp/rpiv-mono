import { execFileSync } from "node:child_process";

/** True when `cwd` is inside a jj workspace. `git` alone is not enough: a jj
 *  secondary workspace has no `.git` above it. */
export function isJjWorkspace(cwd: string, timeoutMs: number): boolean {
	try {
		execFileSync("jj", ["root"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
}

/** jj status letter → the `XY` code the porcelain parser consumes. `A` is `??`:
 *  the path did not exist in the parent commit. */
const JJ_LINE_CODES: Readonly<Record<string, string>> = { M: " M", A: "??", D: " D", R: " R", C: "??", T: " M" };

/** jj renders a rename as `R p/{a.ts => b.ts}`; the path is the new side, with
 *  the shared directory prefix left outside the braces. */
export const jjSummaryPath = (rest: string): string => rest.replace(/\{(.*?) => (.*?)\}/, "$2").trim();

/** `jj diff --summary` rewritten into the `XY <path>` grammar that
 *  `parsePorcelain` already consumes. */
export const jjSummaryToPorcelain = (raw: string): string =>
	raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => `${JJ_LINE_CODES[line[0] ?? ""] ?? " M"} ${jjSummaryPath(line.slice(1))}`)
		.join("\n");

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
 * Mirrors `unquoteGitPath` in `packages/rpiv-pi/extensions/rpiv-core/vcs-path.ts`
 * — same behaviour, separately owned by design: the two packages cannot import
 * each other (`sibling-import-graph.test.ts` blocks static sibling edges), the
 * same reason `GIT_EXEC_TIMEOUT_MS` is duplicated.
 *
 * git wraps a path in double quotes when it contains a space, a quote, a control
 * character or a non-ASCII byte, and escapes the offending bytes: `\a \b \f \n
 * \r \t \v \\ \"` for the named ones and `\ooo` (three octal digits) for
 * everything else. The octal form encodes a BYTE, so a multi-byte UTF-8 character
 * arrives as several escapes (`é` is `\303\251`) and must be reassembled before
 * it is decoded as text. A path that is not quoted is returned unchanged; a
 * malformed escape is left verbatim rather than throwing.
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
