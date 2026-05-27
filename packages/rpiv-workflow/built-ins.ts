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

/** Read-only view of the registry — consumed by `load.ts`. */
export function getBuiltIns(): readonly Workflow[] {
	return getRegistry();
}

/**
 * Test reset. Wired into the repo-wide test setup so cross-test
 * registration leaks don't bias the next case.
 */
export function __resetBuiltIns(): void {
	getRegistry().length = 0;
}
