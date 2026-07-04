import { configPath, loadJsonConfigWithLegacyFallback } from "@juicesharp/rpiv-config";

export const CONFIG_PATH = configPath("rpiv-warp");

export interface RpivWarpConfig {
	readonly blockingTools?: readonly string[];
	readonly heartbeatMs?: number;
}

export const DEFAULT_BLOCKING_TOOLS: readonly string[] = ["ask_user_question"];
export const DEFAULT_HEARTBEAT_MS = 15000;

export function loadConfig(): RpivWarpConfig {
	return loadJsonConfigWithLegacyFallback<RpivWarpConfig>("rpiv-warp");
}

export function getHeartbeatMs(): number {
	const config = loadConfig();
	const ms = config.heartbeatMs;
	if (ms === 0) return 0; // explicitly disabled
	if (typeof ms !== "number" || ms <= 0) return DEFAULT_HEARTBEAT_MS;
	return ms;
}

export function getBlockingTools(): ReadonlySet<string> {
	const config = loadConfig();
	const list = Array.isArray(config.blockingTools) ? config.blockingTools : DEFAULT_BLOCKING_TOOLS;
	const filtered = list.filter((s): s is string => typeof s === "string" && s.length > 0);
	return new Set(filtered);
}
