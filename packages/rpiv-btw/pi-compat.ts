/**
 * Host-version-tolerant loader for pi-ai's `completeSimple`.
 *
 * Pi >= 0.80.1 moved the global dispatch API (`completeSimple` et al.) to the
 * "@earendil-works/pi-ai/compat" entrypoint; hosts <= 0.79.x export it from
 * the package root and have no /compat entrypoint at all. pi-ai resolves at
 * runtime against the HOST's copy (peerDependency "*"), so neither path can
 * be a static import — try /compat first, fall back to the root entrypoint.
 *
 * /compat is documented as temporary (deleted with pi's ModelManager
 * migration); when that lands, this module is the single place to migrate.
 */

type CompleteSimpleFn = typeof import("@earendil-works/pi-ai/compat").completeSimple;

export async function loadCompleteSimple(): Promise<CompleteSimpleFn> {
	const mod = (await import("@earendil-works/pi-ai/compat").catch(() => import("@earendil-works/pi-ai"))) as {
		completeSimple: CompleteSimpleFn;
	};
	return mod.completeSimple;
}
