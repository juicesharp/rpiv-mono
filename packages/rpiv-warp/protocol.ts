/**
 * rpiv-warp — Warp terminal detection + protocol negotiation.
 *
 * Pure functions only. No module-level mutable state. Each function does
 * one thing; `detectWarpEnvironment` is the composition site.
 *
 * Env vars consulted (read fresh on every call — no cache):
 *   TERM_PROGRAM                       — must be "WarpTerminal"
 *   WARP_CLI_AGENT_PROTOCOL_VERSION    — required for structured emission
 *   WARP_CLIENT_VERSION                — used for per-channel broken-version gating
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured event names emitted in the OSC 777 payload's `event` field. */
export type WarpEvent = "session_start" | "stop" | "idle_prompt" | "tool_complete";

/** Warp release channel — present in every `WARP_CLIENT_VERSION` literal. */
export type Channel = "stable" | "preview" | "dev";

/** Parsed version components: [year, month, day, hour, minute, rev, seq]. */
export type VersionTuple = readonly [number, number, number, number, number, number, number];

export interface ParsedWarpVersion {
	readonly tuple: VersionTuple;
	readonly channel: Channel;
}

export interface WarpEnvironment {
	readonly isWarp: boolean;
	readonly supportsStructured: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Highest protocol version this plugin can speak. The plugin clamps
 * client-side via `negotiateProtocolVersion()` and emits the agreed `v`
 * in every payload, so an older Warp that only speaks v:1 keeps seeing v:1
 * even after we bump this constant.
 */
export const PLUGIN_MAX_PROTOCOL_VERSION = 1;

/**
 * Last broken Warp build per channel. Builds at-or-below the threshold
 * advertise structured-protocol support but render notifications behind a
 * feature flag — gate them off until users upgrade.
 */
export const BROKEN_VERSIONS: Record<Channel, VersionTuple | null> = {
	stable: [2026, 3, 25, 8, 24, 5, 5],
	preview: [2026, 3, 25, 8, 24, 5, 5],
	dev: null,
};

const VERSION_RE = /^v0\.(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(stable|preview|dev)_(\d+)$/;

// ---------------------------------------------------------------------------
// Env-var primitives — each reads exactly one variable
// ---------------------------------------------------------------------------

export function isWarpTerminal(): boolean {
	return process.env.TERM_PROGRAM === "WarpTerminal";
}

export function hasStructuredProtocol(): boolean {
	const v = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	return typeof v === "string" && v.length > 0;
}

export function readClientVersion(): string | undefined {
	const v = process.env.WARP_CLIENT_VERSION;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Client-side protocol-version clamp.
 *
 * Returns min(WARP_CLI_AGENT_PROTOCOL_VERSION, PLUGIN_MAX_PROTOCOL_VERSION).
 * Falls back to PLUGIN_MAX_PROTOCOL_VERSION when the env var is missing,
 * empty, or unparseable — matches reference (warpdotdev/opencode-warp
 * src/payload.ts).
 *
 * Pure: env-var reads on every call, no caching, safe under env mutation
 * in tests (research §Q5 contract).
 */
export function negotiateProtocolVersion(): number {
	const raw = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	const warpVersion = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (Number.isNaN(warpVersion)) return PLUGIN_MAX_PROTOCOL_VERSION;
	return Math.min(warpVersion, PLUGIN_MAX_PROTOCOL_VERSION);
}

// ---------------------------------------------------------------------------
// Version parsing — pure, regex-driven
// ---------------------------------------------------------------------------

export function parseWarpVersion(raw: string | undefined): ParsedWarpVersion | null {
	if (!raw) return null;
	const m = VERSION_RE.exec(raw);
	if (!m) return null;
	const tuple: VersionTuple = [
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
		Number(m[4]),
		Number(m[5]),
		Number(m[7]),
		Number(m[7]),
	];
	return { tuple, channel: m[6] as Channel };
}

/** Element-wise `≤` over fixed-length tuples. Returns true on equal. */
export function tupleLeq(a: VersionTuple, b: VersionTuple): boolean {
	for (let i = 0; i < a.length; i++) {
		if (a[i] < b[i]) return true;
		if (a[i] > b[i]) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Broken-version gate
// ---------------------------------------------------------------------------

export function isBrokenVersion(parsed: ParsedWarpVersion | null): boolean {
	if (!parsed) return false;
	const threshold = BROKEN_VERSIONS[parsed.channel];
	if (threshold === null) return false;
	return tupleLeq(parsed.tuple, threshold);
}

// ---------------------------------------------------------------------------
// Composition — one assembly site for the structured-mode predicate
// ---------------------------------------------------------------------------

export function supportsStructured(): boolean {
	if (!hasStructuredProtocol()) return false;
	const parsed = parseWarpVersion(readClientVersion());
	return !isBrokenVersion(parsed);
}

export function detectWarpEnvironment(): WarpEnvironment {
	const isWarp = isWarpTerminal();
	if (!isWarp) return { isWarp: false, supportsStructured: false };
	return { isWarp: true, supportsStructured: supportsStructured() };
}
