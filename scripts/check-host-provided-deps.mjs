// check-host-provided-deps.mjs — standing guard against shadowing a host-provided module.
//
//   node scripts/check-host-provided-deps.mjs      (also the first stage of `npm run check`)
//
// Reads every workspace manifest (repo root + `packages/*`) and flags any host-provided
// package the manifest claims as its own install-time dependency. Pi already provides
// these modules and aliases the bare specifier, so an installed copy is dead weight at
// best and a second live copy of the same module in one process at worst. Then reads
// every package source file and flags any host-provided import the host cannot alias.
//
// RULE
//   @earendil-works/pi-{ai,agent-core,coding-agent,tui}, their legacy @mariozechner/*
//   spellings, and typebox / @sinclair/typebox are provided by the Pi host. Declare one
//   in `peerDependencies` with the range `"*"` — never in `dependencies` or
//   `optionalDependencies`, and never with a narrowed range.
//
//   Import one only through a specifier the host aliases: `typebox`, `typebox/compile`,
//   `typebox/value`, `@sinclair/typebox`, `@sinclair/typebox/compile`,
//   `@sinclair/typebox/value`. Any other `typebox/...` subpath is not aliased.
//
// WHY (parity with the host's own loader check)
//   Pi's resource loader reads each installed extension's package.json and warns on
//   exactly this shape: a host-provided name found in `dependencies`. Its runtime alias
//   table maps only the bare specifiers (plus `/value` and `/compile`), so an installed
//   copy reachable by any unaliased path puts two typebox — or two pi-tui — instances in
//   one process: schemas built by one, validated by the other, symbols that no longer
//   line up. The host tells you at startup; this guard tells you before publish.
//
// WHY THE SPECIFIER HALF IS CHECKED TOO
//   The manifest shape and the import specifier are two halves of the same failure mode,
//   and only the first one produces the startup warning. The alias tables cover six
//   typebox spellings and no more: `typebox/format`, `typebox/system`, `typebox/error`,
//   `typebox/guard`, `typebox/schema` and `typebox/type` are absent, so such an import
//   passes a manifest-only guard and then resolves through Node — a second instance while
//   a physical copy exists, `ERR_MODULE_NOT_FOUND` once it is gone. Current sources
//   import `typebox` and `typebox/value` only; this keeps it that way, and the check
//   fails with the file and line rather than the next user's startup log.
//
// WHY THE PEER RANGE MUST BE "*"
//   A narrowed range (`^1.1.24`) is a version claim this repo cannot enforce: the host
//   ships whatever it bundles (typebox 1.1.38 at pi 0.80.6, 1.3.27 at pi 0.99.1), and the
//   range silently licenses an install of something else. `"*"` states the real contract
//   — "whatever the host provides" — which is the same contract every other peer entry
//   here already carries.
//
// WHY devDependencies ARE EXEMPT
//   The root manifest pins the host-provided trio and typebox as devDependencies, pinned
//   EXACT, so `tsc` and Vitest check and test against the same surface the host aliases
//   (see .rpiv/guidance/scripts/architecture.md, "Fresh-Resolution Hazard"). Those are
//   dev-time resolutions only — the extension loader never resolves them, because no
//   package ships them inside its own `dependencies`.
//
// Exit 0 = clean; exit 1 = violation(s), printed as `path: field: package` for a
// manifest and `path:line: specifier` for an unaliased import.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Verbatim copy of the host's set (pi `HOST_PROVIDED_EXTENSION_PACKAGES`, with the
// legacy @mariozechner spellings it still accepts). Kept literal and in one place: if a
// future pi release adds a bundled module to the host-provided list, this is the single
// line to extend, and the failure mode is a missed warning here rather than a false one.
const HOST_PROVIDED = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
]);

// Fields that make the package manager install its own copy. `devDependencies` is
// absent by design (see WHY devDependencies ARE EXEMPT in the header).
const INSTALL_FIELDS = ["dependencies", "optionalDependencies"];
const PEER_FIELD = "peerDependencies";

// Every specifier the host's alias table resolves: `getAliases()` on an unbundled Node
// host, `VIRTUAL_MODULES` on a Bun / Node-SEA binary. Same six spellings in both, and
// nothing else — a `typebox/...` import outside this set bypasses the mapping entirely.
// The `@earendil-works/pi-*` entries are not listed here: they are imported as bare
// specifiers throughout this repo, and their host-provided subpaths move with the host
// version in ways a hardcoded list here would only approximate.
const ALIASED_SPECIFIERS = new Set([
	"typebox",
	"typebox/compile",
	"typebox/value",
	"@sinclair/typebox",
	"@sinclair/typebox/compile",
	"@sinclair/typebox/value",
]);

// Import-shaped positions only — `from "…"`, `import "…"`, `import("…")`,
// `require("…")` — so a bare mention of the word in a comment or a test fixture string
// is not read as an import. Captures the package and, for a subpath, the remainder.
const SPECIFIER_PATTERN = /\b(?:from|import|require)\s*\(?\s*["'](@sinclair\/typebox|typebox)(\/[^"']*)?["']/g;

// Directories that hold no authored source: installed trees, build output, coverage.
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

// Filesystem-driven discovery, matching the other scripts in this directory: a new
// package is covered the moment it lands, with no edit here. The root manifest is
// included so a stray `dependencies` entry at the workspace level is caught too.
function manifestPaths() {
	const paths = ["package.json"];
	if (!existsSync("packages")) return paths;
	for (const entry of readdirSync("packages", { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join("packages", entry.name, "package.json");
		if (existsSync(path)) paths.push(path);
	}
	return paths;
}

function sourcePaths(dir) {
	const paths = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) paths.push(...sourcePaths(path));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			paths.push(path);
		}
	}
	return paths;
}

const violations = [];

for (const path of manifestPaths()) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		console.error(`Cannot parse ${path} as JSON — fix the manifest before relying on this guard.`);
		process.exit(1);
	}

	for (const field of INSTALL_FIELDS) {
		for (const name of Object.keys(manifest[field] ?? {})) {
			if (HOST_PROVIDED.has(name)) violations.push(`${path}: ${field}: ${name}`);
		}
	}

	for (const [name, range] of Object.entries(manifest[PEER_FIELD] ?? {})) {
		if (HOST_PROVIDED.has(name) && range !== "*") violations.push(`${path}: ${PEER_FIELD}: ${name} (${range})`);
	}
}

let scannedSources = 0;

if (existsSync("packages")) {
	for (const path of sourcePaths("packages")) {
		scannedSources++;
		const source = readFileSync(path, "utf8");
		for (const match of source.matchAll(SPECIFIER_PATTERN)) {
			const specifier = match[1] + (match[2] ?? "");
			if (ALIASED_SPECIFIERS.has(specifier)) continue;
			const line = source.slice(0, match.index).split("\n").length;
			violations.push(`${path}:${line}: ${specifier} (import specifier the host does not alias)`);
		}
	}
}

if (violations.length) {
	console.error(`Found ${violations.length} host-provided violation(s):`);
	for (const v of violations) console.error(`  ${v}`);
	console.error(
		'\nPi provides these modules and aliases them at load time; an installed copy bypasses the extension\nloader and yields duplicate runtime modules. Move the entry to peerDependencies with the range "*", and\nimport it only through a specifier the host aliases (typebox, typebox/compile, typebox/value and the\nthree @sinclair/typebox spellings).',
	);
	process.exit(1);
}

console.log(
	`OK — no host-provided package in any install-time dependency, no unaliased host-provided import (scanned ${manifestPaths().length} manifest(s), ${scannedSources} source file(s)).`,
);
