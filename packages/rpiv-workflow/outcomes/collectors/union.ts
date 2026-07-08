/**
 * Union collector — runs N collectors and concatenates their artifacts.
 *
 * Useful for the "look in transcript OR tool calls" pattern, or for
 * combining a workspace-diff scan with a transcript URL scan.
 *
 * Snapshot fanout: when any sub-collector declares a `snapshot` hook, the
 * union declares one too — it captures every sub-collector's snapshot into a
 * positional array and threads `snapshots[i]` back into sub-collector *i*'s
 * `collect`. A diff-based collector (workspace-diff, git-commit) composed
 * into a union therefore behaves exactly as it would standalone. When no
 * sub-collector snapshots, the union declares no hook (zero cost). A
 * sub-collector snapshot throw propagates to the runner's
 * `captureStageSnapshot` (which warns once and degrades the WHOLE capture to
 * `undefined`) — sub-collectors must tolerate an `undefined` snapshot, the
 * same contract they honor standalone.
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
import { throwInvalid } from "../../internal-utils.js";
import type { ArtifactCollector, CollectResult } from "../../output-spec.js";
import { defineCollector } from "../../output-spec.js";

/** Positional sub-collector snapshots; `undefined` when capture degraded or no sub declared one. */
export type UnionSnapshot = unknown[] | undefined;

export function unionCollectors(...collectors: ArtifactCollector[]): ArtifactCollector<UnionSnapshot> {
	if (collectors.length === 0) {
		throwInvalid("unionCollectors", "at least one collector is required");
	}
	const anySnapshots = collectors.some((c) => typeof c.snapshot === "function");
	return defineCollector<UnionSnapshot>({
		...(anySnapshots
			? {
					snapshot: async (ctx): Promise<unknown[]> =>
						Promise.all(collectors.map(async (c) => (c.snapshot ? await c.snapshot(ctx) : undefined))),
				}
			: {}),
		collect: async (ctx) => {
			const snapshots = Array.isArray(ctx.snapshot) ? ctx.snapshot : undefined;
			const all: Artifact[] = [];
			let lastFatalMessage: string | undefined;
			let everySubCollectorFatal = true;
			for (let i = 0; i < collectors.length; i++) {
				const c = collectors[i]!;
				const result: CollectResult = await c.collect({ ...ctx, snapshot: snapshots?.[i] });
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
