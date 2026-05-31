#!/usr/bin/env node

/**
 * Applies this fork's code tools overlay to bundled rpiv-pi
 * agents and skills.
 *
 * The upstream files remain normal markdown definitions. This script makes
 * the code tools delta repeatable after upstream updates:
 *
 *   1. Merge or rebase upstream.
 *   2. Run `node scripts/apply-local-nav-tools.mjs`.
 *   3. Inspect the diff and resolve any real upstream prompt conflicts.
 *
 * The edits are intentionally mechanical:
 * - expand agent frontmatter tool allowlists for Pi-fff and Pi-cymbal tools
 * - insert/update a marked "Agent-Native Code Navigation Policy" section after frontmatter
 * - apply agent-specific body nudges where generic policy is not enough
 * - expand skill `allowed-tools` lists for skills that do direct file work
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const agentsDir = join(repoRoot, "packages", "rpiv-pi", "agents");
const skillsDir = join(repoRoot, "packages", "rpiv-pi", "skills");

// ---------------------------------------------------------------------------
// Tool sets
// ---------------------------------------------------------------------------

const fffTools = ["ffgrep", "fffind", "fff-multi-grep"];
const cymbalTools = [
	"cymbal_map",
	"cymbal_structure",
	"cymbal_search",
	"cymbal_outline",
	"cymbal_show",
	"cymbal_refs",
	"cymbal_impact",
	"cymbal_importers",
	"cymbal_impls",
	"cymbal_context",
	"cymbal_diff",
	"cymbal_trace",
	"cymbal_investigate",
];

/** Locator agents name paths only — no symbol body reads via cymbal_show. */
const locatorCymbalTools = cymbalTools.filter((tool) => tool !== "cymbal_show");

const skillCymbalTools = [
	"cymbal_search",
	"cymbal_outline",
	"cymbal_show",
	"cymbal_refs",
	"cymbal_impact",
	"cymbal_trace",
	"cymbal_investigate",
];

// ---------------------------------------------------------------------------
// Agent classification
// ---------------------------------------------------------------------------

/** Default code-navigation agents: full fff + cymbal stack */
const codeNavigationAgents = new Set([
	"artifact-code-reviewer.md",
	"artifact-coverage-reviewer.md",
	"claim-verifier.md",
	"codebase-analyzer.md",
	"codebase-pattern-finder.md",
	"diff-auditor.md",
	"peer-comparator.md",
	"precedent-locator.md",
	"slice-verifier.md",
	// scope-tracer, integration-scanner, codebase-locator → agentOverrides
]);

