/**
 * Agent auto-copy — copies bundled agents into ~/.pi/agent/agents/.
 *
 * Pure utility. No ExtensionAPI interactions.
 *
 * Concurrency: NOT safe across multiple Pi sessions sharing one target dir.
 * The temp+rename atomic write in writeManifest guarantees the on-disk manifest
 * file is always a complete valid JSON (no truncated/half-written content), but
 * the read-modify-write lost-update problem remains: two sessions both reading
 * the manifest before either writes will race, and the second writer overwrites
 * the first's entries with its own stale snapshot. Advisory locking is a
 * deferred follow-up (see CHANGELOG known-limitations). The path allowlist in
 * readManifest neutralises the worst-case (arbitrary-path unlink) regardless of
 * concurrency.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseFrontmatterBounds } from "./frontmatter.js";
import { getAgentModelConfig, loadModelsConfig, type ModelsConfig } from "./models-config.js";
import { BUNDLED_AGENTS_DIR } from "./paths.js";
import { isPlainObject, toErrorMessage } from "./utils.js";

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
function emptySyncResult(): SyncResult {
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
function emptyCleanupResult(): CleanupResult {
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

// ---------------------------------------------------------------------------
// Path-traversal allowlist (hardens the manifest reader boundary)
// ---------------------------------------------------------------------------

/**
 * Allowlist for managed-agent filenames.
 *
 * Hardens the manifest reader against crafted keys that would otherwise drive
 * `readFileSync` / `unlinkSync` to a path-traversed target. Required: the value
 * must be a single basename (no separators), must not contain `..` or NUL, must
 * not be absolute, and must end in `.md`.
 */
function isManagedAgentName(name: string): boolean {
	if (typeof name !== "string" || name.length === 0) return false;
	if (name.includes("\0")) return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (name === "." || name === "..") return false;
	if (name.includes("..")) return false;
	if (isAbsolute(name)) return false;
	if (!name.endsWith(".md")) return false;
	return true;
}

/**
 * Resolve a managed-agent destination path under targetDir, asserting it stays
 * within targetDir. Defence-in-depth alongside `isManagedAgentName` — if a
 * future code path constructs a destPath without going through `readManifest`,
 * this still blocks the traversal.
 *
 * Returns `null` if the resolved path escapes `targetDir`.
 */
