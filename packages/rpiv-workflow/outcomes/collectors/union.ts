/**
 * Union collector — runs N collectors and concatenates their artifacts.
 *
 * Useful for the "look in transcript OR tool calls" pattern, or for
 * combining a workspace-diff scan with a transcript URL scan. The
 * sub-collectors run sequentially; their `snapshot` hooks are NOT
 * threaded (each collector gets its own snapshot only if it declares
 * one and is invoked through `OutputSpec.collector` directly — wrapping
 * collectors inside a union loses individual snapshots today).
 *
 * Fatal policy: `unionCollectors` returns `fatal` only when EVERY
 * sub-collector returned fatal (carries the last fatal message for
 * diagnostics). One success is enough for the union to succeed —
 * matches the "any of these channels produced the artifact" mental
 * model the union represents.
 *
 * Empty artifact list from one sub-collector is treated as `ok` (it
 * just contributes nothing to the concatenation). The union itself
 * returns `ok` with the merged list; the runner's
 * `enforceCompletionContract` decides whether an empty merged list is
 * a halt (produces) or a pass-through (side-effect).
 */

import type { Artifact } from "../../handle.js";
import type { ArtifactCollector, CollectResult } from "../../output-spec.js";
import { defineCollector } from "../../output-spec.js";

export function unionCollectors(...collectors: ArtifactCollector[]): ArtifactCollector {
	if (collectors.length === 0) {
		throw new Error("unionCollectors: at least one collector is required");
	}
	return defineCollector({
		collect: async (ctx) => {
			const all: Artifact[] = [];
			let lastFatalMessage: string | undefined;
			let everySubCollectorFatal = true;
			for (const c of collectors) {
				const result: CollectResult = await c.collect(ctx);
				if (result.kind === "fatal") {
					lastFatalMessage = result.message;
					continue;
				}
				everySubCollectorFatal = false;
				all.push(...result.artifacts);
			}
			if (everySubCollectorFatal) {
				return {
					kind: "fatal",
					message: lastFatalMessage ?? `${ctx.skill}: unionCollectors had no successful sub-collector`,
				};
			}
			return { kind: "ok", artifacts: all };
		},
	});
}
