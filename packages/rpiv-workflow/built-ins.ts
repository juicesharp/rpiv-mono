/**
 * Programmatic built-in workflow registry.
 *
 * Sibling packages contribute their workflows at extension load via
 * `registerBuiltIns(...)`. The loader treats the union as the lowest layer
 * — user and project overlays still override by name.
 *
 * The runner itself ships ZERO built-in workflows. That's deliberate: this
 * package is skill-agnostic, and shipping examples that name skills the
 * user may not have installed would surface as confusing "skill not found"
 * errors. Packages like `@juicesharp/rpiv-pi` opt in by calling
 * `registerBuiltIns(...)` from their extension entry point with workflows
 * that name their own bundled skills.
 *
 * The registry array is anchored on a `Symbol.for` slot on `globalThis`.
 * Pi may load this module more than once — once for the rpiv-workflow
 * extension itself, and once via the rpiv-pi `import { registerBuiltIns }
 * from "@juicesharp/rpiv-workflow"` cross-package resolution — and
 * module-local state would be siloed between those copies.
 * `globalThis[KEY]` is process-wide and survives the dup load.
 */

import type { Workflow } from "./api.js";

const REGISTRY_KEY = Symbol.for("@juicesharp/rpiv-workflow:built-ins");
const PROVIDERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:built-in-providers");
const FLUSH_KEY = Symbol.for("@juicesharp/rpiv-workflow:built-in-flush");

/** A lazy contributor of built-in workflows — run once by `flushBuiltInProviders`. */
type BuiltInsProvider = () => void | Promise<void>;

type Global = Record<symbol, unknown>;

function getRegistry(): Workflow[] {
	const g = globalThis as unknown as Global;
	let registry = g[REGISTRY_KEY] as Workflow[] | undefined;
	if (!registry) {
		registry = [];
		g[REGISTRY_KEY] = registry;
	}
	return registry;
}

// Provider list + flush latch use the same `Symbol.for` global-slot strategy as
// the registry, so a duplicate module load shares one process-wide state.
function getProviders(): BuiltInsProvider[] {
	const g = globalThis as unknown as Global;
	let providers = g[PROVIDERS_KEY] as BuiltInsProvider[] | undefined;
	if (!providers) {
		providers = [];
		g[PROVIDERS_KEY] = providers;
	}
	return providers;
}

/**
 * Register one or more workflows into the `built-in` layer. Idempotent on
 * `Workflow.name` — re-registering an existing name replaces the prior
 * entry. Safe to call multiple times from the same extension load if the
 * extension is re-loaded by Pi's `/reload`.
 */
export function registerBuiltIns(workflows: readonly Workflow[]): void {
	const registry = getRegistry();
	for (const w of workflows) {
		const existing = registry.findIndex((r) => r.name === w.name);
		if (existing >= 0) registry[existing] = w;
		else registry.push(w);
	}
}

/**
 * Register a LAZY built-in provider. The thunk runs once on the first
 * `flushBuiltInProviders()` (which `loadWorkflows` awaits), letting a sibling
 * defer constructing its workflow definitions off startup and onto first `/wf`.
 * Register before the first read — `/wf` is the earliest reader.
 */
export function registerBuiltInsProvider(provider: BuiltInsProvider): void {
	getProviders().push(provider);
}

/**
 * Run all pending providers once, then memoize. Concurrency-safe (callers await
 * the same promise; later calls are no-ops). Providers registered after the
 * first flush won't run — acceptable, all register at extension load.
 */
export function flushBuiltInProviders(): Promise<void> {
	const g = globalThis as unknown as Global;
	const existing = g[FLUSH_KEY] as Promise<void> | undefined;
	if (existing) return existing;
	const pending = getProviders().splice(0);
	const flush = Promise.all(pending.map((p) => p())).then(() => undefined);
	g[FLUSH_KEY] = flush;
	return flush;
}

/** Read-only view of the registry — consumed by `load.ts`. */
export function getBuiltIns(): readonly Workflow[] {
	return getRegistry();
}

/**
 * Test reset (wired into repo-wide setup). Clears the registry, pending lazy
 * providers, and the flush latch so the next case starts clean.
 */
export function __resetBuiltIns(): void {
	getRegistry().length = 0;
	getProviders().length = 0;
	(globalThis as unknown as Global)[FLUSH_KEY] = undefined;
}
