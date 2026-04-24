/**
 * Set `subagents.disableBuiltins: true` in ~/.pi/agent/settings.json so
 * pi-subagents@0.17.5's 9 bundled agents (scout, planner, worker, reviewer,
 * context-builder, researcher, delegate, oracle, oracle-executor) don't show
 * up alongside rpiv-pi's 13 bundled specialists. The rpiv skills only
 * dispatch to the 13 specialists; keeping the builtins enabled clutters
 * `/agents`, expands the LLM's choice surface, and risks accidental
 * dispatches to unfamiliar generalists.
 *
 * User-wins: if `subagents.disableBuiltins` is already set to ANY boolean
 * (true OR false) we leave it alone. Only an absent field gets seeded.
 * Fail-soft: missing file / invalid JSON / non-object → silent no-op.
 * Pure utility — no plugin API dependency.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_AGENT_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");

export interface EnsureBuiltinsDisabledResult {
	/** True iff this call wrote `subagents.disableBuiltins: true`. */
	disabled: boolean;
}

/**
 * Seed `subagents.disableBuiltins: true` when absent. Returns a structured
 * report so the caller can emit a conditional notify. Never throws.
 */
export function ensureBuiltinsDisabled(): EnsureBuiltinsDisabledResult {
	if (!existsSync(PI_AGENT_SETTINGS)) return { disabled: false };

	let parsed: unknown;
	try {
		const raw = readFileSync(PI_AGENT_SETTINGS, "utf-8");
		parsed = JSON.parse(raw);
	} catch {
		return { disabled: false };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { disabled: false };
	}
	const settings = parsed as Record<string, unknown>;

	// User-wins: if `subagents` exists but isn't a plain object, leave it alone
	// (don't clobber user data).
	const hasSubagentsKey = "subagents" in settings;
	if (
		hasSubagentsKey &&
		(!settings.subagents || typeof settings.subagents !== "object" || Array.isArray(settings.subagents))
	) {
		return { disabled: false };
	}
	const subagents = hasSubagentsKey ? (settings.subagents as Record<string, unknown>) : {};

	if ("disableBuiltins" in subagents) {
		// User-wins: respect any explicit boolean choice (including false).
		return { disabled: false };
	}

	subagents.disableBuiltins = true;
	settings.subagents = subagents;

	try {
		writeFileSync(PI_AGENT_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	} catch {
		return { disabled: false };
	}
	return { disabled: true };
}
