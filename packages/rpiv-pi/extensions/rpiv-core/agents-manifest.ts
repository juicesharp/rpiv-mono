/**
 * Agent sync — managed-file manifest (filename → sha256 of installed content).
 *
 * Layer 3 of the agents-*.ts family: builds on the allowlist (agents-allowlist)
 * and the result shapes (agents-types). Atomic tmp+rename writes keep the
 * on-disk manifest always-parseable.
 *
 * Concurrency: NOT safe across multiple Pi sessions sharing one target dir.
 * The temp+rename atomic write in writeManifest guarantees the on-disk manifest
 * file is always a complete valid JSON (no truncated/half-written content), but
 * the read-modify-write lost-update problem remains: two sessions both reading
 * the manifest before either writes will race, and the second writer overwrites
 * the first's entries with its own stale snapshot. Advisory locking is a
 * deferred follow-up. The path allowlist in
 * readManifest neutralises the worst-case (arbitrary-path unlink) regardless of
 * concurrency.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isManagedAgentName } from "./agents-allowlist.js";
import { SYNC_OP, type SyncResult } from "./agents-types.js";
import { isPlainObject, toErrorMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const MANIFEST_FILE = ".rpiv-managed.json";

/** Filename → sha256 hex of the content we last installed. Empty string = unknown. */
export type Manifest = Record<string, string>;

export function sha256(buf: Buffer | string): string {
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
export function readManifest(targetDir: string): Manifest {
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
export function writeManifest(targetDir: string, manifest: Manifest, result: SyncResult): void {
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
