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

/** How many turns a completed run lingers before it drops from the tree. */
export const COMPLETED_LINGER_TURNS = 1;

/** How many turns an error/aborted/steered/stopped run lingers. */
export const ERROR_LINGER_TURNS = 2;

/** Spinner animation tick in ms. TUI's 16 ms render coalescing absorbs this. */
export const TICK_MS = 80;
