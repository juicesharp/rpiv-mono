/**
 * Internal utilities shared across the rpiv-workflow package.
 *
 * Not part of the public surface — not re-exported from `index.ts`. If a
 * helper graduates into the documented authoring or embedding contract,
 * move it out of here and into the appropriate domain module.
 */

import { isAbsolute, join } from "node:path";
import type { StageDef } from "./api.js";
import { type Artifact, handleToString } from "./handle.js";
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

/**
 * The single arg-projection authority: the string a stage's
 * `/skill:<name> <args>` prompt carries, derived purely from
 * (def, stageName, startStage, state). Four cases in priority order:
 *   1. The start stage receives `originalInput` (the user's brief).
 *   2. A stage opting out of inheritance (`inheritsArtifacts: false`,
 *      i.e. authored via `terminal()`) also receives `originalInput`.
 *   3. A stage with `reads: [...]` receives the labelled multi-flag form
 *      `--<name1> <handle1> --<name2> <handle2> …` — each name resolves
 *      against `state.named[name].at(-1)`; a multi-artifact entry repeats
 *      the flag.
 *   4. Otherwise: the rolling primary artifact's handle string.
 *
 * Returns `undefined` (instead of non-null-asserting) when a required
 * projection input is missing — the rolling primary is unset, or a `reads`
 * name has no published entry. The LIVE path never sees `undefined`: the
 * preflights (`ensureUpstreamArtifact` / `ensureNamedReads`) guarantee the
 * inputs before `inputForStage` delegates here. The RESUME fold freezes this
 * value at loop-generation open, where replayed state is byte-identical to
 * live loop entry (THE REPLAY CONTRACT); `undefined` there means a
 * truncated/corrupted trail and becomes a recorded refusal.
 *
 * Lives here (not runner/) so the resume fold consumes it cycle-free —
 * twin posture to `applyCompletedStage`, the other live+fold shared
 * authority.
 */
export function stageEntryArgs(
	def: StageDef,
	stageName: string,
	startStage: string,
	state: RunState,
): string | undefined {
	if (stageName === startStage) return state.originalInput;
	if (def.inheritsArtifacts === false) return state.originalInput;
	if (def.reads?.length) {
		const parts: string[] = [];
		for (const name of def.reads) {
			const latest = state.named[name]?.at(-1);
			if (!latest) return undefined;
			for (const artifact of latest.artifacts) {
				parts.push(`--${name}`, handleToString(artifact.handle));
			}
		}
		return parts.join(" ");
	}
	const primary = currentPrimaryArtifact(state);
	return primary === undefined ? undefined : handleToString(primary.handle);
}

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
