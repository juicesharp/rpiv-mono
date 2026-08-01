import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { loadJsonConfigWithLegacyFallback, validateGuidanceFields } from "@juicesharp/rpiv-config";

interface TodoConfig {
	guidance?: GuidanceFields;
	maxWidgetLines?: number;
	/**
	 * Key spec for the overlay collapse/expand shortcut, in the same format as
	 * pi-coding-agent keybinding ids (`modifier+key`, e.g. `ctrl+shift+t`, `alt+o`).
	 * Defaults to `"ctrl+shift+t"`. Pass `"off"` to disable the collapse shortcut
	 * entirely. Validation happens in `resolveCollapseKey`, not at load.
	 */
	collapseKey?: string;
	/**
	 * Whether completed rows leave the overlay at the next agent turn or remain
	 * available for the session. Validation happens in `getCompletedTaskVisibility`.
	 */
	completedTaskVisibility?: string;
	/** Maximum number of the newest contiguous completed rows kept expanded in
	 * session mode. Older rows remain available through the fold control. */
	maxVisibleCompleted?: number;
	/** Key spec for expanding or collapsing folded completed rows in session mode.
	 * Pass `"off"` to keep every completed row expanded. */
	completedCollapseKey?: string;
}

/** Default content-row budget when the config is missing/invalid — the prior
 *  hardcoded value, preserved as the fallback. */
export const DEFAULT_MAX_WIDGET_LINES = 12;

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+shift+t"` or `"alt+o"`. */
export type CollapseKeySpec = string;

/** Default collapse/expand key when `collapseKey` is missing/empty/blank/invalid. */
export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+shift+t";

/** Sentinel value for `collapseKey` that disables the collapse shortcut entirely. */
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

/** Visibility policy for completed rows in the overlay. */
export type CompletedTaskVisibility = "turn" | "session";

/** Preserve the existing behavior unless the user explicitly opts into session visibility. */
export const DEFAULT_COMPLETED_TASK_VISIBILITY: CompletedTaskVisibility = "turn";

/** Number of newest contiguous completed rows shown before older rows fold. */
export const DEFAULT_MAX_VISIBLE_COMPLETED = 5;
export function loadConfig(): TodoConfig {
	return loadJsonConfigWithLegacyFallback<TodoConfig>("rpiv-todo");
}

/** Content-row budget for the overlay, read fresh on every call (per-render —
 * no `/reload`). Mirrors warp's getHeartbeatMs minus its `=== 0` disabled
 * sentinel: a non-number or a value below the floor of 3 falls back to the
 * default; no ceiling. */
export function getMaxWidgetLines(): number {
	const config = loadConfig();
	const lines = config.maxWidgetLines;
	if (typeof lines !== "number" || lines < 3) return DEFAULT_MAX_WIDGET_LINES;
	return lines;
}

/**
 * Read the completed-row policy fresh for every agent turn. Invalid values keep
 * the existing compact-overlay behavior, so config typos cannot make completion
 * history unexpectedly consume editor space.
 */
export function getCompletedTaskVisibility(): CompletedTaskVisibility {
	const visibility = loadConfig().completedTaskVisibility;
	return visibility === "session" ? "session" : DEFAULT_COMPLETED_TASK_VISIBILITY;
}

/** Maximum number of newest contiguous completed rows shown in session mode.
 * Invalid values fall back to the default; zero explicitly folds the whole
 * completed prefix while keeping it available through the expansion shortcut. */
export function getMaxVisibleCompleted(): number {
	const value = loadConfig().maxVisibleCompleted;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: DEFAULT_MAX_VISIBLE_COMPLETED;
}
// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** Validate a collapse-key spec against pi-tui's KeyId grammar (verbatim port from
 *  rpiv-ask-user-question). Exported for unit tests. */
export function isValidCollapseKeySpec(spec: string): boolean {
	// Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
	// base key that is a single printable character or a named special key. A loose
	// check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
	// and ignores unknown parts, so a typo like `ctr+]` would silently match every
	// bare `]` keypress (and the raw terminal listener would consume them globally).
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

/** Resolve a configured collapse key. The caller chooses the fallback, allowing
 * both overlay controls to share the same strict grammar and `"off"` sentinel. */
function resolveConfiguredCollapseKey(rawValue: unknown, fallback: CollapseKeySpec): CollapseKeySpec {
	const raw = typeof rawValue === "string" ? rawValue.trim().toLowerCase() : undefined;
	if (raw === undefined || raw === "") return fallback;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : fallback;
}

/** Resolve the whole-overlay collapse key. Read fresh per render/registration; a
 * `/reload` remains necessary to rebind the registered shortcut. */
export function resolveCollapseKey(): CollapseKeySpec {
	return resolveConfiguredCollapseKey(loadConfig().collapseKey, DEFAULT_COLLAPSE_KEY);
}

/** Default shortcut for expanding and collapsing folded completed rows. */
export const DEFAULT_COMPLETED_COLLAPSE_KEY: CollapseKeySpec = "ctrl+shift+c";

/** Resolve the completed-row fold shortcut. `"off"` keeps all completed rows
 * expanded, and a collision with `collapseKey` is resolved by the extension at
 * registration time so one key never controls two widget states. */
export function resolveCompletedCollapseKey(): CollapseKeySpec {
	return resolveConfiguredCollapseKey(loadConfig().completedCollapseKey, DEFAULT_COMPLETED_COLLAPSE_KEY);
}

export { validateGuidanceFields };
