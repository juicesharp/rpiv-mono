/**
 * Detect + remove deprecated sibling package entries from
 * ~/.pi/agent/settings.json.
 *
 * Split into two phases so /rpiv-setup can preview pending changes in the
 * confirmation dialog and apply the mutation only after the user agrees:
 *
 *   findLegacySiblings()  — read-only scan; returns the entries that WOULD
 *                           be pruned. Safe to call before confirmation.
 *   pruneLegacySiblings() — mutating apply step; rewrites settings.json.
 *                           Call only after the user has confirmed.
 *
 * Both helpers are fail-soft (missing file / invalid JSON / non-object /
 * unwritable → empty result), idempotent, and have no plugin API
 * dependency.
 *
 * Background: 0.13.x → 1.0.0 upgraders may have both nicobailon's
 * pi-subagents and @tintinweb/pi-subagents in settings.json simultaneously,
 * which makes Pi reject boot with duplicate-tool registration when both
 * load. The prune is the upgrade's must-do mutation, but it must not run
 * before the user has consented to /rpiv-setup mutating settings.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEGACY_SIBLINGS } from "./siblings.js";

const PI_AGENT_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");

export interface PruneLegacySiblingsResult {
	/** settings.json `packages[]` entries that were removed (empty = no-op). */
	pruned: string[];
}

interface ParsedSettings {
	settings: Record<string, unknown>;
	packages: unknown[];
}

function readSettings(): ParsedSettings | undefined {
	if (!existsSync(PI_AGENT_SETTINGS)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(PI_AGENT_SETTINGS, "utf-8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const settings = parsed as Record<string, unknown>;
	if (!Array.isArray(settings.packages)) return undefined;
	return { settings, packages: settings.packages as unknown[] };
}

function partitionPackages(packages: unknown[]): { legacy: string[]; kept: unknown[] } {
	const legacy: string[] = [];
	const kept = packages.filter((entry) => {
		if (typeof entry !== "string") return true;
		const isLegacy = LEGACY_SIBLINGS.some((l) => l.matches.test(entry));
		if (isLegacy) legacy.push(entry);
		return !isLegacy;
	});
	return { legacy, kept };
}

/**
 * Read-only scan: returns the legacy entries that pruneLegacySiblings()
 * would remove. Does not touch the filesystem beyond reading settings.json.
 * Safe to call before any user confirmation.
 */
export function findLegacySiblings(): string[] {
	const parsed = readSettings();
	if (!parsed) return [];
	return partitionPackages(parsed.packages).legacy;
}

/**
 * Mutating apply step: rewrites settings.json with legacy entries removed.
 * Returns a structured report so callers can emit a conditional notify.
 * Never throws. Call AFTER the user has confirmed the cleanup.
 */
export function pruneLegacySiblings(): PruneLegacySiblingsResult {
	const parsed = readSettings();
	if (!parsed) return { pruned: [] };
	const { legacy, kept } = partitionPackages(parsed.packages);
	if (legacy.length === 0) return { pruned: [] };

	parsed.settings.packages = kept;
	try {
		writeFileSync(PI_AGENT_SETTINGS, `${JSON.stringify(parsed.settings, null, 2)}\n`, "utf-8");
	} catch {
		return { pruned: [] };
	}
	return { pruned: legacy };
}
