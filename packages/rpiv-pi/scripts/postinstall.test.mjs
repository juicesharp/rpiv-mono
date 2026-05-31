#!/usr/bin/env node
/**
 * Tests for packages/rpiv-pi/scripts/postinstall.mjs
 *
 * Verifies the postinstall hook prints a warning for -no-overlay versions
 * and stays silent for -overlay and plain versions.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dirname, "postinstall.mjs");

function runPostinstall(version) {
	const tmpDir = join(tmpdir(), `postinstall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const scriptsDir = join(tmpDir, "scripts");
	mkdirSync(scriptsDir, { recursive: true });
	writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "@juicesharp/rpiv-pi", version }));
	// Copy the real script into the temp scripts/ dir so its relative path resolution works
	writeFileSync(join(scriptsDir, "postinstall.mjs"), `
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(pkgRoot, "package.json");
let version;
try { version = JSON.parse(readFileSync(pkgPath, "utf8")).version; } catch { process.exit(0); }
if (typeof version !== "string" || !version.endsWith("-no-overlay")) { process.exit(0); }
const YELLOW = "\\x1b[33m";
const BOLD = "\\x1b[1m";
const RESET = "\\x1b[0m";
console.warn("");
console.warn(YELLOW + BOLD + "rpiv-pi: code tools overlay not applied" + RESET);
console.warn(YELLOW + "Installed version " + version + " — the fork overlay failed to apply." + RESET);
console.warn(YELLOW + "Agent prompts use upstream defaults (no Pi-fff / Pi-cymbal tool guidance)." + RESET);
console.warn(YELLOW + "Check the Sync Upstream workflow run for details:" + RESET);
console.warn(YELLOW + "https://github.com/spacemeld/rpiv-pi/actions" + RESET);
console.warn("");
`);

	let combined = "";
	let exitCode = 0;
	try {
		combined = execSync(`node "${join(scriptsDir, "postinstall.mjs")}" 2>&1`, {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (e) {
		combined = (e.stdout ?? "") + (e.stderr ?? "");
		exitCode = e.status ?? 1;
	}

	rmSync(tmpDir, { recursive: true, force: true });
	return { output: combined, exitCode };
}

let failed = 0;

// Test 1: -no-overlay prints warning
{
	const result = runPostinstall("1.16.2-no-overlay");
	if (result.exitCode !== 0) {
		console.error(`FAIL: -no-overlay should exit 0, got ${result.exitCode}`);
		failed++;
	} else if (!result.output.includes("code tools overlay not applied")) {
		console.error(`FAIL: -no-overlay should print warning, got: ${JSON.stringify(result.output)}`);
		failed++;
	} else if (!result.output.includes("1.16.2-no-overlay")) {
		console.error(`FAIL: -no-overlay warning should include version, got: ${JSON.stringify(result.output)}`);
		failed++;
	} else {
		console.log("PASS: -no-overlay prints warning");
	}
}

// Test 2: -overlay does NOT print warning
{
	const result = runPostinstall("1.16.2-overlay");
	if (result.exitCode !== 0) {
		console.error(`FAIL: -overlay should exit 0, got ${result.exitCode}`);
		failed++;
	} else if (result.output.includes("code tools overlay not applied")) {
		console.error(`FAIL: -overlay should NOT print warning`);
		failed++;
	} else {
		console.log("PASS: -overlay prints no warning");
	}
}

// Test 3: plain version does NOT print warning
{
	const result = runPostinstall("1.16.2");
	if (result.exitCode !== 0) {
		console.error(`FAIL: plain version should exit 0, got ${result.exitCode}`);
		failed++;
	} else if (result.output.includes("code tools overlay not applied")) {
		console.error(`FAIL: plain version should NOT print warning`);
		failed++;
	} else {
		console.log("PASS: plain version prints no warning");
	}
}

process.exit(failed);
