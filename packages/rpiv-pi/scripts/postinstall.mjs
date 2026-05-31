#!/usr/bin/env node

/**
 * rpiv-pi postinstall hook — warns when the code tools overlay could not be applied.
 *
 * Runs during `pi update` (pi runs `npm install` in the git checkout after pulling).
 * When the installed version has the `-no-overlay` suffix, prints a yellow warning
 * directing the user to check the Sync Upstream workflow run.
 *
 * Exits 0 unconditionally — a no-overlay release is still usable (upstream agents
 * are restored), so the install must not fail.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(pkgRoot, "package.json");

let version;
try {
	version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
} catch {
	// Broken or missing package.json — not our problem at install time
	process.exit(0);
}

if (typeof version !== "string" || !version.endsWith("-no-overlay")) {
	process.exit(0);
}

const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

console.warn("");
console.warn(`${YELLOW}${BOLD}rpiv-pi: code tools overlay not applied${RESET}`);
console.warn(`${YELLOW}Installed version ${version} — the fork overlay failed to apply.${RESET}`);
console.warn(`${YELLOW}Agent prompts use upstream defaults (no Pi-fff / Pi-cymbal tool guidance).${RESET}`);
console.warn(`${YELLOW}Check the Sync Upstream workflow run for details:${RESET}`);
console.warn(`${YELLOW}https://github.com/spacemeld/rpiv-pi/actions${RESET}`);
console.warn("");
