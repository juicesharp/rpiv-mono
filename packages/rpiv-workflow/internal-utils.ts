/**
 * Internal utilities shared across the rpiv-workflow package.
 *
 * Not part of the public surface — not re-exported from `index.ts`. If a
 * helper graduates into the documented authoring or embedding contract,
 * move it out of here and into the appropriate domain module.
 */

import { isAbsolute, join } from "node:path";
import type { StageDef } from "./api.js";
import type { Artifact } from "./handle.js";
import type { Output } from "./output.js";
import type { RunState } from "./types.js";

/** Exhaustiveness guard for discriminated-union switches. */
export function assertNever(value: never): never {
	throw new Error(`assertNever: unreachable value ${String(value)}`);
}

/**
 * Canonical accessor for "the primary artifact the chain is currently
 * carrying." Reads the rolling slot maintained by the runner —
 * produces stages update it on success; side-effect stages leave it
 * alone. Replaces the load-bearing single-string artifact_path mirror
 * from the pre-collector shape.
 */
export function currentPrimaryArtifact(state: RunState): Artifact | undefined {
	return state.primaryArtifact;
}

/**
 * Resolve the `state.named` key a produces stage appends its `Output`
 * envelope onto. Two layers of fallback, in priority order:
 *   1. `stage.outcome?.name` — categorical name carried by the outcome.
 *   2. The stage's record key — always defined.
 *
 * Single source of truth for the key derivation so the skill-stage path
 * and the script-stage path stay in lockstep, and so `validateWorkflow`
 * can compute the same key set at load time.
 */
export function resolvePublishName(def: StageDef, stageName: string): string {
	return def.outcome?.name ?? stageName;
}

/**
 * Resolve a stage's effective skill — the contract-registry key. Twin of
 * `resolvePublishName`. Single source of truth so the runtime resolution
 * (`resolveStage`) and the load-time lookups (`validate-workflow.ts`) key the
 * registry identically and can't drift.
 */
export function resolveSkill(def: StageDef, stageName: string): string {
	return def.skill ?? stageName;
}

/** Thrown by `withTimeout` when the caller passes a `SchemaTimeoutError`
 *  instance as the message. Lets consumers distinguish timeout errors from
 *  inner-promise rejections via `instanceof` instead of string-identity
 *  comparison. */
export class SchemaTimeoutError extends Error {}

/**
 * Race a promise against `ms`. The inner promise is NOT cancelled — Pi's
 * `ctx.waitForIdle()` has no abort signal today; the dangling promise becomes
 * inert when the next stage's `newSession` replaces the ctx.
 *
 * When `message` is a string, a plain `Error` is thrown on timeout
 * (backward-compatible). When `message` is an `Error` (e.g.
 * `SchemaTimeoutError`), it is thrown directly so `instanceof` checks work.
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
 * The single authority for "a completed produces stage mutates the rolling
 * artifact state." Called by the live skill path (sessions/sessions.ts), the
 * live script path (runner/script-stage.ts), and state reconstruction
 * (runner/resume.ts) — keeping all three in lockstep (parity-tested).
 *
 * Scope: primary slot + named-publish registry ONLY. `state.output` and
 * `state.stagesCompleted` stay at call sites — `state.output` lives in the
 * shared, gated `tryRecordStage` (also serving fanout, which never advances
 * the primary), so folding it here would couple fanout to the produces rule.
 *
 *   - kind "produces"            → first artifact wins the rolling slot; the
 *                                  full Output appends onto state.named[key].
 *   - inheritsArtifacts === false → clear the slot (terminal()).
 *   - other side-effect          → leave the slot untouched.
 */
export function applyCompletedStage(state: RunState, def: StageDef, stageName: string, output: Output): void {
	if (def.kind === "produces") {
		const next = output.artifacts[0];
		if (next) state.primaryArtifact = next;
		const key = resolvePublishName(def, stageName);
		let slot = state.named[key];
		if (!slot) {
			slot = [];
			state.named[key] = slot;
		}
		slot.push(output);
		return;
	}
	if (def.inheritsArtifacts === false) {
		state.primaryArtifact = undefined;
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