/** Agents with tailored tool sets and/or policies */
const agentOverrides = new Map([
	[
		"codebase-locator.md",
		{
			tools: [...fffTools, ...locatorCymbalTools],
			policy: "locator",
			bodyInsertions: [
				[
					"### Initial Broad Search",
					"Prefer `cymbal_map` / `cymbal_search` and `fffind` before shell-style search. Do **not** use `read` or `cymbal_show` — this agent names paths only.",
				],
			],
		},
	],
	[
		"scope-tracer.md",
		{
			tools: [...fffTools, ...cymbalTools],
			policy: "scope-tracer",
			bodyReplacements: [
				[
					"   - Run `grep` / `find` / `ls` per slice — one slice at a time, capture matches, then move on",
					"   - Prefer `fff-multi-grep` (OR logic across anchor terms) or `cymbal_search` per slice — one slice at a time, capture matches, then move on; fall back to `grep` / `find` / `ls` when unavailable",
				],
				[
					"Use `read` (no limit/offset) on every file the caller's prompt names. This is foundation context — done before any grep work.",
					"Use `read` (no limit/offset) on every file the caller's prompt names. This is foundation context — done before any anchor sweep. Start unfamiliar areas with `cymbal_map` when available.",
				],
				[
					"For each slice in order: run `grep` for the anchor terms, narrow with `find` / `ls` as needed, capture file:line matches. Move to the next slice once the current slice's match set is collected. Take time to ultrathink about how each slice's matches relate to the others before reading files for depth.",
					"For each slice in order: run `fff-multi-grep` for the slice's anchor terms (OR logic) or `cymbal_search` for symbol/name anchors; narrow with `fffind` / `cymbal_map` as needed, capture file:line matches. Fall back to `grep` / `find` / `ls` when FFF or Cymbal tools are unavailable. Move to the next slice once the current slice's match set is collected. Take time to ultrathink about how each slice's matches relate to the others before reading files for depth.",
				],
			],
		},
	],
	[
		"integration-scanner.md",
		{
			tools: [...fffTools, ...cymbalTools],
			policy: "integration-scanner",
			bodyReplacements: [
				[
					"### Step 2: Search for Inbound References\n- Grep for the target's class/interface/namespace across the whole project\n- Exclude the target's own directory (we want external references)\n- Check for string references too (config files, DI registrations)",
					"### Step 2: Search for Inbound References\n- Prefer `cymbal_refs`, `cymbal_importers`, and `cymbal_impact` on the target symbol when available\n- Fall back to grep for the target's class/interface/namespace across the whole project\n- Exclude the target's own directory (we want external references)\n- Check for string references too (config files, DI registrations)",
				],
				[
					"### Step 4: Search for Outbound Dependencies\n- Read the target directory's import/using statements via Grep\n- Identify external service calls, database access, message publishing",
					"### Step 4: Search for Outbound Dependencies\n- Prefer `cymbal_show` / `cymbal_outline` on the target symbol for imports, then `cymbal_trace` for dependency direction when available\n- Fall back to grep on the target directory's import/using statements\n- Identify external service calls, database access, message publishing",
				],
			],
		},
	],
]);

/** Artifact-oriented agents: only fff (no symbol navigation needed) */
const fffOnlyAgents = new Set(["artifacts-analyzer.md", "artifacts-locator.md"]);

const skillsToPatch = new Map([
	["implement", [...fffTools, ...skillCymbalTools]],
	["validate", [...fffTools, ...skillCymbalTools]],
]);

// ---------------------------------------------------------------------------
// Policy templates
// ---------------------------------------------------------------------------

const policyStart = "<!-- rpiv-code-tools-policy:start -->";
const policyEnd = "<!-- rpiv-code-tools-policy:end -->";

const codeNavigationPolicy = `${policyStart}
## Agent-Native Code Navigation Policy

When available, prefer agent-native code navigation before broad shell-style search:

- Use \`cymbal_map\` for repo or directory orientation before choosing files.
- Use \`cymbal_search\` for symbol search, exact type/function names, or text search when symbol context matters.
- Use \`cymbal_outline\` before reading large files.
- Use \`cymbal_show\`, \`cymbal_refs\`, \`cymbal_importers\`, and \`cymbal_impact\` for targeted reads, references, dependency direction, and refactor blast radius.
- Use \`cymbal_trace\` for call-graph traversal — follow callers or dependencies across a codebase.
- Use \`cymbal_investigate\` for guided symbol investigation with auto-summarization.
- Use \`fffind\` for fuzzy file discovery and ranked file narrowing.
- Use \`ffgrep\` for fast literal or regex content search.
- Use \`fff-multi-grep\` when sweeping several anchor terms with OR logic.
- Fall back to \`find\` / \`grep\` / \`ls\` when FFF or Cymbal tools are unavailable, when exact built-in behavior is required, or when searching non-Git/generated/transient paths that Cymbal does not index.
${policyEnd}`;

