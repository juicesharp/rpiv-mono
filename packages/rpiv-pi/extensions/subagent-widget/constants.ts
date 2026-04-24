import type { ErrorStatus } from "./types.js";

export const WIDGET_KEY = "rpiv-subagents";

/** Maximum rendered lines before overflow-collapse kicks in. */
export const MAX_WIDGET_LINES = 12;

/** Braille spinner frames. Length 10 → 800 ms full cycle at 80 ms tick. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Statuses that indicate non-success — drive extended linger + error icon. */
export const ERROR_STATUSES: ReadonlySet<ErrorStatus> = new Set<ErrorStatus>([
	"error",
	"aborted",
	"steered",
	"stopped",
]);

/** How many turns a completed run lingers before it drops from the tree.
 * Advanced by both user-input boundaries (`pi.on("input")`) and orchestrator
 * agent-loop iterations (`pi.on("turn_start")`), so completed runs stay visible
 * for ~3 orchestrator turns after the last agent finishes, then auto-evict. */
export const COMPLETED_LINGER_TURNS = 3;

/** How many turns an error/aborted/steered/stopped run lingers. */
export const ERROR_LINGER_TURNS = 5;

/** Spinner animation tick in ms. TUI's 16 ms render coalescing absorbs this. */
export const TICK_MS = 80;

/** Max visible characters of the descriptor column (task text). Applied
 * identically to running + finished rows so the stats tail is never
 * truncation-clipped off the right edge regardless of terminal width. */
export const MAX_DESCRIPTOR_CHARS = 40;
