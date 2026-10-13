/**
 * Agent sync — path-traversal allowlist.
 *
 * Layer 2 of the agents-*.ts family: imports only node:path. Hardens the
 * manifest reader boundary (agents-manifest) and the destination-path
 * construction in the sync engine (agents-sync).
 */

import { isAbsolute, resolve, sep } from "node:path";

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
export function isManagedAgentName(name: string): boolean {
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
export function safeJoin(targetDir: string, name: string): string | null {
	const resolved = resolve(targetDir, name);
	const root = resolve(targetDir) + sep;
	if (!resolved.startsWith(root)) return null;
	return resolved;
}
