/**
 * Seed ~/.pi/agent/extensions/subagent/config.json with rpiv-pi's recommended
 * defaults (parallel.concurrency: 4, maxSubagentDepth: 3) so the concurrency
 * value is actually persistent (replaces tintinweb's in-memory-only
 * /agents → Settings overlay).
 *
 * Shallow-merge, user-values-win: existing keys at each leaf are preserved.
 * Fail-soft: invalid JSON / unwritable dir → silent no-op.
 * Pure utility — no plugin API dependency.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PI_AGENT_SUBAGENT_CONFIG = join(homedir(), ".pi", "agent", "extensions", "subagent", "config.json");

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

export interface EnsureSubagentConfigResult {
	/** True if the config file did not exist before this call. */
	created: boolean;
	/** Dotted key paths that were added in this call (empty = no-op). */
	merged: string[];
}

/**
 * Seed the subagent config file with rpiv-pi's recommended defaults when keys
 * are absent. User-set values are preserved.
 *
 * Returns a structured report for callers that want to emit a notify line.
 * Never throws.
 */
export function ensureSubagentConfig(): EnsureSubagentConfigResult {
	const existingRaw = readExisting();
	if (existingRaw.parseError) {
		return { created: false, merged: [] };
	}

	const created = existingRaw.value === null;
	const existing: Record<string, unknown> = existingRaw.value ?? {};
	const merged: string[] = [];

	const parallel =
		existing.parallel && typeof existing.parallel === "object" && !Array.isArray(existing.parallel)
			? (existing.parallel as Record<string, unknown>)
			: {};
	if (!("concurrency" in parallel)) {
		parallel.concurrency = DEFAULT_CONCURRENCY;
		merged.push("parallel.concurrency");
	}
	existing.parallel = parallel;

	if (!("maxSubagentDepth" in existing)) {
		existing.maxSubagentDepth = DEFAULT_MAX_SUBAGENT_DEPTH;
		merged.push("maxSubagentDepth");
	}

	if (merged.length === 0) {
		return { created: false, merged: [] };
	}

	writeConfig(existing);
	return { created, merged };
}

function readExisting(): {
	value: Record<string, unknown> | null;
	parseError: boolean;
} {
	if (!existsSync(PI_AGENT_SUBAGENT_CONFIG)) {
		return { value: null, parseError: false };
	}
	try {
		const raw = readFileSync(PI_AGENT_SUBAGENT_CONFIG, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { value: null, parseError: true };
		}
		return { value: parsed as Record<string, unknown>, parseError: false };
	} catch {
		return { value: null, parseError: true };
	}
}

function writeConfig(value: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(PI_AGENT_SUBAGENT_CONFIG), { recursive: true });
		writeFileSync(PI_AGENT_SUBAGENT_CONFIG, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	} catch {
		// Fail-soft — next /rpiv-setup run will retry.
	}
}
