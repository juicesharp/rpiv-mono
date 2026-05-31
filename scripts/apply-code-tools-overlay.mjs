#!/usr/bin/env node

/**
 * Applies this fork's code tools overlay to bundled rpiv-pi
 * agents and skills.
 *
 * The upstream files remain normal markdown definitions. This script makes
 * the code tools delta repeatable after upstream updates:
 *
 *   1. Merge or rebase upstream.
 *   2. Run `node scripts/apply-code-tools-overlay.mjs`.
 *   3. Inspect the diff and resolve any real upstream prompt conflicts.
 *
 * The edits are intentionally mechanical:
 * - expand agent frontmatter tool allowlists for Pi-fff and Pi-cymbal tools
 * - replace `isolated: true` with `extensions: cymbal,ff` so extension tools load
 *   but non-code-tool extensions stay blocked (preserving isolation intent)
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

const _skillCymbalTools = [
	"cymbal_search",
	"cymbal_outline",
	"cymbal_show",
	"cymbal_refs",
	"cymbal_impact",
	"cymbal_trace",
	"cymbal_investigate",
];

/**
 * Extension prefix allowlist for `extensions:` frontmatter.
 *
 * When `isolated: true` is set, pi-subagents sets `noExtensions: true` on the
 * resource loader, which prevents ALL extension tools from loading.  The tools
 * listed in `tools:` frontmatter become a dead allowlist — nothing to allow.
 *
 * Replacing `isolated: true` with `extensions: cymbal,ff` achieves:
 *   - Extensions are loaded (pi-subagents passes `noExtensions: false`)
 *   - cymbal_* tools and ff* tools pass the `allowedToolNames` gate (they're
 *     in `tools:`) and the `builtinToolNameSet` active-tool filter
 *   - Other extension tools (web_search, ask_user_question, todo, advisor, etc.)
 *     are blocked because they don't match prefix "cymbal" or "ff"
 *
 * If fff-only agents need a narrower list, use "ff" alone.
 */
const codeToolExtensions = "cymbal,ff";
const fffOnlyExtensions = "ff";

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

// ---------------------------------------------------------------------------
// Skill patching
// ---------------------------------------------------------------------------

/**
 * `allowed-tools` is only a prompt hint — not enforced at the API level.
 * Replacing Glob/Grep in the `allowed-tools` line and body text makes the
 * preferred tool explicit so the agent reaches for fff first.  The original
 * Pi built-in find/grep/ls tools remain available as fallbacks.
 *
 * Similarly, body text that references grep/find/ls for code navigation
 * should name the preferred cymbal/fff tool directly so the agent reaches
 * for it without needing an `allowed-tools` hint.
 */
const skillBodyReplacements = new Map([
	[
		"research",
		[
			[
				"sweeps anchor terms via grep/find/ls",
				"sweeps anchor terms via fff-multi-grep/cymbal_search, falling back to grep/find/ls when unavailable",
			],
		],
	],
	[
		"migrate-to-guidance",
		[
			[
				"Use Glob to find all `**/CLAUDE.md` files in the project",
				"Use fffind to find all `**/CLAUDE.md` files in the project",
			],
		],
	],
	// The annotation skills contain a subagent prompt that says "Use grep/find/ls only".
	// The subagents now have `extensions: cymbal,ff` (set by the agent patching above),
	// so they can use fff/cymbal tools directly.  Update the prompt to guide them.
	[
		"annotate-guidance",
		[
			[
				"Use grep/find/ls only. Do not read file contents.",
				"Prefer fffind/ffgrep/fff-multi-grep and cymbal_map/cymbal_search for orientation; fall back to find/grep/ls when unavailable. Do not read file contents.",
			],
		],
	],
	[
		"annotate-inline",
		[
			[
				"Use grep/find/ls only. Do not read file contents.",
				"Prefer fffind/ffgrep/fff-multi-grep and cymbal_map/cymbal_search for orientation; fall back to find/grep/ls when unavailable. Do not read file contents.",
			],
		],
	],
]);

/** Skills whose `allowed-tools` line lists Glob and/or Grep. */
const skillsWithAllowedTools = new Set([
	"annotate-guidance",
	"annotate-inline",
	"changelog",
	"commit",
	"create-handoff",
	"implement",
	"migrate-to-guidance",
	"validate",
]);

/** All skills that need processing (union of allowed-tools + body replacements). */
const allSkillsToPatch = new Set([...skillsWithAllowedTools, ...skillBodyReplacements.keys()]);

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

