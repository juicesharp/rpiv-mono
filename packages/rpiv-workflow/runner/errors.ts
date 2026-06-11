/**
 * The runner's typed-throw vocabulary — a leaf module so every layer of the
 * per-stage pipeline (preflights, input validation, the loop shortcut) can
 * throw it and the single catch site (`runStageOrRecordFailure`,
 * stage-lifecycle.ts) can catch it without any module importing back up.
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
