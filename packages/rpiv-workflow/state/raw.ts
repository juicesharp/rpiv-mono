/**
 * Raw file-level primitives shared by the readers (`reads.ts`) and the names
 * index (`names.ts`) — a LEAF under both, so neither re-implements the other
 * to dodge a cycle (D9: `names.ts` used to carry its own header-line parse
 * and dir scan).
 *
 * Fail-soft like the rest of `state/`: both helpers return empty/undefined
 * on any I/O or parse failure, never throw.
 */

import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { runsDir, stateFilePath } from "./paths.js";

/** Read chunk for the first-line scan. Headers are one short JSON object — one chunk almost always suffices. */
const FIRST_LINE_CHUNK = 8192;
/** Defensive cap: a "first line" longer than this is not a header we'd accept anyway. */
const FIRST_LINE_MAX = 256 * 1024;

/**
 * Parse ONLY the first JSONL line of a run file — a BOUNDED prefix read
 * (open + chunked `readSync` until the first newline), not a whole-file
 * `readFileSync`. `listRuns` calls this once per run file, so enumerating N
 * past runs costs N small reads regardless of how many stage rows each run
 * accumulated (the perf wart the old whole-file read had).
 *
 * Returns the parsed value (caller shape-checks it), or `undefined` when the
 * file is missing/empty/unparseable. The newline search is byte-level
 * (0x0A), so a multi-byte character split across chunks can't mangle the
 * line.
 */
export function readFirstJsonlLine(cwd: string, runId: string): unknown {
	let fd: number;
	try {
		fd = openSync(stateFilePath(cwd, runId), "r");
	} catch {
		return undefined;
	}
	try {
		const chunks: Buffer[] = [];
		let total = 0;
		while (total < FIRST_LINE_MAX) {
			const chunk = Buffer.alloc(FIRST_LINE_CHUNK);
			const n = readSync(fd, chunk, 0, FIRST_LINE_CHUNK, total);
			if (n <= 0) break;
			const read = chunk.subarray(0, n);
			const nl = read.indexOf(0x0a);
			if (nl >= 0) {
				chunks.push(read.subarray(0, nl));
				break;
			}
			chunks.push(read);
			total += n;
			if (n < FIRST_LINE_CHUNK) break; // EOF before any newline
		}
		const line = Buffer.concat(chunks).toString("utf-8").trim();
		if (!line) return undefined;
		return JSON.parse(line);
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * Every run id with a `<id>.jsonl` file under the runs directory, in
 * filesystem order. Empty array when the directory doesn't exist (no runs
 * yet) or is unreadable.
 */
export function enumerateRunIds(cwd: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(runsDir(cwd));
	} catch {
		return [];
	}
	return entries.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length));
}