const codebaseLocatorPolicy = `${policyStart}
## Agent-Native Code Navigation Policy

When available, prefer agent-native code navigation before broad shell-style search. This agent **locates paths only** — do not read file bodies.

- Use \`cymbal_map\` for repo or directory orientation before choosing files.
- Use \`cymbal_search\` for symbol search, exact type/function names, or text search when symbol context matters.
- Use \`cymbal_outline\` for export/signature lists without reading full files.
- Use \`cymbal_refs\`, \`cymbal_importers\`, and \`cymbal_impact\` for reference direction and blast radius — not for deep analysis.
- Use \`fffind\` for fuzzy file discovery and ranked file narrowing.
- Use \`ffgrep\` for fast literal or regex content search.
- Use \`fff-multi-grep\` when sweeping several anchor terms with OR logic.
- Do **not** use \`read\` or \`cymbal_show\` — those belong to analyzer agents.
- Fall back to \`find\` / \`grep\` / \`ls\` when FFF or Cymbal tools are unavailable, when exact built-in behavior is required, or when searching non-Git/generated/transient paths that Cymbal does not index.
${policyEnd}`;

const scopeTracerPolicy = `${policyStart}
## Agent-Native Code Navigation Policy

When available, prefer agent-native code navigation for anchor sweeps and orientation:

- Use \`cymbal_map\` to orient in unfamiliar areas before slicing.
- Use \`fff-multi-grep\` as the default anchor sweep — OR logic across 2-6 terms per slice.
- Use \`cymbal_search\` for symbol/name anchors and \`cymbal_outline\` before reading large files.
- Use \`cymbal_show\` only in Step 4 depth reads (5-10 files cap), not during the sweep.
- Use \`fffind\` / \`ffgrep\` when Cymbal does not cover the path or term shape.
- Fall back to \`find\` / \`grep\` / \`ls\` when FFF or Cymbal tools are unavailable or for non-Git/generated paths.
${policyEnd}`;

const integrationScannerPolicy = `${policyStart}
## Agent-Native Code Navigation Policy

When available, prefer Cymbal relationship tools before project-wide grep:

- Use \`cymbal_refs\`, \`cymbal_importers\`, and \`cymbal_impact\` for inbound/outbound connection discovery.
- Use \`cymbal_search\` for string/config references Cymbal may not index as symbols.
- Use \`cymbal_outline\` / \`cymbal_show\` narrowly for import lists — do not deep-read implementations.
- Use \`fff-multi-grep\` for DI/event/route/config pattern sweeps across anchor terms.
- Use \`fffind\` / \`ffgrep\` as fallbacks when Cymbal is unavailable.
- Fall back to \`find\` / \`grep\` / \`ls\` for non-Git/generated/transient paths.
${policyEnd}`;

const fffOnlyPolicy = `${policyStart}
## Agent-Native Code Navigation Policy

When available, prefer Pi-fff for local artifact and text discovery:

- Use \`fffind\` for fuzzy file discovery and ranked file narrowing.
- Use \`ffgrep\` for fast literal or regex content search.
- Use \`fff-multi-grep\` when sweeping several anchor terms with OR logic.
- Fall back to \`find\` / \`grep\` / \`ls\` when FFF tools are unavailable or exact built-in behavior is required.
${policyEnd}`;

