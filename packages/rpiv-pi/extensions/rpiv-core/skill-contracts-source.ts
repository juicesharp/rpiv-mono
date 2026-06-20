/**
 * Inject rpiv-pi's bundled skill contracts into the @juicesharp/rpiv-workflow
 * registry. Mirrors register-built-in-workflows.ts: rpiv-workflow is a SIBLING
 * (peerDependency a clean install does not pull), so we NEVER statically import
 * it at runtime — a lazy provider behind a dynamic import, no-op when absent.
 *
 * The framework is skill-agnostic; rpiv-pi (which already imports Pi's
 * parseFrontmatter) is the primary consumer that reads each bundled skill's
 * `contract:` frontmatter block and supplies the parsed contracts. Skills
 * without a `contract:` block are skipped — the provider is a no-op until skills
 * declare one.
 */

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { getAgentDir, loadSkills, loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type {
	ConsumesSpec,
	ProducesSpec,
	SchemaCompatResult,
	SkillContract,
} from "@juicesharp/rpiv-workflow/registration";
import { BUNDLED_SKILLS_DIR } from "./paths.js";
import { isModuleNotFound } from "./utils.js";

const JSON_SCHEMA_ROOT_KEYWORDS = new Set([
	"type",
	"properties",
	"items",
	"enum",
	"const",
	"anyOf",
	"allOf",
	"oneOf",
	"$ref",
	"not",
	"required",
	"additionalProperties",
	"definitions",
	"$defs",
]);

function hasSchemaKeyword(obj: Record<string, unknown>): boolean {
	return Object.keys(obj).some((k) => JSON_SCHEMA_ROOT_KEYWORDS.has(k));
}

/**
 * Map a raw frontmatter `contract:` object to a declared SkillContract. Domain
 * tags the framework treats as opaque (artifactKind, …) are expected under
 * `consumes.meta` / `produces.meta` in frontmatter — how rpiv-pi shapes its own
 * frontmatter is the consumer's call; the framework never reads
 * inside `meta`. Both `consumes` and `produces` are validated per-field (not
 * blindly cast) so a block with a non-object `data`/`reads`/`meta` (or, for
 * produces, a missing required `kind`) can't yield a structurally-invalid spec.
 */
export function normalizeContract(raw: Record<string, unknown>): SkillContract {
	const contract: SkillContract = { source: "declared" };
	if (raw.consumes && typeof raw.consumes === "object") {
		const rawConsumes = raw.consumes as Record<string, unknown>;
		const consumes: ConsumesSpec = {};
		// Only carry each sub-field when it's a plain object (reject non-objects),
		// matching the per-field guard the produces branch uses below.
		if (rawConsumes.data && typeof rawConsumes.data === "object") {
			consumes.data = rawConsumes.data as ConsumesSpec["data"];
		}
		if (rawConsumes.reads && typeof rawConsumes.reads === "object" && !Array.isArray(rawConsumes.reads)) {
			consumes.reads = rawConsumes.reads as ConsumesSpec["reads"];
		}
		if (rawConsumes.meta && typeof rawConsumes.meta === "object") {
			consumes.meta = rawConsumes.meta as Record<string, unknown>;
		}
		contract.consumes = consumes;
	}
	if (raw.produces && typeof raw.produces === "object") {
		const rawProduces = raw.produces as Record<string, unknown>;
		// `kind` is REQUIRED on ProducesSpec — default to "produces" when the
		// frontmatter block omits it, rather than a blind cast yielding an invalid spec.
		const produces: ProducesSpec = {
			kind: typeof rawProduces.kind === "string" ? rawProduces.kind : "produces",
		};
		// Only carry a `data` schema when it's a plain object with at least one
		// recognized JSON Schema structural keyword. Objects with no structural
		// keywords (e.g. { foo: 1 }) are silently dropped — they would bypass
		// both load-time lint and runtime validation as unparseable schemas.
		if (rawProduces.data && typeof rawProduces.data === "object") {
			const data = rawProduces.data as Record<string, unknown>;
			if (hasSchemaKeyword(data)) {
				produces.data = data as ProducesSpec["data"];
			}
		}
		if (rawProduces.meta && typeof rawProduces.meta === "object") {
			produces.meta = rawProduces.meta as Record<string, unknown>;
		}
		contract.produces = produces;
	}
	return contract;
}

/**
 * Composition comparator for an artifactKind-tagged named channel. Stateless
 * structural compare: the producer's emitted `produces.meta.artifactKind` must
 * equal the kind the consumer declares it requires on `consumes.reads[channel].meta`.
 * Degrades to `{ ok: true }` when EITHER side omits the tag — the framework stays
 * ontology-blind and a missing kind never HALTs. Channel-
 * generic via `channelName`, so it can adjudicate any artifactKind channel a future
 * consumer registers it for; rpiv-pi wires it to "plans" today.
 */
export function artifactKindComparator(
	produces: ProducesSpec,
	consumes: ConsumesSpec,
	channelName: string,
): SchemaCompatResult {
	const want = (consumes.reads?.[channelName]?.meta as { artifactKind?: unknown } | undefined)?.artifactKind;
	const got = (produces.meta as { artifactKind?: unknown } | undefined)?.artifactKind;
	if (typeof want !== "string" || typeof got !== "string") return { ok: true };
	return want === got
		? { ok: true }
		: {
				ok: false,
				reason: `channel "${channelName}": producer emits artifactKind "${got}", consumer requires "${want}"`,
			};
}

/**
 * Harvest `contract:` frontmatter blocks from a list of resolved skill files.
 * Returns `[skillName, SkillContract]` entries keyed by skill name (which
 * matches the resolved `stage.skill` the registry keys on). Never throws —
 * a malformed or unreadable skill is skipped (loader-never-throws spirit).
 * Shared by the bundled-dir and user-skills builders below.
 */
function contractEntriesFrom(
	skills: ReadonlyArray<{ name: string; filePath: string }>,
): Array<[string, SkillContract]> {
	const entries: Array<[string, SkillContract]> = [];
	for (const skill of skills) {
		try {
			const { frontmatter } = parseFrontmatter(readFileSync(skill.filePath, "utf-8"));
			const contract = (frontmatter as Record<string, unknown>).contract;
			if (!contract || typeof contract !== "object") continue;
			entries.push([skill.name, normalizeContract(contract as Record<string, unknown>)]);
		} catch {
			// skip unreadable / malformed skill
		}
	}
	return entries;
}

/**
 * Scan rpiv-pi's bundled skills dir for `contract:` frontmatter blocks.
 * Never throws — a missing/unreadable dir yields an empty list.
 */
export function buildSkillContractsFromFrontmatter(skillsDir: string): Array<[string, SkillContract]> {
	try {
		return contractEntriesFrom(loadSkillsFromDir({ dir: skillsDir, source: "rpiv-pi" }).skills);
	} catch {
		return [];
	}
}

/**
 * True iff `filePath` lives inside rpiv-pi's bundled skills dir. Both sides
 * are realpath'd so a workspace/npm-link symlink (node_modules entry →
 * package source) can't defeat the check, and the comparison is
 * separator-safe (`skills-extra` is NOT inside `skills`). Fail-soft: if
 * realpath misses (file vanished mid-scan), falls back to a separator-safe
 * literal prefix check.
 */
export function isBundledSkillPath(filePath: string): boolean {
	try {
		const rel = relative(realpathSync(BUNDLED_SKILLS_DIR), realpathSync(filePath));
		return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
	} catch {
		return filePath === BUNDLED_SKILLS_DIR || filePath.startsWith(BUNDLED_SKILLS_DIR + sep);
	}
}

/**
 * Build skill contracts from user-installed skills by enumerating the SAME
 * default locations Pi's own loader reads (`<agentDir>/skills` +
 * `<cwd>/.pi/skills`), via Pi's exported `loadSkills` — so name-collision
 * precedence matches what Pi actually dispatches.
 *
 * Filesystem-based rather than `pi.getCommands()`: Pi invalidates every
 * captured `pi` handle on any session replacement or `/reload` ("extension
 * ctx is stale"), and this builder runs inside a lazy contract provider
 * whose flush time is the first `/wf` load — which can postdate either.
 * The filesystem read has no handle lifetime.
 *
 * Skills shipped by OTHER Pi packages (their `pi.skills` manifest /
 * settings-declared skill paths) are intentionally out of scope — the
 * owning package registers its own contracts via `registerSkillContracts`,
 * exactly as rpiv-pi does for its bundled skills. Bundled rpiv-pi skills
 * are excluded by path (already covered by the `"rpiv-pi"` owner).
 */
export function buildUserSkillContracts(cwd: string = process.cwd()): Array<[string, SkillContract]> {
	let skills: ReadonlyArray<{ name: string; filePath: string }>;
	try {
		skills = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills;
	} catch {
		return [];
	}
	return contractEntriesFrom(skills.filter((s) => !isBundledSkillPath(s.filePath)));
}

/**
 * Register a lazy provider that builds contracts from user-installed skill
 * frontmatter (filesystem enumeration — see `buildUserSkillContracts`).
 * Runs at flush time (first `/wf` load); re-registration on `/reload`
 * re-flushes, so the `"user-skills"` owner snapshot prunes contracts for
 * skills removed since. Missing sibling resolves to a no-op; any other
 * failure re-throws.
 */
export async function registerUserSkillContractsSource(): Promise<void> {
	try {
		const { registerSkillContracts, registerSkillContractsProvider } = await import(
			"@juicesharp/rpiv-workflow/startup"
		);
		registerSkillContractsProvider(() => {
			registerSkillContracts(buildUserSkillContracts(), "user-skills");
		});
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup prompts the user
		throw err;
	}
}

/**
 * Register a lazy provider that builds contracts from bundled skill frontmatter.
 * Missing sibling resolves to a no-op; any other failure re-throws so genuine
 * bugs surface. Fire AFTER registerBuiltInWorkflows (chained in the composer) so
 * the two sibling dynamic imports never race jiti.
 */
export async function registerSkillContractsSource(): Promise<void> {
	try {
		const { registerCompositionComparator, registerSkillContracts, registerSkillContractsProvider } = await import(
			"@juicesharp/rpiv-workflow/startup"
		);
		registerCompositionComparator("plans", artifactKindComparator);
		registerSkillContractsProvider(() => {
			// Reuse the existing PACKAGE_ROOT/skills constant rather than re-deriving
			// the path via an ad-hoc import.meta.url walk.
			// Pass an owner so a `/reload` that drops a skill prunes its stale contract
			// and a divergent override from another extension is surfaced.
			registerSkillContracts(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR), "rpiv-pi");
		});
		// Register the contract-derived outcome resolver so `produces` stages
		// auto-wire `rpivBucketOutcome(bucket)` from `artifactKind` at load time.
		// Dynamic import (not static): `outcome-derivation.js` pulls in
		// `artifact-collector.js`, which value-imports `@juicesharp/rpiv-workflow/registration`
		// at module-eval. A static edge would make THAT a load-time requirement of the
		// whole extension — so when the sibling is absent or not co-located, rpiv-core
		// fails to load entirely (the bug in #66). Deferring it here keeps the sibling
		// edge off the entry path: it only resolves after the `/startup` import above
		// already succeeded, and a missing/non-resolvable sibling degrades to the
		// isModuleNotFound no-op below instead of crashing the extension.
		const { registerOutcomeDerivation } = await import("./outcome-derivation.js");
		await registerOutcomeDerivation();
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup prompts the user
		throw err;
	}
}
