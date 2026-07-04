import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { loadJsonConfigWithLegacyFallback, validateGuidanceFields } from "@juicesharp/rpiv-config";

interface TodoConfig {
	guidance?: GuidanceFields;
	maxWidgetLines?: number;
}

/** Default content-row budget when the config is missing/invalid — the prior
 *  hardcoded value, preserved as the fallback. */
export const DEFAULT_MAX_WIDGET_LINES = 12;

export function loadConfig(): TodoConfig {
	return loadJsonConfigWithLegacyFallback<TodoConfig>("rpiv-todo");
}

/** Content-row budget for the overlay, read fresh on every call (per-render —
 *  no `/reload`). Mirrors warp's getHeartbeatMs minus its `=== 0` disabled
 *  sentinel: a non-number or a value below the floor of 3 falls back to the
 *  default; no ceiling. */
export function getMaxWidgetLines(): number {
	const config = loadConfig();
	const lines = config.maxWidgetLines;
	if (typeof lines !== "number" || lines < 3) return DEFAULT_MAX_WIDGET_LINES;
	return lines;
}

export { validateGuidanceFields };
