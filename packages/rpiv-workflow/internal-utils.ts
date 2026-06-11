/**
 * Internal utilities shared across the rpiv-workflow package — GENERIC
 * helpers only (error rendering, timeouts, global slots, structural
 * equality). Workflow-domain helpers live in their domain modules:
 * chain/artifact authorities in `chain-state.ts`, audit-row plumbing in
 * `audit-rows.ts`, schema-timeout signalling in `validate-output.ts`.
 *
 * Not part of the public surface — not re-exported from `index.ts`. If a
 * helper graduates into the documented authoring or embedding contract,
 * move it out of here and into the appropriate domain module.
 */

import { isAbsolute, join } from "node:path";

/** Exhaustiveness guard for discriminated-union switches. */
export function assertNever(value: never): never {
	throw new Error(`assertNever: unreachable value ${String(value)}`);
}

/**
 * Render a caught `unknown` as a human-readable message. The ONE spelling of
 * the `instanceof Error` dance — every catch block that needs the reason as a
 * string calls this instead of inlining the ternary.
 */
export function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Single source of ISO-8601 timestamps for audit rows + output meta. */
export const nowIso = (): string => new Date().toISOString();

/**
 * Create a lazily-initialised global-slot getter anchored on a `Symbol.for` key.
 * The returned function reads from `globalThis` on every call, initialising the
 * slot on first access. The indirection through `globalThis` (rather than
 * module-local state) ensures a single shared slot even when Pi loads this
 * module more than once (e.g. once for the extension entry, once via a
 * sibling's cross-package import).
 *
 * Usage: `const getRegistry = globalSlot(KEY, () => new Map());`
 * Then: `getRegistry()` returns the lazily-created Map.
 */
export function globalSlot<T>(key: symbol, init: () => T): () => T {
	return () => {
		const g = globalThis as Record<symbol, unknown>;
		let value = g[key] as T | undefined;
		if (value === undefined) {
			value = init();
			g[key] = value;
		}
		return value;
	};
}

/**
 * Race a promise against `ms`. The inner promise is NOT cancelled — Pi's
 * `ctx.waitForIdle()` has no abort signal today; the dangling promise becomes
 * inert when the next stage's `newSession` replaces the ctx.
 *
 * When `message` is a string, a plain `Error` is thrown on timeout
 * (backward-compatible). When `message` is an `Error` instance (e.g.
 * `SchemaTimeoutError` from validate-output.ts), it is thrown directly so
 * `instanceof` checks work.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string | Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(typeof message === "string" ? new Error(message) : message), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Resolve `p` against `cwd`. Returns `p` unchanged if it is already absolute;
 * otherwise joins `cwd + p` with the platform path separator. Uses
 * `path.isAbsolute` so Windows drive-letter paths are handled correctly
 * (POSIX-only `startsWith("/")` checks miss `C:\...`).
 */
export function resolveUnderCwd(cwd: string, p: string): string {
	return isAbsolute(p) ? p : join(cwd, p);
}

/**
 * Structural (key-order-independent) deep equality. Used by the
 * cross-owner collision check in `skill-contracts.ts` (later
 * `skill-contracts/registry.ts`) so two semantically-identical contracts
 * built by different code paths (or with different YAML key order) don't
 * read as divergent — `JSON.stringify` is insertion-order dependent and
 * would raise a spurious collision warning. Contracts are plain JSON data
 * (no functions/symbols/Dates), so a recursive value compare is sufficient
 * and total.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aArr = Array.isArray(a);
	const bArr = Array.isArray(b);
	if (aArr !== bArr) return false;
	if (aArr && bArr) {
		if (a.length !== b.length) return false;
		return a.every((x, i) => deepEqual(x, b[i]));
	}
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((k) => Object.hasOwn(bObj, k) && deepEqual(aObj[k], bObj[k]));
}
