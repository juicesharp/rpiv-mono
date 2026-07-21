#!/usr/bin/env node
/**
 * Release script for rpiv-mono
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Before running:
 *   Draft [Unreleased] entries for every affected package's CHANGELOG.md.
 *   If you are inside a Pi session with @juicesharp/rpiv-pi loaded, run
 *   `/skill:changelog` — it regenerates [Unreleased] from git history
 *   (committed + uncommitted) in Keep a Changelog style. Otherwise hand-edit
 *   each packages/<pkg>/CHANGELOG.md before invoking this script. The release
 *   below promotes whatever [Unreleased] currently contains.
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Warn if every [Unreleased] section is empty
 * 3. Bump version via npm run version:xxx (lockstep across all packages)
 * 4. Promote each package CHANGELOG: [Unreleased] -> [version] - date
 * 5. Commit and tag
 * 6. Publish to npm (npm publish -ws --access public)
 * 7. Reinstate [Unreleased] section in each CHANGELOG
 * 8. Commit the [Unreleased] reinstatement
 * 9. Push main + tag
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (_e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/rpiv-pi/package.json", "utf-8"));
	return pkg.version;
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [
		...new Set(
			(output || "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
	if (paths.length === 0) return;
	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
		return getVersion();
	}

	if (compareVersions(target, currentVersion) <= 0) {
		console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
		process.exit(1);
	}

	console.log(`Setting explicit version (${target})...`);
	run(
		`npm version ${target} -ws --no-git-tag-version && node scripts/sync-versions.js && npx shx rm -rf node_modules packages/*/node_modules package-lock.json && npm install`,
	);
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md")).filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

// Insert "## [Unreleased]" above the first "## [" heading — survives
// Keep-a-Changelog intro prose between "# Changelog" and first version block.
function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");
		const updated = content.replace(/^(## \[)/m, `${unreleasedSection}$1`);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

function getUnreleasedBody(changelogPath) {
	const content = readFileSync(changelogPath, "utf-8");
	const start = content.indexOf("## [Unreleased]");
	if (start === -1) return null;
	const after = content.slice(start + "## [Unreleased]".length);
	const nextHeader = after.search(/^## \[/m);
	const body = nextHeader === -1 ? after : after.slice(0, nextHeader);
	return body;
}

function hasUnreleasedEntries() {
	const changelogs = getChangelogs();
	for (const changelog of changelogs) {
		const body = getUnreleasedBody(changelog);
		if (body && /^- /m.test(body)) return true;
	}
	return false;
}

// Main
console.log("\n=== rpiv-mono Release ===\n");

console.log("Reminder: draft [Unreleased] entries before releasing.");
console.log("  In a Pi session with @juicesharp/rpiv-pi loaded: run /skill:changelog");
console.log("  Otherwise: hand-edit each packages/<pkg>/CHANGELOG.md\n");

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status?.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

console.log("Checking npm publish auth...");
const npmUser = run("npm whoami", { silent: true, ignoreError: true });
if (!npmUser?.trim()) {
	console.error("Error: not authenticated to the npm registry (npm whoami failed).");
	console.error("  Publishing requires an interactive OTP session or a granular token with 2FA bypass.");
	console.error(
		"  Fix auth now — the publish step runs AFTER commit + tag, so failing there leaves a half-done release.",
	);
	process.exit(1);
}
console.log(`  Authenticated as ${npmUser.trim()}\n`);

console.log("Checking [Unreleased] sections...");
if (!hasUnreleasedEntries()) {
	console.log("  Warning: every package's [Unreleased] section is empty.");
	console.log("  Proceeding — this is valid for a no-user-visible-change lockstep bump.");
	console.log("  If you forgot to draft entries, Ctrl+C now and run /skill:changelog (Pi) or hand-edit.\n");
} else {
	console.log("  At least one package has [Unreleased] entries\n");
}

console.log("Running test suite with coverage...");
run("npm run coverage");
console.log();

const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

console.log("Promoting CHANGELOG.md [Unreleased] sections...");
updateChangelogsForRelease(version);
console.log();

console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

console.log("Publishing to npm...");
run("npm run publish");
console.log();

console.log("Reinstating [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
