import type { FailureText } from "./messages.js";

/**
 * Shared-kernel stage error vocabulary — a package-root LEAF (zero value
 * imports; only a type-only `FailureText` pull) so
 * both the engine's loop-primitive layer (`loop-kinds.ts`) and the runner's
 * per-stage pipeline (`runner/{preflight,input-validation,failure}.ts`) can
 * throw it without anyone importing across the `runner/` boundary. It used to
 * live in `runner/errors.ts`, which made `loop-kinds.ts` (a module the runner
 * imports FROM) reach back UP into `runner/` — a layering inversion that the
 * "leaf" property masked but never removed. Homed at the root, the import
 * arrow points strictly downward for every consumer. `runner/errors.ts`
 * re-exports it so the in-`runner/` call sites keep their local spelling.
 */

/**
 * Thrown by a preflight check on failure; carries the recorded-row
 * attribution + notify/err messages so `runStageOrRecordFailure` can land
 * a uniform JSONL row regardless of which slot tripped.
 *
 * `kind` annotates the violation class for diagnostics only — control
 * flow at the catch site is uniform:
 *   - `"halt"`     — runtime-state failure (skill not registered, missing
 *                    upstream artifact, schema mismatch).
 *   - `"invariant"` — authoring-time-knowable violation that
 *                    `validateWorkflow` should reject at load. A throw
 *                    here means validation was bypassed or the rule lives
 *                    only in the runner (continue-without-pi).
 */
export class StagePreflightError extends Error {
	constructor(
		public readonly kind: "halt" | "invariant",
		public readonly skill: string,
		public readonly notifyMsg: string,
		public readonly errMsg: string,
		public readonly notifyPartial: boolean,
	) {
		super(errMsg);
		this.name = "StagePreflightError";
	}
}

// ---------------------------------------------------------------------------
// Facade constructors
// ---------------------------------------------------------------------------

/**
 * The ONE construction site — `notifyPartial` is DERIVED from `kind` (halt →
 * `true`, invariant → `false`), so a status/level mismatch is unrepresentable.
 * Modeled after `audit.ts:terminalArgsOf` (which derives `notifyLevel` from
 * `status`). Halt sites build via `haltPreflight` / `invariantPreflight` so
 * the literal `new StagePreflightError(…)` never re-appears at a call site.
 */
function preflightErrorOf(
	kind: "halt" | "invariant",
	skill: string,
	notifyMsg: string,
	errMsg: string,
): StagePreflightError {
	return new StagePreflightError(kind, skill, notifyMsg, errMsg, kind === "halt");
}

/**
 * Pattern A — runtime-state failure (skill not registered, missing upstream
 * artifact, schema mismatch). `notifyPartial: true` (the stage produced a
 * partial worth surfacing). Built from one `FailureText` so the toast/error
 * pairing lives in the `FAIL_*` factory and can't drift.
 */
export function haltPreflight(skill: string, failure: FailureText): StagePreflightError {
	return preflightErrorOf("halt", skill, failure.toast, failure.error);
}

/**
 * Pattern B — authoring-time-knowable violation that `validateWorkflow` should
 * reject at load (`continue-without-pi`, a corrupted loop cursor). A throw
 * here means validation was bypassed or the rule lives only in the runner.
 * `notifyPartial: false`. Single-message form (notifyMsg === errMsg); the
 * two-arg overload splits them (e.g. a runner wrapper that frames the user
 * message while preserving the raw `reason` as `errMsg`).
 */
export function invariantPreflight(name: string, msg: string): StagePreflightError;
export function invariantPreflight(name: string, notifyMsg: string, errMsg: string): StagePreflightError;
export function invariantPreflight(name: string, notifyMsg: string, errMsg?: string): StagePreflightError {
	return preflightErrorOf("invariant", name, notifyMsg, errMsg ?? notifyMsg);
}