/**
 * Replace `isolated: true` with an `extensions:` prefix allowlist.
 *
 * `isolated: true` blocks ALL extension tools from loading (even those named
 * in `tools:`).  Replacing it with `extensions: <prefixes>` lets the declared
 * code-tool extensions through while keeping other extensions' tools out.
 * Idempotent — skips when `isolated` is already absent and `extensions` is
 * already set to the target value.
 */
function updateIsolationField(frontmatter, extensionsValue, _file) {
	const isolatedMatch = frontmatter.match(/^isolated:\s*true\s*$/m);
	if (isolatedMatch) {
		// Replace `isolated: true` with `extensions: <prefixes>`
		return frontmatter.replace(/^isolated:\s*true\s*$/m, `extensions: ${extensionsValue}`);
	}

	// Already migrated: check if extensions field has the right value
	const extensionsMatch = frontmatter.match(/^extensions:\s*(.+)$/m);
	if (extensionsMatch) {
		const current = extensionsMatch[1].trim();
		if (current === extensionsValue) return frontmatter; // already correct
		return frontmatter.replace(/^extensions:\s*.+$/m, `extensions: ${extensionsValue}`);
	}

	// No `isolated:` and no `extensions:` — add `extensions:` after `tools:` line
	return frontmatter.replace(/^(tools:\s*.+)$/m, `$1\nextensions: ${extensionsValue}`);
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

function applyToAgent(
	file,
	extraTools,
	policyKey,
	extensionsValue = codeToolExtensions,
	bodyReplacements = [],
	bodyInsertions = [],
) {
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
	let nextFm = updateToolsField(frontmatter, extraTools, file);
	nextFm = updateIsolationField(nextFm, extensionsValue, file);
	const next = `${nextFm}\n${nextBody}`;
	if (next !== original) {
		writeFileSync(path, next, "utf8");
		return true;
	}
	return false;
}

/**
 * Replace Claude Code tool names (Glob, Grep) in the `allowed-tools` line
 * with their Pi-fff equivalents (fffind, ffgrep).  The original Pi built-in
 * find/grep/ls tools remain available to the agent regardless — `allowed-tools`
 * is only a hint, so replacing rather than appending avoids listing dead names
 * and makes the preferred tool explicit.
 *
 * Idempotent — skips when the replacements are already present and the
 * originals are already gone.
 */
function replaceAllowedTools(frontmatter, _skillDir) {
	const toolsMatch = frontmatter.match(/^allowed-tools:\s*(.+)$/m);
	if (!toolsMatch) return frontmatter;

	const current = toolsMatch[1]
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);

	let changed = false;
	const next = current.map((tool) => {
		if (tool === "Glob") {
			changed = true;
			return "fffind";
		}
		if (tool === "Grep") {
			changed = true;
			return "ffgrep";
		}
		return tool;
	});

	if (!changed) return frontmatter;
	return frontmatter.replace(/^allowed-tools:\s*.+$/m, `allowed-tools: ${next.join(", ")}`);
}

function applyToSkill(skillDir) {
	const path = join(skillsDir, skillDir, "SKILL.md");
	const original = readFileSync(path, "utf8");
	const { frontmatter, body } = parseFrontmatter(original, `skills/${skillDir}/SKILL.md`);

	let nextFm = frontmatter;
	if (skillsWithAllowedTools.has(skillDir)) {
		nextFm = replaceAllowedTools(frontmatter, skillDir);
	}

	let nextBody = body;

	const replacements = skillBodyReplacements.get(skillDir);
	if (replacements) {
		nextBody = applyBodyReplacements(nextBody, replacements);
	}

	const next = `${nextFm}\n${nextBody}`;
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
	if (applyToAgent(file, [...fffTools, ...cymbalTools], "default", codeToolExtensions)) changed++;
}

for (const [file, override] of agentOverrides) {
	if (
		applyToAgent(
			file,
			override.tools,
			override.policy,
			codeToolExtensions,
			override.bodyReplacements ?? [],
			override.bodyInsertions ?? [],
		)
	) {
		changed++;
	}
}

for (const file of fffOnlyAgents) {
	if (applyToAgent(file, fffTools, "fff", fffOnlyExtensions)) changed++;
}

for (const skillDir of allSkillsToPatch) {
	if (applyToSkill(skillDir)) changed++;
}

console.log(`Applied code tools overlay (${changed} file${changed === 1 ? "" : "s"} changed).`);
