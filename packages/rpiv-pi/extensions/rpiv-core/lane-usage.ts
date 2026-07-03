/**
 * lane-usage — the token-usage data shape + formatting primitives shared by the
 * lane surfaces (dock tally, viewer detail header).
 *
 * Pure utility: no `ExtensionAPI`, no SDK value import. `toLaneUsage` narrows a
 * raw `SessionStats` (typed `unknown` so callers stay SDK-free) into a `LaneUsage`;
 * `formatTokens` is ported verbatim from the SDK's `footer.js:17-29` so both lane
 * surfaces render token counts in the same idiom a pi user already knows.
 *
 * The four-way breakdown keeps `cacheRead` distinct (NOT dropped) — this is the
 * footer.js semantics (`↑in ↓out R W`), not a collapsed total.
 */

/**
 * Per-unit aggregate token usage. Modeled on `SessionStats.tokens`
 * (agent-session.d.ts `SessionStats`): the required 4-way breakdown + a
 * recomputed `total` (= sum of all four), plus the scalar `cost` and the
 * context-window-fill `percent` carried through from `SessionStats` for the
 * viewer's optional `CH%` rendering.
 */
export interface LaneUsage {
	/** Prompt tokens billed across the unit's turns (`SessionStats.tokens.input`). */
	input: number;
	/** Completion tokens billed across the unit's turns (`SessionStats.tokens.output`). */
	output: number;
	/** Cached-prompt tokens read — shown as a distinct `R` segment, NOT dropped
	 *  (`SessionStats.tokens.cacheRead`). */
	cacheRead: number;
	/** Tokens written to cache this turn (`SessionStats.tokens.cacheWrite`). */
	cacheWrite: number;
	/** `input + output + cacheRead + cacheWrite` (`SessionStats.tokens.total`). */
	total: number;
	/** Scalar cost, USD (`SessionStats.cost`). Optional — surfaced when present. */
	cost?: number;
	/** Context-window fill %, or `null` if unknown post-compaction
	 *  (`SessionStats.contextUsage.percent`). Optional — Slice 3 renders `CH%`. */
	percent?: number | null;
}

/** A minimal structural view of `SessionStats.tokens` + scalar `cost` + nested
 *  `contextUsage.percent`, used only for defensive narrowing. Typed loose so the
 *  module imports no SDK type. */
interface StatsShape {
	tokens?: {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		total?: unknown;
	};
	cost?: unknown;
	contextUsage?: { percent?: unknown };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Narrow a raw `SessionStats` (typed `unknown` to keep callers SDK-free) into a
 * `LaneUsage`. Defensive: a missing or malformed `tokens` (or non-finite fields)
 * returns `undefined` — callers treat that as "no usage captured". `cost` and
 * `percent` are threaded only when present and finite; `total` is taken from the
 * source when finite, else recomputed from the four parts.
 */
export function toLaneUsage(stats: unknown): LaneUsage | undefined {
	if (typeof stats !== "object" || stats === null) return undefined;
	const s = stats as StatsShape;
	const t = s.tokens;
	if (typeof t !== "object" || t === null) return undefined;
	const input = t.input;
	const output = t.output;
	const cacheRead = t.cacheRead;
	const cacheWrite = t.cacheWrite;
	if (!isFiniteNumber(input) || !isFiniteNumber(output) || !isFiniteNumber(cacheRead) || !isFiniteNumber(cacheWrite)) {
		return undefined;
	}
	const usage: LaneUsage = { input, output, cacheRead, cacheWrite, total: t.total as number };
	if (!isFiniteNumber(usage.total)) usage.total = input + output + cacheRead + cacheWrite;
	if (isFiniteNumber(s.cost)) usage.cost = s.cost;
	const percent = s.contextUsage?.percent;
	if (percent === null || isFiniteNumber(percent)) usage.percent = percent as number | null;
	return usage;
}

/**
 * Format a token count in pi's footer idiom — ported verbatim from the SDK's
 * `footer.js:17-29` (`formatTokens`): `<1e3` bare · `<1e4` `N.Nk` · `<1e6`
 * `round(k)k` · `<1e7` `N.NM` · else `round(M)M`. Both lane surfaces render token
 * counts through this so they match the footer a pi user already sees.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
