/**
 * The runner's typed-throw vocabulary. The error type itself is a package-root
 * shared kernel (`../stage-errors.ts`) so the engine's loop layer can throw it
 * without importing into `runner/`; this module re-exports it so every layer of
 * the per-stage pipeline (preflights, input validation, the loop shortcut) keeps
 * its local `./errors.js` spelling and the single catch site
 * (`runStageOrRecordFailure`, run-stage.ts) catches it as before.
 */

export { haltPreflight, invariantPreflight, StagePreflightError } from "../stage-errors.js";