const policies = {
	default: codeNavigationPolicy,
	locator: codebaseLocatorPolicy,
	"scope-tracer": scopeTracerPolicy,
	"integration-scanner": integrationScannerPolicy,
	fff: fffOnlyPolicy,
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(markdown, file) {
	if (!markdown.startsWith("---\n")) {
		throw new Error(`${file}: missing frontmatter`);
	}
	const end = markdown.indexOf("\n---\n", 4);
	if (end === -1) {
		throw new Error(`${file}: unterminated frontmatter`);
	}
	return {
		frontmatter: markdown.slice(0, end + "\n---".length),
		body: markdown.slice(end + "\n---\n".length),
	};
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateToolsField(frontmatter, extraTools, file) {
	const toolsMatch = frontmatter.match(/^tools:\s*(.+)$/m);
	if (!toolsMatch) {
		throw new Error(`${file}: missing tools frontmatter field`);
	}

	const current = toolsMatch[1]
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	const merged = [...current];
	for (const tool of extraTools) {
		if (!merged.includes(tool)) merged.push(tool);
	}

	return frontmatter.replace(/^tools:\s*.+$/m, `tools: ${merged.join(", ")}`);
}

function updatePolicy(body, policy) {
	const markerPattern = new RegExp(`${escapeRegExp(policyStart)}[\\s\\S]*?${escapeRegExp(policyEnd)}\\n*`, "m");
	const normalizedPolicy = `${policy}\n\n`;
	if (markerPattern.test(body)) {
		return body.replace(markerPattern, normalizedPolicy);
	}
	return `${normalizedPolicy}${body.replace(/^\n+/, "")}`;
}

/**
 * In-place replacements: the `from` text is fully replaced by `to` and no longer
 * appears in the output. Idempotent — skips when `from` is already gone and `to`
 * is already present.
 */
function applyBodyReplacements(body, replacements) {
	let next = body;
	for (const [from, to] of replacements) {
		if (!next.includes(from)) {
			if (next.includes(to)) continue;
			throw new Error(
				`Body patch anchor not found (and replacement not already present):\n${from.slice(0, 120)}...`,
			);
		}
		next = next.replace(from, to);
	}
	return next;
}

/**
 * After-anchor insertions: `text` is inserted after `anchor` (which stays in the
 * output). Idempotent — skips when `text` is already present in the body.
 */
function applyBodyInsertions(body, insertions) {
	let next = body;
	for (const [anchor, text] of insertions) {
		if (next.includes(text)) continue;
		if (!next.includes(anchor)) {
			throw new Error(`Body insertion anchor not found:\n${anchor.slice(0, 120)}...`);
		}
		next = next.replace(anchor, `${anchor}\n\n${text}`);
	}
	return next;
}

function applyToAgent(file, extraTools, policyKey, bodyReplacements = [], bodyInsertions = []) {
	const path = join(agentsDir, file);
	const original = readFileSync(path, "utf8");
	const { frontmatter, body } = parseFrontmatter(original, file);
	const policy = policies[policyKey] ?? policies.default;
	let nextBody = updatePolicy(body, policy);
	if (bodyReplacements.length > 0) {
		nextBody = applyBodyReplacements(nextBody, bodyReplacements);
	}
	if (bodyInsertions.length > 0) {
		nextBody = applyBodyInsertions(nextBody, bodyInsertions);
	}
	const next = `${updateToolsField(frontmatter, extraTools, file)}\n${nextBody}`;
	if (next !== original) {
		writeFileSync(path, next, "utf8");
		return true;
	}
	return false;
}

function applyToSkill(skillDir, extraTools) {
	const path = join(skillsDir, skillDir, "SKILL.md");
	const original = readFileSync(path, "utf8");
	const { frontmatter, body } = parseFrontmatter(original, `skills/${skillDir}/SKILL.md`);

	const toolsMatch = frontmatter.match(/^allowed-tools:\s*(.+)$/m);
	if (!toolsMatch) {
		return false;
	}

	const current = toolsMatch[1]
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	const merged = [...current];
	for (const tool of extraTools) {
		if (!merged.includes(tool)) merged.push(tool);
	}

	const nextFm = frontmatter.replace(/^allowed-tools:\s*.+$/m, `allowed-tools: ${merged.join(", ")}`);
	const next = `${nextFm}\n${body}`;
	if (next !== original) {
		writeFileSync(path, next, "utf8");
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

let changed = 0;

for (const file of codeNavigationAgents) {
	if (applyToAgent(file, [...fffTools, ...cymbalTools], "default")) changed++;
}

for (const [file, override] of agentOverrides) {
	if (
		applyToAgent(
			file,
			override.tools,
			override.policy,
			override.bodyReplacements ?? [],
			override.bodyInsertions ?? [],
		)
	) {
		changed++;
	}
}

for (const file of fffOnlyAgents) {
	if (applyToAgent(file, fffTools, "fff")) changed++;
}

for (const [skillDir, tools] of skillsToPatch) {
	if (applyToSkill(skillDir, tools)) changed++;
}

console.log(`Applied code tools overlay (${changed} file${changed === 1 ? "" : "s"} changed).`);
