/**
 * pi-compat — host-version-tolerant model services for a workflow child session.
 *
 * Pi 0.80.8 replaced `createAgentSession({ modelRegistry })` with
 * `createAgentSession({ modelRuntime })`. A newer host IGNORES the old option and
 * builds a fresh `ModelRuntime` from disk per child, so the child silently loses
 * every piece of launcher-only model state: a `pi --api-key` runtime key,
 * providers registered by `-e` CLI extensions or by launcher-only extensions,
 * and — because the default model is picked before the child's own extensions
 * register their providers — a settings default that lives on an extension
 * provider.
 *
 * The launcher's canonical runtime is not on the public extension surface: the
 * extension `ctx.modelRegistry` is a facade holding it in a runtime-private
 * `runtime` slot (0.80.8 → 1.1.x). This structural bridge reads that slot and
 * hands the SAME runtime to the child — Pi's own idiom, where every session a
 * services bundle creates shares `services.modelRuntime`. Older hosts (≤ 0.80.7)
 * have no slot and still honour `modelRegistry`, so the registry is passed
 * through verbatim. Mirrors rpiv-advisor / rpiv-btw `getRuntimeCompleteSimple`
 * — duplicated because siblings never import each other at runtime. If a future
 * host moves the slot or exposes the runtime publicly, this is the single place
 * to migrate.
 */

import type { CreateAgentSessionOptions, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The model-service option a child's `createAgentSession` call receives, typed
 * against the repo's pinned (current) SDK: `modelRuntime`. On a legacy host the
 * same slot carries `modelRegistry` instead — an option the current types no
 * longer declare, hence the cast in `childModelServices`.
 */
export type ChildModelServices = Pick<CreateAgentSessionOptions, "modelRuntime">;

/**
 * The launcher's canonical `ModelRuntime` behind the extension `ModelRegistry`
 * facade, or undefined on a host without one. Recognised structurally by the
 * `streamSimple` method `createAgentSession` drives every request through.
 * Fail-soft: a malformed/private host shape reads as "no runtime".
 */
export function getRegistryRuntime(modelRegistry: unknown): ModelRuntime | undefined {
	try {
		if (modelRegistry === null || typeof modelRegistry !== "object") return undefined;
		const runtime = (modelRegistry as { runtime?: unknown }).runtime;
		if (runtime === null || typeof runtime !== "object") return undefined;
		return typeof (runtime as { streamSimple?: unknown }).streamSimple === "function"
			? (runtime as ModelRuntime)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Share the launcher's model services with a child: its runtime on Pi ≥ 0.80.8, its registry before. */
export function childModelServices(modelRegistry: ModelRegistry): ChildModelServices {
	const modelRuntime = getRegistryRuntime(modelRegistry);
	// Legacy (≤ 0.80.7) option, absent from the pinned SDK's types.
	return modelRuntime ? { modelRuntime } : ({ modelRegistry } as unknown as ChildModelServices);
}
