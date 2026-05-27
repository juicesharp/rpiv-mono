/**
 * Session execution public surface. The runner is internally split into
 * three files (see `sessions.ts`'s header for the module map); this
 * barrel re-exports only the symbols the rest of the package consumes.
 */

export { runFanoutSession, runStageSession } from "./sessions.js";
