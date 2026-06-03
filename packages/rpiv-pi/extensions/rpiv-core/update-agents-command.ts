/**
 * /rpiv-update-agents — apply-mode sync of bundled agents into ~/.pi/agent/agents/.
 * Also cleans up legacy per-cwd agent directories.
 * Adds new, overwrites changed managed files, removes stale managed files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupPerCwdAgents, type SyncResult, summarizeCleanupSkips, syncBundledAgents } from "./agents.js";
import { invalidateModelsConfigCache } from "./models-config.js";

const MSG_UP_TO_DATE = "All agents already up-to-date.";
const MSG_NO_CHANGES = "No changes needed.";

const msgSynced = (parts: string[]) => `Synced agents: ${parts.join(", ")}.`;
const msgSyncedWithErrors = (summary: string, errors: string[]) =>
	`${summary} ${errors.length} error(s): ${errors.join("; ")}`;

export function registerUpdateAgentsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv-update-agents", {
		description:
			"Sync rpiv-pi bundled agents into ~/.pi/agent/agents/: add new, update changed, remove stale. Also cleans up legacy per-project agent directories.",
		handler: async (_args, ctx) => {
			// Drop the session-scoped models.json cache so a mid-session edit to
			// per-agent model/thinking overrides is re-read and injected into the
			// agent frontmatter this command writes to disk. Without this, sync
			// re-injects the stale config loaded at session_start, silently
			// breaking the "/rpiv-update-agents applies edits" promise
			// (models-config.ts module doc).
			invalidateModelsConfigCache();
			const cleanup = cleanupPerCwdAgents(ctx.cwd);
			const result = syncBundledAgents(true);
			if (!ctx.hasUI) return;
			const parts: string[] = [];
			if (cleanup.cleanedUp.length > 0) parts.push(`${cleanup.cleanedUp.length} old dir(s) cleaned up`);
			if (cleanup.skipped.length > 0)
				parts.push(`${cleanup.skipped.length} old dir(s) preserved (${summarizeCleanupSkips(cleanup.skipped)})`);
			if (cleanup.errors.length > 0) parts.push(`${cleanup.errors.length} cleanup error(s)`);
			const syncReport = formatSyncReport(result);
			const fullReport = parts.length > 0 ? `${parts.join(", ")}. ${syncReport}` : syncReport;
			ctx.ui.notify(fullReport, result.errors.length + cleanup.errors.length > 0 ? "warning" : "info");
		},
	});
}

function formatSyncReport(result: SyncResult): string {
	const totalSynced = result.added.length + result.updated.length + result.removed.length;
	if (totalSynced === 0 && result.errors.length === 0) return MSG_UP_TO_DATE;

	const parts: string[] = [];
	if (result.added.length > 0) parts.push(`${result.added.length} added`);
	if (result.updated.length > 0) parts.push(`${result.updated.length} updated`);
	if (result.removed.length > 0) parts.push(`${result.removed.length} removed`);

	const summary = parts.length > 0 ? msgSynced(parts) : MSG_NO_CHANGES;
	if (result.errors.length > 0) {
		return msgSyncedWithErrors(
			summary,
			result.errors.map((e) => e.message),
		);
	}
	return summary;
}
