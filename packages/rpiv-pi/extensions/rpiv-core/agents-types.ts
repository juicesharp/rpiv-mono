/**
 * Agent sync — shared result types and summary helpers.
 *
 * Layer 1 of the agents-*.ts family: zero imports. The layers above
 * (agents-allowlist, agents-manifest, agents-inject, agents-sync) build on
 * these shapes; agents.ts is the public barrel over the family.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Named constants for sync operation identifiers. */
export const SYNC_OP = {
	READ_SRC: "read-src",
	READ_DEST: "read-dest",
	COPY: "copy",
	REMOVE: "remove",
	MANIFEST_WRITE: "manifest-write",
	MKDIR: "mkdir",
} as const;

/** String union derived from SYNC_OP. */
export type SyncOp = (typeof SYNC_OP)[keyof typeof SYNC_OP];

export interface SyncError {
	file?: string;
	op: SyncOp;
	message: string;
}

export interface SyncResult {
	/** New files copied (present in source, absent from destination). */
	added: string[];
	/** Existing managed files overwritten with updated source content. */
	updated: string[];
	/** Managed files whose destination content matches source exactly. */
	unchanged: string[];
	/** Stale managed files removed (present in manifest but absent from source). */
	removed: string[];
	/** Managed files with different destination content (detected but not applied). */
	pendingUpdate: string[];
	/** Managed files no longer in source (detected but not removed). */
	pendingRemove: string[];
	/** Per-file errors collected during sync. */
	errors: SyncError[];
}

/** Create an empty SyncResult with all arrays initialized. */
export function emptySyncResult(): SyncResult {
	return {
		added: [],
		updated: [],
		unchanged: [],
		removed: [],
		pendingUpdate: [],
		pendingRemove: [],
		errors: [],
	};
}

/** Discriminant for why a per-cwd directory was left intact. */
export const CLEANUP_SKIP_REASON = {
	/** No manifest present — directory was never installed by rpiv (hand-managed). */
	UNMANAGED: "unmanaged",
	/** Managed file content diverges from current bundle source (user edit, deletion, or source change). */
	DIVERGED: "diverged",
	/** Directory contains non-managed files (user added custom agents). */
	CUSTOM_FILES: "custom-files",
} as const;

export type CleanupSkipReason = (typeof CLEANUP_SKIP_REASON)[keyof typeof CLEANUP_SKIP_REASON];

export interface CleanupSkip {
	dir: string;
	reason: CleanupSkipReason;
}

export interface CleanupResult {
	/** Per-cwd agent directories successfully removed (all managed files matched source). */
	cleanedUp: string[];
	/** Directories preserved with discriminated reason — see CLEANUP_SKIP_REASON. */
	skipped: CleanupSkip[];
	/** Per-file errors collected during cleanup. */
	errors: SyncError[];
}

/** Create an empty CleanupResult with all arrays initialized. */
export function emptyCleanupResult(): CleanupResult {
	return {
		cleanedUp: [],
		skipped: [],
		errors: [],
	};
}

/**
 * Format skip counts as a comma-joined parts list ("N edited, M with custom files").
 * Shared by session_start notifyCleanup and /rpiv-update-agents handler so the
 * two consumer surfaces describe preserved directories identically.
 */
export function summarizeCleanupSkips(skipped: CleanupSkip[]): string {
	if (skipped.length === 0) return "";
	const counts: Record<CleanupSkipReason, number> = {
		unmanaged: 0,
		diverged: 0,
		"custom-files": 0,
	};
	for (const s of skipped) counts[s.reason]++;
	const parts: string[] = [];
	if (counts.unmanaged > 0) parts.push(`${counts.unmanaged} unmanaged`);
	if (counts.diverged > 0) parts.push(`${counts.diverged} with user edits`);
	if (counts["custom-files"] > 0) parts.push(`${counts["custom-files"]} with custom files`);
	return parts.join(", ");
}
