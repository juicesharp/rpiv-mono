/**
 * Ship-manifest verification helper.
 *
 * Walks a package directory for production `.ts` files and compares them to
 * the `files` array in `package.json`. Used by `ship-manifest.test.ts` files
 * across the monorepo so every published package can prove its npm tarball
 * actually contains the modules it imports at runtime.
 *
 * Replaces the previous copy-pasted `walkProductionTs` helper in three
 * packages with one canonical implementation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "docs"]);
const SKIP_FILES = new Set(["test-fixtures.ts"]);

export interface ShipManifestResult {
	/** Entries declared in `package.json` `files`. */
	declared: readonly string[];
	/** Production `.ts` files discovered on disk (relative to packageDir). */
	onDisk: readonly string[];
	/** On-disk files NOT covered by the `files` array — these would be missing from the published tarball. */
	missing: readonly string[];
	/** `files` entries with no corresponding path on disk — ghost entries that ship nothing. */
	stale: readonly string[];
}

/**
 * Verify a package's ship manifest against its on-disk production .ts tree.
 *
 * Accepts either a directory path or a `file:` URL string (so callers can
 * pass `import.meta.url` directly — the helper resolves it to the test file's
 * parent directory).
 *
 * Skips: dotfiles/dotdirs, `node_modules`, `docs`, `*.test.ts`, `test-fixtures.ts`.
 * Does NOT check: asset directories (e.g. `locales/*.json`), `exports` map,
 * `main`/`module` fields.
 *
 * The check is two-way: `missing` flags on-disk production files the tarball
 * would omit; `stale` flags `files` entries that point at nothing on disk
 * (asset entries like `README.md` count as present — staleness is plain
 * existence, not the production-`.ts` walk). `!`-prefixed negation patterns
 * (the npm test-file exclusion glob, for instance) are exclusion rules, not
 * paths — they are skipped by both checks.
 */
export function verifyShipManifest(packageDirOrUrl: string): ShipManifestResult {
	const packageDir = packageDirOrUrl.startsWith("file:") ? dirname(fileURLToPath(packageDirOrUrl)) : packageDirOrUrl;
	const pkgRaw = readFileSync(resolve(packageDir, "package.json"), "utf8");
	const pkg = JSON.parse(pkgRaw) as { files?: string[] };
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const dirPrefixes: string[] = [];
	for (const entry of declared) {
		// `!`-prefixed entries are npm negation/exclusion patterns (the
		// test-file exclusion glob, for instance), not paths on disk — they
		// carve files OUT of the tarball rather than declaring inclusion, so
		// they neither cover an on-disk file nor count toward staleness. The
		// production-`.ts` walk already omits test files, so the common
		// test-file exclusion has no effect on the `missing` computation.
		if (entry.startsWith("!")) continue;
		// Treat trailing-slash entries AND bare directory names that exist on
		// disk as recursive directory inclusion — matches npm's own `files`
		// semantics so the test answers "would npm publish actually include this?"
		// rather than enforcing a stylistic preference. Bare dir names are
		// normalized to a trailing-slash prefix so a `"load"` entry covers
		// `load/cache.ts` without spuriously matching a sibling `loader.ts`.
		if (entry.endsWith("/")) dirPrefixes.push(entry);
		else if (isDirOnDisk(packageDir, entry)) dirPrefixes.push(`${entry}/`);
		else exactFiles.add(entry);
	}

	const onDisk = walkProductionTs(packageDir, packageDir);
	const missing = onDisk.filter((f) => !isCovered(f, exactFiles, dirPrefixes));
	const stale = declared.filter((entry) => !entry.startsWith("!") && !existsSync(resolve(packageDir, entry)));

	return { declared, onDisk, missing, stale };
}

function isDirOnDisk(packageDir: string, entry: string): boolean {
	try {
		return statSync(resolve(packageDir, entry)).isDirectory();
	} catch {
		// Entry not present on disk (e.g. an asset/extraneous `files` entry) —
		// not a directory we can recurse into; the caller treats it as an exact file.
		return false;
	}
}

function isCovered(file: string, exactFiles: Set<string>, dirPrefixes: readonly string[]): boolean {
	if (exactFiles.has(file)) return true;
	for (const prefix of dirPrefixes) {
		if (file.startsWith(prefix)) return true;
	}
	return false;
}

function walkProductionTs(root: string, dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkProductionTs(root, abs));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || SKIP_FILES.has(entry.name)) continue;
		out.push(relative(root, abs));
	}
	return out;
}
