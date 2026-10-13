/**
 * Agent sync — the engine.
 *
 * Layer 5 of the agents-*.ts family (top of the stack): orchestrates
 * copy/update/remove of bundled agents into ~/.pi/agent/agents/ plus the
 * legacy per-cwd cleanup. Imports only the layers above (agents-types,
 * agents-allowlist, agents-manifest, agents-inject) and the local utility
 * modules. Pure utility: no ExtensionAPI interactions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { installedExtensionNames } from "./agent-enablement.js";
import { safeJoin } from "./agents-allowlist.js";
import { type AgentInjectionContext, injectModelFrontmatter } from "./agents-inject.js";
import { MANIFEST_FILE, type Manifest, readManifest, sha256, writeManifest } from "./agents-manifest.js";
import {
	CLEANUP_SKIP_REASON,
	type CleanupResult,
	emptyCleanupResult,
	emptySyncResult,
	SYNC_OP,
	type SyncResult,
} from "./agents-types.js";
import { loadModelsConfig } from "./models-config.js";
import { findInstalledSiblings, type LoadedSiblingSources } from "./package-checks.js";
import { BUNDLED_AGENTS_DIR } from "./paths.js";
import { toErrorMessage } from "./utils.js";

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
 * Enumerate source .md files from the bundled agents directory.
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
 * Process each source file — copy new, record unchanged, update or gate.
 * Returns the new manifest built from source entries.
 */
function processSourceEntries(
	sourceEntries: string[],
	targetDir: string,
	manifest: Manifest,
	apply: boolean,
	result: SyncResult,
	loaded: LoadedSiblingSources | undefined,
): Manifest {
	const newManifest: Manifest = {};

	// Hoisted above the loop: loadModelsConfig() reads+parses JSON, so calling it
	// per-entry would re-read the file once per agent (~15×) every session_start.
	const config = loadModelsConfig();
	// One settings read per sync pass for the enablement gate. The SAME
	// context must flow into every injectModelFrontmatter call in this pass —
	// the manifest records hash-after-transform, so a gate that flipped
	// mid-pass would tear the recorded hashes and falsely flag agents
	// diverged.
	const injection: AgentInjectionContext = {
		installedExtensions: installedExtensionNames(findInstalledSiblings(loaded).map((s) => s.pkg)),
	};

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
		const injected = injectModelFrontmatter(srcContent.toString("utf-8"), entry, config, injection);
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
 * Classify stale entries (in manifest but absent from source).
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
 * Commit unlink operations after the manifest is durable.
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
 * `loaded` is the caller's one-per-pass runtime snapshot (`readLoadedSiblingSources`)
 * for the sibling enablement gate; omitted, the gate reads settings only.
 *
 * Never throws — errors are collected in `result.errors`.
 */
export function syncBundledAgents(apply: boolean, loaded?: LoadedSiblingSources): SyncResult {
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

	const sourceEntries = enumerateSourceFiles(result);
	if (sourceEntries === null) return result;

	const sourceNames = new Set(sourceEntries);
	const manifest = readManifest(targetDir);

	const newManifest = processSourceEntries(sourceEntries, targetDir, manifest, apply, result, loaded);

	const toUnlink = classifyStaleEntries(manifest, sourceNames, targetDir, apply, newManifest, result);

	// Persist the manifest before destructive ops.
	writeManifest(targetDir, newManifest, result);

	// Commit unlinks after the manifest is durable.
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
 * are collected in the CleanupResult. `loaded`: same snapshot as syncBundledAgents.
 */
export function cleanupPerCwdAgents(cwd: string, loaded?: LoadedSiblingSources): CleanupResult {
	const result = emptyCleanupResult();
	const perCwdDir = join(cwd, ".pi", "agents");

	if (!existsSync(perCwdDir)) return result;
	const manifest = readManifest(perCwdDir);
	if (Object.keys(manifest).length === 0) {
		// No manifest (never synced by us, or hand-managed)
		result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.UNMANAGED });
		return result;
	}

	// Verify all managed files match current source content.
	// Hoisted config read (same reasoning as processSourceEntries): one JSON
	// read for the whole cleanup pass, not one per managed file.
	const cleanupConfig = loadModelsConfig();
	// Same shared-gate rule as processSourceEntries: the legacy-dir comparison
	// must use one settings read for the whole pass — the identical gate a
	// sync pass with the same settings would have used.
	const cleanupInjection: AgentInjectionContext = {
		installedExtensions: installedExtensionNames(findInstalledSiblings(loaded).map((s) => s.pkg)),
	};
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
		const cleanupInjected = injectModelFrontmatter(
			srcContent.toString("utf-8"),
			name,
			cleanupConfig,
			cleanupInjection,
		);
		if (sha256(destContent) !== sha256(cleanupInjected)) {
			// User edited this file — conservative gate.
			result.skipped.push({ dir: perCwdDir, reason: CLEANUP_SKIP_REASON.DIVERGED });
			return result;
		}
	}

	// Check for non-managed files
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