function safeJoin(targetDir: string, name: string): string | null {
	const resolved = resolve(targetDir, name);
	const root = resolve(targetDir) + sep;
	if (!resolved.startsWith(root)) return null;
	return resolved;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const MANIFEST_FILE = ".rpiv-managed.json";

/** Filename → sha256 hex of the content we last installed. Empty string = unknown. */
type Manifest = Record<string, string>;

function sha256(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

/**
 * Read the managed-file manifest (`Record<filename, sha256>`) from the target
 * directory. Any other shape (missing, corrupt JSON, non-object) reads as `{}`.
 *
 * Hardened against path-traversal: keys failing `isManagedAgentName` are dropped
 * silently. A subsequent `writeManifest` rewrites the on-disk manifest without
 * the rejected keys.
 *
 * Fail-soft: never throws.
 */
function readManifest(targetDir: string): Manifest {
	const manifestPath = join(targetDir, MANIFEST_FILE);
	if (!existsSync(manifestPath)) return {};
	try {
		const raw = readFileSync(manifestPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (isPlainObject(parsed)) {
			const out: Manifest = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof v === "string" && isManagedAgentName(k)) out[k] = v;
			}
			return out;
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Write the managed-file manifest to the target directory.
 * Pushes a `{ op: "manifest-write" }` SyncError on failure so consumers
 * (notifyAgentSyncDrift, /rpiv-update-agents) can surface it instead of
 * silently swallowing permission / disk-full errors.
 */
function writeManifest(targetDir: string, manifest: Manifest, result: SyncResult): void {
	const manifestPath = join(targetDir, MANIFEST_FILE);
	try {
		const ordered: Manifest = {};
		for (const k of Object.keys(manifest).sort()) ordered[k] = manifest[k];
		const content = `${JSON.stringify(ordered, null, 2)}\n`;
		// Atomic write: tmp file in same dir + renameSync (POSIX same-filesystem guarantee).
		// Prevents write-write corruption under widened concurrency (global target).
		// Pid-suffixed so concurrent sessions don't unlink each other's in-flight tmp files
		// on the failure path (see catch's unlinkSync below).
		const tmpFile = join(targetDir, `${MANIFEST_FILE}.${process.pid}.tmp`);
		try {
			writeFileSync(tmpFile, content, "utf-8");
			renameSync(tmpFile, manifestPath);
		} catch (inner) {
			try {
				unlinkSync(tmpFile);
			} catch {
				/* ignore */
			}
			throw inner;
		}
	} catch (e) {
		result.errors.push({
			op: SYNC_OP.MANIFEST_WRITE,
			message: toErrorMessage(e),
		});
	}
}

// ---------------------------------------------------------------------------
// Predicate consolidation
// ---------------------------------------------------------------------------

/**
 * Unified safety gate for destructive operations (update + remove): safe to
 * auto-apply only when the recorded hash matches the destination (we installed
 * those bytes and the user hasn't edited them). No recorded hash → gated.
 */
export function isSafeDestructiveOp(opts: { knownHash: string; destHash: string }): boolean {
	const { knownHash, destHash } = opts;
	return knownHash !== "" && destHash === knownHash;
}

// ---------------------------------------------------------------------------
// Agent Sync Engine — extracted helpers
// ---------------------------------------------------------------------------

/**
 * Step 1: Enumerate source .md files from the bundled agents directory.
 * Returns null (with error pushed) on failure.
 */
function enumerateSourceFiles(result: SyncResult): string[] | null {
	try {
		return readdirSync(BUNDLED_AGENTS_DIR).filter((f) => f.endsWith(".md"));
	} catch {
		result.errors.push({ op: SYNC_OP.READ_SRC, message: "Failed to read bundled agents directory" });
		return null;
	}
}

/**
 * Apply key-value updates to frontmatter lines.
 *
 * For each key in `keysToSet`, replaces the existing line if present
 * (within the frontmatter bounds), or inserts a new line before the
 * closing `---`. Returns the (possibly modified) lines array.
 *
 * The closing-fence index (`bounds.end`) is stable across in-place
 * replacements — only the value changes, not the line count — so the
 * insertion point remains correct without re-scanning.
 */
function applyKeyUpdates(
	lines: string[],
	bounds: { start: number; end: number },
	keysToSet: { key: string; value: string }[],
): string[] {
	const result = [...lines];
	const insertLines: string[] = [];

	for (const { key, value } of keysToSet) {
		const prefix = `${key}: `;
		const existingIdx = result.findIndex((line, i) => i > 0 && i < bounds.end && line.startsWith(prefix));
		if (existingIdx !== -1) {
			result[existingIdx] = `${prefix}${value}`;
		} else {
			insertLines.push(`${prefix}${value}`);
		}
	}

	if (insertLines.length > 0) {
		result.splice(bounds.end, 0, ...insertLines);
	}

	return result;
}

/**
 * Inject model/thinking frontmatter into agent .md content.
 *
 * Idempotent: re-injecting produces identical bytes. The function finds
 * the closing `---` of the YAML frontmatter block and inserts or replaces
 * `model:` and `thinking:` lines deterministically.
 *
 * If no override is configured for this agent, returns content unchanged.
 *
 * Exported so the idempotency invariant can be unit-tested directly:
 * `inject(inject(x)) === inject(x)` (see Verification Notes).
 */
export function injectModelFrontmatter(content: string, agentFile: string, config: ModelsConfig): string {
	// Strip .md extension — source entries are filenames like "codebase-analyzer.md"
	// but models.json keys are agent names like "codebase-analyzer".
	const agentKey = agentFile.replace(/\.md$/, "");
	const override = getAgentModelConfig(config, agentKey);
	if (!override || (override.model === undefined && override.thinking === undefined)) {
		return content;
	}

	const lines = content.split("\n");
	const bounds = parseFrontmatterBounds(lines);
	if (!bounds) return content;

	const keysToSet: { key: string; value: string }[] = [];
	// (post-slash-canonical migration): models.json values are byte-equal to
	// the agent frontmatter form (both `provider/modelId`). No translation step
	// — re-injecting produces identical bytes by construction; the idempotency
	// invariant at injectModelFrontmatter's JSDoc strengthens from "deterministic
	// translation" to "byte pass-through".
	if (override.model !== undefined) keysToSet.push({ key: "model", value: override.model });
	if (override.thinking !== undefined) keysToSet.push({ key: "thinking", value: override.thinking });

	const updated = applyKeyUpdates(lines, bounds, keysToSet);
	return updated.join("\n");
}

/**
 * Step 2: Process each source file — copy new, record unchanged, update or gate.
 * Returns the new manifest built from source entries.
 */
function processSourceEntries(
	sourceEntries: string[],
	targetDir: string,
	manifest: Manifest,
	apply: boolean,
	result: SyncResult,
): Manifest {
	const newManifest: Manifest = {};

	// Hoisted above the loop: loadModelsConfig() reads+parses JSON, so calling it
	// per-entry would re-read the file once per agent (~15×) every session_start.
	const config = loadModelsConfig();

	for (const entry of sourceEntries) {
		const src = join(BUNDLED_AGENTS_DIR, entry);
		const dest = safeJoin(targetDir, entry);
		const knownHash = manifest[entry] ?? "";
		if (dest === null) {
			result.errors.push({ file: entry, op: SYNC_OP.COPY, message: "rejected unsafe path" });
			newManifest[entry] = knownHash;
			continue;
		}

		let srcContent: Buffer;
		try {
			srcContent = readFileSync(src);
		} catch (e) {
			result.errors.push({ file: entry, op: SYNC_OP.READ_SRC, message: toErrorMessage(e) });
			newManifest[entry] = knownHash;
			continue;
		}
		// Inject configured model/thinking frontmatter BEFORE hashing so the
		// manifest hash matches what actually lands on disk (hash-after-transform).
		// injectModelFrontmatter strips .md from entry for config lookup and is a
		// no-op when no override is configured.
		const injected = injectModelFrontmatter(srcContent.toString("utf-8"), entry, config);
		const srcHash = sha256(injected);

		if (!existsSync(dest)) {
			try {
				writeFileSync(dest, injected, "utf-8");
				result.added.push(entry);
				newManifest[entry] = srcHash;
			} catch (e) {
				result.errors.push({ file: entry, op: SYNC_OP.COPY, message: toErrorMessage(e) });
				newManifest[entry] = knownHash;
			}
			continue;
		}

		let destContent: Buffer;
		try {
			destContent = readFileSync(dest);
		} catch (e) {
			result.errors.push({ file: entry, op: SYNC_OP.READ_DEST, message: toErrorMessage(e) });
			newManifest[entry] = knownHash;
			continue;
		}
		const destHash = sha256(destContent);

		if (srcHash === destHash) {
			result.unchanged.push(entry);
			newManifest[entry] = srcHash;
			continue;
		}

		if (apply || isSafeDestructiveOp({ knownHash, destHash })) {
			try {
				writeFileSync(dest, injected, "utf-8");
				result.updated.push(entry);
				newManifest[entry] = srcHash;
			} catch (e) {
				result.errors.push({ file: entry, op: SYNC_OP.COPY, message: toErrorMessage(e) });
				newManifest[entry] = knownHash;
			}
		} else {
			result.pendingUpdate.push(entry);
			newManifest[entry] = knownHash;
		}
	}

	return newManifest;
}

/**
 * Step 3A: Classify stale entries (in manifest but absent from source).
 * Returns entries to unlink; pushes pendingRemove for gated entries.
 */
function classifyStaleEntries(
	manifest: Manifest,
	sourceNames: Set<string>,
	targetDir: string,
	apply: boolean,
	newManifest: Manifest,
	result: SyncResult,
): { name: string; destPath: string }[] {
	const toUnlink: { name: string; destPath: string }[] = [];

	for (const name of Object.keys(manifest)) {
		if (sourceNames.has(name)) continue;

		const knownHash = manifest[name];
		const destPath = safeJoin(targetDir, name);
		if (destPath === null) {
			result.errors.push({ file: name, op: SYNC_OP.REMOVE, message: "rejected unsafe path" });
			continue;
		}
		if (!existsSync(destPath)) {
			// Vanished tracked file: tidy from manifest AND surface as removed.
			result.removed.push(name);
			continue;
		}

		let destContent: Buffer;
		try {
			destContent = readFileSync(destPath);
		} catch (e) {
			result.errors.push({ file: name, op: SYNC_OP.READ_DEST, message: toErrorMessage(e) });
			newManifest[name] = knownHash;
			continue;
		}
		const destHash = sha256(destContent);

		if (apply || isSafeDestructiveOp({ knownHash, destHash })) {
			toUnlink.push({ name, destPath });
		} else {
			result.pendingRemove.push(name);
			newManifest[name] = knownHash;
		}
	}

	return toUnlink;
}

/**
 * Step 3C: Commit unlink operations after the manifest is durable.
 * Re-introduces failed entries into newManifest so a future run retries.
 */
function commitStaleUnlinks(
	toUnlink: { name: string; destPath: string }[],
	manifest: Manifest,
	newManifest: Manifest,
	targetDir: string,
	result: SyncResult,
): void {
	for (const { name, destPath } of toUnlink) {
		try {
			unlinkSync(destPath);
			result.removed.push(name);
		} catch (e) {
			result.errors.push({ file: name, op: SYNC_OP.REMOVE, message: toErrorMessage(e) });
			// Re-introduce the entry into the manifest on disk so a future run retries.
			newManifest[name] = manifest[name];
		}
	}
	if (result.errors.some((e) => e.op === SYNC_OP.REMOVE)) {
		writeManifest(targetDir, newManifest, result);
	}
}

// ---------------------------------------------------------------------------
// Agent Sync Engine — orchestrator
// ---------------------------------------------------------------------------

/**
 * Synchronize bundled agents from <PACKAGE_ROOT>/agents/ into ~/.pi/agent/agents/.
 *
 * Resolution policy (apply=false, session_start):
 *   - New source files → always copied.
 *   - Existing files, dest === src → unchanged, hash recorded.
 *   - Existing files, dest ≠ src:
 *     - dest === recorded hash → auto-update (smart gate).
 *     - otherwise (no recorded hash, or dest differs from it) → pendingUpdate
 *       (gated; respects user edits).
 *   - Stale managed files: same decision applied to removal.
 *
 * apply=true (/rpiv-update-agents): force adds/updates/removes regardless of
 * recorded hash (manual override; user-edited files are overwritten).
 *
 * Atomicity: writeManifest runs BEFORE the destructive unlink loop so a crash
 * mid-sync leaves the manifest claiming files-already-removed (next run picks
 * those up via the vanish branch and reports them in result.removed).
 *
 * Never throws — errors are collected in `result.errors`.
 */
export function syncBundledAgents(apply: boolean): SyncResult {
	const result = emptySyncResult();

	if (!existsSync(BUNDLED_AGENTS_DIR)) {
		return result;
	}

	const targetDir = join(getAgentDir(), "agents");
	try {
		mkdirSync(targetDir, { recursive: true });
	} catch (e) {
		result.errors.push({
			op: SYNC_OP.MKDIR,
			message: toErrorMessage(e, "Failed to create target directory"),
		});
		return result;
	}

	// 1. Enumerate source files
	const sourceEntries = enumerateSourceFiles(result);
	if (sourceEntries === null) return result;

	const sourceNames = new Set(sourceEntries);
	const manifest = readManifest(targetDir);

	// 2. Process each source file
	const newManifest = processSourceEntries(sourceEntries, targetDir, manifest, apply, result);

	// 3. Stale-removal: Pass A (classify) → Pass B (write manifest) → Pass C (commit unlinks).
	const toUnlink = classifyStaleEntries(manifest, sourceNames, targetDir, apply, newManifest, result);

	// Pass B — persist manifest before destructive ops.
	writeManifest(targetDir, newManifest, result);

	// Pass C — commit unlinks after the manifest is durable.
	commitStaleUnlinks(toUnlink, manifest, newManifest, targetDir, result);

	return result;
}

/**
 * Clean up per-cwd agent directories from pre-global-sync installs.
 *
 * Conservative all-or-nothing gate: removes `<cwd>/.pi/agents/` only when:
 *   1. A manifest exists (we installed these files)
 *   2. Every managed file matches current source content
 *   3. No non-managed files exist in the directory
 *
 * If any check fails, the directory is left intact. Never throws — errors
 * are collected in the CleanupResult.
 */
export function cleanupPerCwdAgents(cwd: string): CleanupResult {
	const result = emptyCleanupResult();
	const perCwdDir = join(cwd, ".pi", "agents");

	if (!existsSync(perCwdDir)) return result;
	const manifest = readManifest(perCwdDir);
	if (Object.keys(manifest).length === 0) {
		// Edge state 1: no manifest (never synced by us, or hand-managed)
		result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.UNMANAGED });
		return result;
	}

	// Edge state 2: verify all managed files match current source content.
	// Hoisted config read (same reasoning as processSourceEntries): one JSON
	// read for the whole cleanup pass, not one per managed file.
	const cleanupConfig = loadModelsConfig();
	for (const [name] of Object.entries(manifest)) {
		const srcPath = safeJoin(BUNDLED_AGENTS_DIR, name);
		const destPath = safeJoin(perCwdDir, name);
		if (srcPath === null || destPath === null) {
			// Crafted manifest key would escape allowlist — treat as unmanaged.
			result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.UNMANAGED });
			return result;
		}

		let srcContent: Buffer;
		try {
			srcContent = readFileSync(srcPath);
		} catch {
			// Source file no longer exists — can't verify against bundle, treat as diverged.
			result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.DIVERGED });
			return result;
		}

		if (!existsSync(destPath)) {
			// Managed file missing from disk — user deleted it, treat as diverged.
			result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.DIVERGED });
			return result;
		}

		let destContent: Buffer;
		try {
			destContent = readFileSync(destPath);
		} catch (e) {
			// Hard failure — surface as error only (do not double-count in skipped).
			result.errors.push({ op: SYNC_OP.READ_DEST, message: toErrorMessage(e) });
			return result;
		}

		// Compare against the injected form — the dest holds injected content,
		// so comparing raw source would falsely flag every configured agent
		// as diverged. injectModelFrontmatter strips .md from name for lookup.
		const cleanupInjected = injectModelFrontmatter(srcContent.toString("utf-8"), name, cleanupConfig);
		if (sha256(destContent) !== sha256(cleanupInjected)) {
			// User edited this file — conservative gate.
			result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.DIVERGED });
			return result;
		}
	}

	// Edge state 3: check for non-managed files
	try {
		const allFiles = readdirSync(perCwdDir);
		const managedNames = new Set(Object.keys(manifest));
		for (const f of allFiles) {
			if (!managedNames.has(f) && f !== MANIFEST_FILE) {
				// Non-managed file present (user custom agent or other content)
				result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.CUSTOM_FILES });
				return result;
			}
		}
	} catch (e) {
		// Hard failure — surface as error only (do not double-count in skipped).
		result.errors.push({ op: SYNC_OP.READ_DEST, message: toErrorMessage(e) });
		return result;
	}

	// Happy path: all checks passed, safe to remove
	try {
		rmSync(perCwdDir, { recursive: true, force: true });
		result.cleanedUp.push(perCwdDir);
	} catch (e) {
		// Hard failure — surface as error only (do not double-count in skipped).
		result.errors.push({ op: SYNC_OP.REMOVE, message: toErrorMessage(e) });
	}

	return result;
}
