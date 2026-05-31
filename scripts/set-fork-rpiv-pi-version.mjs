#!/usr/bin/env node

/**
 * Sets packages/rpiv-pi/package.json version to `{upstream-base}-{label}`.
 *
 * Used by the fork sync workflow after merging upstream:
 *   - overlay success  → 1.16.2-overlay
 *   - overlay failure  → 1.16.2-no-overlay
 *
 * Strips any existing fork suffix before applying the new label so re-runs
 * stay idempotent against the same upstream base.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const label = process.argv[2];
if (label !== "overlay" && label !== "no-overlay") {
	console.error("Usage: node scripts/set-fork-rpiv-pi-version.mjs <overlay|no-overlay>");
	process.exit(1);
}

const pkgPath = join(process.cwd(), "packages", "rpiv-pi", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const base = String(pkg.version).replace(/-(overlay|no-overlay)$/, "");
pkg.version = `${base}-${label}`;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`Set @juicesharp/rpiv-pi version to ${pkg.version}`);
