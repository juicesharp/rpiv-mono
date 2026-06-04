/**
 * Guarded registration of rpiv-pi's built-in workflows into the
 * `@juicesharp/rpiv-workflow` runtime registry.
 *
 * rpiv-workflow is a SIBLING (see siblings.ts) — a peerDependency that a clean
 * `npm install @juicesharp/rpiv-pi` does NOT pull in; users add it via
 * /rpiv-setup. So rpiv-core must never statically import it: a top-level
 * `import … from "@juicesharp/rpiv-workflow"` makes the WHOLE extension fail to
 * load when the sibling is absent, which in turn suppresses the very
 * /rpiv-setup command and missing-sibling banner that tell the user to install
 * it — a chicken-and-egg that strands clean installs.
 *
 * The dependency is therefore deferred behind a dynamic import so the entry
 * point has no static edge to the peer. When rpiv-workflow is absent we simply
 * skip registration: the built-ins are consumed only by the `/wf` command,
 * which lives in rpiv-workflow itself, so there is nothing to lose. This keeps
 * rpiv-core aligned with the "no runtime import of sibling packages" rule the
 * other siblings already follow (siblings.ts header).
 */

import { isModuleNotFound } from "./utils.js";

/**
 * Register the five built-in workflows (ship / build / arch / vet / polish)
 * with the rpiv-workflow runtime, if that sibling is installed. A missing
 * sibling resolves to a no-op; any other failure is re-thrown so genuine bugs
 * surface rather than hiding behind the absent-sibling path.
 */
export async function registerBuiltInWorkflows(): Promise<void> {
	try {
		// Thin `/startup` entry (~9ms, no DSL/runner). Register a LAZY provider so
		// `built-in-workflows.js` (the ~180ms authoring-DSL graph) builds the five
		// definitions on first `/wf`, not at startup. Missing sibling →
		// ERR_MODULE_NOT_FOUND → no-op (no `/wf` without it).
		const { registerBuiltInsProvider, registerBuiltIns } = await import("@juicesharp/rpiv-workflow/startup");
		registerBuiltInsProvider(async () => {
			const { builtInWorkflows } = await import("./built-in-workflows.js");
			registerBuiltIns(builtInWorkflows);
		});
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup prompts the user
		throw err;
	}
}
