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

function isValidCollapseKeySpec(spec: string): boolean {
	// Same shape as pi-coding-agent keybinding ids: lowercase modifiers (`ctrl`, `shift`,
	// `alt`, `super`) joined by `+`, then a base key. We do a light syntactic check;
	// `matchesKey` does the real matching.
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+")) return false;
	if (spec.includes("++")) return false;
	return /^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec);
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
