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
 * The abort marker the detached-execution runtime throws when a child session is
 * aborted (run-level Ctrl-C or a fail-fast sibling halt). `session.abort()` makes
 * the SDK `prompt()` RESOLVE with a `stopReason:"aborted"` message (it does NOT
 * reject), so the runtime detects that stop and
 * throws THIS before any audit row is written: the fold's `isAbortError` check
 * then leaves the slot unfilled so resume re-dispatches the unit.
 *
 * `name` is "WorkflowAbortError" — deliberately NOT "AbortError" — so it never
 * collides with the DOM/third-party `AbortError` thrown by unrelated aborts;
 * `isAbortError` is `instanceof`-based (not name-based) for the same reason.
 */
export class WorkflowAbortError extends Error {
	constructor(message = "aborted") {
		super(message);
		this.name = "WorkflowAbortError";
	}
}

export const isAbortError = (e: unknown): e is WorkflowAbortError => e instanceof WorkflowAbortError;

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
 * Register-providers / flush-on-demand lifecycle over global slots —
 * the shared structure behind `registerBuiltInsProvider`/`flushBuiltInProviders`
 * and their skill-contract twins, which were implemented twice near
 * line-for-line. The one real divergence — error posture — is the
 * `onError` parameter: when given, each provider throw is RECORDED via the
 * callback (the registry stays usable, the caller drains and surfaces);
 * when omitted, a throw rejects the flush promise (trusted in-process
 * providers).
 *
 * Flush semantics: each provider runs AT MOST ONCE, but the flush is not a
 * one-shot process latch — providers registered after a flush run on the
 * NEXT flush, chained after everything that already ran. This is what makes
 * `/reload` work: Pi re-runs extension entries (which re-register their
 * providers) while these slots survive on `globalThis`; the next consumer
 * read then flushes the re-registered providers, so owner-scoped
 * registrations refresh (the contract registry's prune-on-reload semantics
 * depend on this).
 *
 * State (provider list + flush chain) is anchored on `Symbol.for` slots
 * derived from `key`, so a duplicate module load shares one process-wide
 * lifecycle — same rationale as `globalSlot` itself. The chain is a mutable
 * box because the slot value must never be reset to `undefined` (globalSlot
 * would re-init), only its contents.
 */
export interface LazyProviderRegistry {
	/** Register a lazy thunk — runs once, on the next `flush()`. */
	register(provider: () => void | Promise<void>): void;
	/**
	 * Run every not-yet-run provider, chained after prior flushes; memoized
	 * when nothing new is pending. Concurrency-safe (callers await the same
	 * promise; a provider registered mid-flight runs on the next call). A
	 * provider throw (no-onError variant) rejects only that flush — later
	 * registrations run on subsequent flushes.
	 */
	flush(): Promise<void>;
	/** Test reset: clears pending providers and the flush chain. */
	reset(): void;
}

export function lazyProviderRegistry(key: string, opts?: { onError: (err: unknown) => void }): LazyProviderRegistry {
	type Provider = () => void | Promise<void>;
	const getProviders = globalSlot(Symbol.for(`${key}:providers`), () => [] as Provider[]);
	const getFlushBox = globalSlot(Symbol.for(`${key}:flush`), () => ({
		flushed: undefined as Promise<void> | undefined,
	}));
	const onError = opts?.onError;
	return {
		register(provider) {
			getProviders().push(provider);
		},
		flush() {
			const box = getFlushBox();
			const pending = getProviders().splice(0);
			if (pending.length === 0) return box.flushed ?? Promise.resolve();
			const run = () =>
				Promise.all(
					pending.map((p) => {
						const r = Promise.resolve().then(p);
						return onError ? r.catch(onError) : r;
					}),
				).then(() => undefined);
			// Chain after the prior flush — settled either way — so registration
			// order is preserved across reload generations and a rejection (no-
			// onError variant) only fails the callers awaiting THAT flush; later
			// registrations still run, so `/reload` can recover from a bad provider.
			box.flushed = box.flushed ? box.flushed.then(run, run) : run();
			return box.flushed;
		},
		reset() {
			getProviders().length = 0;
			getFlushBox().flushed = undefined;
		},
	};
}

/**
 * Race a promise against `ms`. The inner promise is NOT cancelled — Pi's
 * `ctx.waitForIdle()` has no abort signal today; the dangling promise becomes
 * inert once the child session it was waiting on is disposed.
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
 * cross-owner collision check in `skill-contracts/registry.ts`
 * so two semantically-identical contracts
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
