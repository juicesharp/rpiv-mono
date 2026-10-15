/**
 * Pi-free core of skill-contract registration: normalise a skill's `contract:`
 * frontmatter, compare artifact kinds across a named channel, and harvest
 * contracts from SKILL.md files. skill-contracts-source.ts wires these to Pi's
 * skill loader; rpiv-claude wires them to Claude Code's skill directories.
 */

import { readFileSync } from "node:fs";
import type {
	ConsumesSpec,
	ProducesSpec,
	SchemaCompatResult,
	SkillContract,
} from "@juicesharp/rpiv-workflow/registration";
import { parseFrontmatter } from "./frontmatter.js";

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
export function contractEntriesFrom(
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
