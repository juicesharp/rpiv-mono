import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfig, validateGuidanceFields } from "@juicesharp/rpiv-config";

const CONFIG_PATH = configPath("rpiv-ask-user-question");

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
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

function isValidCollapseKeySpec(spec: string): boolean {
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

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

export function loadConfig(): AskUserQuestionConfig {
	return loadJsonConfig<AskUserQuestionConfig>(CONFIG_PATH);
}

export { validateGuidanceFields };
