/**
 * Tests for the skill-contracts-source module: frontmatter → contract builder
 * and the guarded sibling registration.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
	__resetSkillContracts,
	buildEffectiveContracts,
	drainSkillContractCollisions,
	flushSkillContractProviders,
	harvestStageContracts,
} from "@juicesharp/rpiv-workflow/internal";
import type { ConsumesSpec, ProducesSpec, SkillContract } from "@juicesharp/rpiv-workflow/registration";
import { defineWorkflow, produces } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInWorkflows } from "./built-in-workflows.js";
import { BUNDLED_SKILLS_DIR } from "./paths.js";
import {
	artifactKindComparator,
	buildSkillContractsFromFrontmatter,
	buildUserSkillContracts,
	isBundledSkillPath,
	normalizeContract,
	registerSkillContractsSource,
} from "./skill-contracts-source.js";

/** Create a temp dir with skill subdirs; caller must rmSync when done. */
function makeSkillsDir(baseDir: string, skills: Record<string, string /* SKILL.md content */>): string {
	for (const [name, content] of Object.entries(skills)) {
		const skillDir = join(baseDir, name);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), content);
	}
	return baseDir;
}

describe("buildSkillContractsFromFrontmatter", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = "" as string;
		}
	});

	it("returns [] for a skills dir whose SKILL.md files carry no contract: block", () => {
		tmpDir = join(process.env.HOME!, `test-skills-no-contract-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			research: `---\ndescription: Research skill\n---\nBody here`,
			plan: `---\ndescription: Plan skill\n---\nBody here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toEqual([]);
	});

	it("returns [name, {source:'declared', ...}] for a skill with a contract: block", () => {
		tmpDir = join(process.env.HOME!, `test-skills-with-contract-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			research: `---
description: Research skill
contract:
  produces:
    kind: produces
    data:
      type: object
      properties:
        findings:
          type: string
    meta:
      artifactKind: research
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0][0]).toBe("research");
		expect(result[0][1]).toEqual({
			source: "declared",
			produces: {
				kind: "produces",
				data: { type: "object", properties: { findings: { type: "string" } } },
				meta: { artifactKind: "research" },
			},
		});
	});

	it("returns [] for a nonexistent skills dir", () => {
		const result = buildSkillContractsFromFrontmatter(
			`/nonexistent/path/skills-${Math.random().toString(36).slice(2)}`,
		);
		expect(result).toEqual([]);
	});

	it("defaults produces.kind to 'produces' when omitted in frontmatter", () => {
		tmpDir = join(process.env.HOME!, `test-skills-default-kind-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			mySkill: `---
description: My skill
contract:
  produces:
    data:
      type: object
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0][1].produces?.kind).toBe("produces");
	});

	it("carries a consumes block through, per-field, into the contract", () => {
		tmpDir = join(process.env.HOME!, `test-skills-consumes-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			design: `---
description: Design skill
contract:
  consumes:
    data:
      type: object
      properties:
        findings:
          type: string
    reads:
      research: {}
    meta:
      artifactKind: research
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0][0]).toBe("design");
		expect(result[0][1]).toEqual({
			source: "declared",
			consumes: {
				data: { type: "object", properties: { findings: { type: "string" } } },
				reads: { research: {} },
				meta: { artifactKind: "research" },
			},
		});
	});

	it("skips non-object consumes sub-fields without crashing", () => {
		tmpDir = join(process.env.HOME!, `test-skills-bad-consumes-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			design: `---
description: Design skill
contract:
  consumes:
    data: "not-an-object"
    meta:
      artifactKind: research
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		// data (a string) is dropped; the valid meta still carries through.
		expect(result[0][1].consumes).toEqual({ meta: { artifactKind: "research" } });
	});

	it("skips non-object produces.data without crashing", () => {
		tmpDir = join(process.env.HOME!, `test-skills-bad-data-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		makeSkillsDir(tmpDir, {
			mySkill: `---
description: My skill
contract:
  produces:
    kind: produces
    data: "not-an-object"
---
Body here`,
		});
		const result = buildSkillContractsFromFrontmatter(tmpDir);
		expect(result).toHaveLength(1);
		// data should be omitted since it's a string, not an object
		expect(result[0][1].produces?.data).toBeUndefined();
	});
});

describe("normalizeContract produces.data keyword guard", () => {
	it("drops produces.data lacking any recognized JSON Schema keyword", () => {
		// A frontmatter typo like { data: { foo: 1 } } should be silently dropped,
		// matching the parser's degrade-on-malformed posture.
		const contract = normalizeContract({
			produces: { kind: "produces", data: { foo: 1 } },
		});
		expect(contract.produces?.data).toBeUndefined();
	});

	it("keeps produces.data with a recognized JSON Schema keyword", () => {
		const contract = normalizeContract({
			produces: {
				kind: "produces",
				data: { type: "object", properties: { topic: { type: "string" } } },
			},
		});
		expect(contract.produces?.data).toBeDefined();
		expect((contract.produces!.data as Record<string, unknown>).type).toBe("object");
	});
});

describe("bundled skill contracts", () => {
	// The 12 pipeline skills carry a contract: block. This is the count the /wf
	// banner reports as "N declared" — a drift guard if a block is added,
	// dropped, or fails to parse (a malformed block is silently skipped).
	const declared = new Map(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR));

	it("declares a contract for the 26 pipeline + orthogonal skills", () => {
		expect(declared.size).toBe(26);
		for (const name of [
			"discover",
			"research",
			"explore",
			"design",
			"plan",
			"blueprint",
			"architecture-review",
			"code-review",
			"validate",
			"revise",
			"implement",
			"commit",
			"annotate-guidance",
			"annotate-inline",
			"changelog",
			"create-handoff",
			"resume-handoff",
			"frontend-design",
			"migrate-to-guidance",
			"pr-triage",
			"slice",
			"design-slice",
			"synthesize",
			"elaborate",
			"grade",
			"amend",
		]) {
			expect(declared.has(name)).toBe(true);
		}
	});

	it("blueprint declares phases as a required produces.data field (derived from the body headings)", () => {
		const data = declared.get("blueprint")?.produces?.data as
			| { required?: string[]; properties?: { phases?: unknown } }
			| undefined;
		expect(data?.required).toContain("phases");
		expect(data?.properties?.phases).toBeDefined();
	});

	it("architecture-review declares phases as a required produces.data field (derived from the body headings)", () => {
		const data = declared.get("architecture-review")?.produces?.data as
			| { required?: string[]; properties?: { phases?: unknown } }
			| undefined;
		expect(data?.required).toContain("phases");
		expect(data?.properties?.phases).toBeDefined();
	});

	it("documents the declared-but-not-harvested orthogonal set", () => {
		// These skills declare a contract but don't appear in any built-in workflow.
		// The orthogonal set: 7 doc/util + discover + explore + commit = 10 skills.
		// The entire slice-flow (slice/design-slice/synthesize/grade/amend/elaborate)
		// IS now harvested by the `carve` built-in.
		// (pr-triage IS harvested — it's dispatched by the pr-triage workflow.)
		const harvested = harvestStageContracts(builtInWorkflows);
		const notHarvested: string[] = [];
		for (const [name] of declared) {
			if (!harvested.has(name)) notHarvested.push(name);
		}
		expect(notHarvested.sort()).toEqual(
			[
				"annotate-guidance",
				"annotate-inline",
				"changelog",
				"commit",
				"create-handoff",
				"discover",
				"explore",
				"frontend-design",
				"migrate-to-guidance",
				"resume-handoff",
			].sort(),
		);
	});

	it("every declared kind matches the harvested kind for the six built-in workflows", () => {
		// Harvest derives each dispatched skill's kind from how the built-ins use
		// it (produces() → "produces", acts() → "side-effect"). A declared kind
		// that disagrees would make the rendered graph lie — catch it here.
		// Side-effect skills legitimately declare `produces.kind: "side-effect"` in
		// their contract (for graph rendering), but `harvestStageContracts` doesn't
		// create a `produces` for stages without outputSchema — so the harvested
		// contract has no `produces` at all. Skip the comparison for this case.
		const harvested = harvestStageContracts(builtInWorkflows);
		expect(harvested.size).toBeGreaterThan(0);
		for (const [skill, h] of harvested) {
			const d = declared.get(skill);
			expect(d, `skill "${skill}" is dispatched by a built-in but declares no contract`).toBeDefined();
			const declaredKind = d?.produces?.kind;
			const harvestedKind = h.produces?.kind;
			if (declaredKind === "side-effect" && harvestedKind === undefined) continue;
			expect(declaredKind, `kind drift for "${skill}"`).toBe(harvestedKind);
		}
	});

	it("implement declares the required artifactKind on its reads.plans channel", () => {
		const reads = declared.get("implement")?.consumes?.reads as
			| { plans?: { meta?: { artifactKind?: string } } }
			| undefined;
		expect(reads?.plans?.meta?.artifactKind).toBe("plan");
	});

	it("design, plan, and blueprint require a status:ready upstream via consumes.data", () => {
		for (const skill of ["design", "plan", "blueprint"]) {
			const data = declared.get(skill)?.consumes?.data as
				| { properties?: { status?: { const?: string } } }
				| undefined;
			expect(data?.properties?.status?.const, skill).toBe("ready");
		}
	});

	it("registerSkillContractsSource registers the plans composition comparator eagerly", async () => {
		const { getCompositionComparators } = await import("@juicesharp/rpiv-workflow/internal");
		await registerSkillContractsSource();
		expect(getCompositionComparators().has("plans")).toBe(true);
	});

	it("plan's inline template (no templates/ dir) writes its required produces.data fields", () => {
		const required = (declared.get("plan")?.produces?.data as { required?: string[] }).required!;
		const body = readFileSync(join(BUNDLED_SKILLS_DIR, "plan", "SKILL.md"), "utf-8");
		// Scan for ---…--- frontmatter regions (robust to the ```! executable block
		// at SKILL.md:46 that shifts naive fence-pair parity, and to nested fences
		// inside the ```markdown template). The artifact template's frontmatter is
		// uniquely identified by having both phases: and phase_count:.
		const fronts = [...body.matchAll(/---\n([\s\S]*?)\n---/g)].map((m) => m[1]!);
		const template = fronts.find((b) => /\bphases:/.test(b) && /\bphase_count:/.test(b));
		expect(template, "plan: no inline template block with phases + phase_count").toBeDefined();
		for (const field of required) {
			expect(template!, `plan template missing ${field}`).toMatch(new RegExp(`(^|\\n)\\s*${field}:`));
		}
	});

	it("architecture-review template carries the required layer_count field", () => {
		const required = (declared.get("architecture-review")?.produces?.data as { required?: string[] }).required!;
		expect(required).toContain("layer_count");
		const dir = join(BUNDLED_SKILLS_DIR, "architecture-review", "templates");
		const text = readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => readFileSync(join(dir, f), "utf-8"))
			.join("\n");
		expect(text, "architecture-review template missing layer_count").toMatch(/(^|\n)layer_count:/);
	});

	it("every produces.data.required field is a declared property (contract self-coherence)", () => {
		let checked = 0;
		for (const [skill, contract] of declared) {
			const data = contract.produces?.data as
				| { required?: string[]; properties?: Record<string, unknown> }
				| undefined;
			if (!data?.required?.length) continue;
			for (const field of data.required) {
				checked++;
				expect(data.properties?.[field], `${skill}: required "${field}" is not a declared property`).toBeDefined();
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("side-effect skills declare no produces.data", () => {
		// kind: side-effect means the skill describes itself via meta/reads, not
		// an adjudicated data channel — side-effects fill meta, not data.
		const sideEffectSkills = [
			"implement",
			"commit",
			"annotate-guidance",
			"annotate-inline",
			"changelog",
			"resume-handoff",
			"frontend-design",
			"migrate-to-guidance",
		];
		for (const name of sideEffectSkills) {
			expect(declared.get(name)?.produces?.kind, `${name}: kind`).toBe("side-effect");
			expect(declared.get(name)?.produces?.data, `${name}: produces.data`).toBeUndefined();
		}
	});

	// Template/contract coherence — the drift that bit us at RUNTIME (a validate
	// artifact wrote `status: complete`, which the contract enum rejected). Catch it at build
	// time instead: every enum-constrained `status`/`verdict` value a skill
	// TEMPLATE tells the LLM to write must be a member of the contract enum.
	// A template value is either a literal (`status: ready`) or a placeholder set
	// (`status: {in-progress | ready}`) — every candidate must be in the enum.
	it("each template's status/verdict frontmatter stays within the contract enum", () => {
		const enumOf = (skill: string, field: string): string[] | undefined => {
			const props = (declared.get(skill)?.produces?.data as { properties?: Record<string, { enum?: string[] }> })
				?.properties;
			return props?.[field]?.enum;
		};
		const templateValues = (raw: string, field: string): string[] => {
			const m = raw.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
			if (!m) return [];
			const val = m[1]!.trim();
			const brace = val.match(/^\{(.+)\}$/);
			return brace ? brace[1]!.split("|").map((s) => s.trim()) : [val];
		};
		let templatesChecked = 0;
		for (const skill of declared.keys()) {
			let files: string[];
			try {
				files = readdirSync(join(BUNDLED_SKILLS_DIR, skill, "templates")).filter((f) => f.endsWith(".md"));
			} catch {
				continue; // skill has no templates/ dir — body-only, nothing to cross-check here
			}
			for (const file of files) {
				const raw = readFileSync(join(BUNDLED_SKILLS_DIR, skill, "templates", file), "utf-8");
				for (const field of ["status", "verdict"]) {
					const allowed = enumOf(skill, field);
					if (!allowed) continue;
					for (const value of templateValues(raw, field)) {
						templatesChecked++;
						expect(
							allowed,
							`${skill}/templates/${file}: ${field} "${value}" is not in the contract enum [${allowed.join(", ")}]`,
						).toContain(value);
					}
				}
			}
		}
		// Guard the guard — if this drops to 0 the check silently passes forever.
		expect(templatesChecked).toBeGreaterThan(0);
	});
});

describe("artifactKindComparator (plans channel)", () => {
	const produces = (artifactKind?: string): ProducesSpec => ({
		kind: "produces",
		...(artifactKind ? { meta: { artifactKind } } : {}),
	});
	const consumes = (artifactKind?: string): ConsumesSpec => ({
		reads: { plans: artifactKind ? { meta: { artifactKind } } : {} },
	});

	it("ok when producer kind matches the consumer's required kind", () => {
		expect(artifactKindComparator(produces("plan"), consumes("plan"), "plans")).toEqual({ ok: true });
	});
	it("fails with a channel-named reason when kinds are disjoint", () => {
		const r = artifactKindComparator(produces("design"), consumes("plan"), "plans");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("plans");
	});
	it("degrades (ok) when either side omits the kind", () => {
		expect(artifactKindComparator(produces(), consumes("plan"), "plans")).toEqual({ ok: true });
		expect(artifactKindComparator(produces("plan"), consumes(), "plans")).toEqual({ ok: true });
	});
});

describe("registerSkillContractsSource", () => {
	describe("when the rpiv-workflow sibling is absent", () => {
		afterEach(() => {
			vi.doUnmock("@juicesharp/rpiv-workflow/startup");
			vi.resetModules();
		});

		it("no-ops without throwing", async () => {
			vi.resetModules();
			vi.doMock("@juicesharp/rpiv-workflow/startup", () => {
				throw Object.assign(new Error("Cannot find package '@juicesharp/rpiv-workflow'"), {
					code: "ERR_MODULE_NOT_FOUND",
				});
			});

			const fresh = await import("./skill-contracts-source.js");
			await expect(fresh.registerSkillContractsSource()).resolves.toBeUndefined();
		});
	});
});

describe("buildUserSkillContracts", () => {
	const userSkillsDir = () => join(process.env.HOME!, ".pi", "agent", "skills");
	let projectDir: string;

	afterEach(() => {
		rmSync(userSkillsDir(), { recursive: true, force: true });
		if (projectDir) {
			rmSync(projectDir, { recursive: true, force: true });
			projectDir = "" as string;
		}
	});

	const writeSkill = (baseDir: string, name: string, content: string) => {
		const dir = join(baseDir, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), content);
	};

	const CONTRACT_SKILL = `---
description: Custom review skill
contract:
  produces:
    kind: produces
    meta:
      artifactKind: review
---
Body here`;

	it("returns contracts for skills in the global user skills dir (<agentDir>/skills)", () => {
		writeSkill(userSkillsDir(), "my-custom-review", CONTRACT_SKILL);
		const result = buildUserSkillContracts();
		expect(result).toHaveLength(1);
		expect(result[0]![0]).toBe("my-custom-review");
		expect(result[0]![1]).toEqual({
			source: "declared",
			produces: { kind: "produces", meta: { artifactKind: "review" } },
		});
	});

	it("returns contracts for project-local skills (<cwd>/.pi/skills)", () => {
		projectDir = mkdtempSync(join(tmpdir(), "rpiv-user-skill-proj-"));
		writeSkill(join(projectDir, ".pi", "skills"), "proj-review", CONTRACT_SKILL);
		const result = buildUserSkillContracts(projectDir);
		expect(result.map(([name]) => name)).toContain("proj-review");
	});

	it("skips skills without contract: frontmatter", () => {
		writeSkill(
			userSkillsDir(),
			"plain-skill",
			`---
description: Plain skill
---
Body here`,
		);
		expect(buildUserSkillContracts()).toEqual([]);
	});

	it("returns [] when no user skill dirs exist", () => {
		projectDir = mkdtempSync(join(tmpdir(), "rpiv-user-skill-empty-"));
		expect(buildUserSkillContracts(projectDir)).toEqual([]);
	});
});

describe("isBundledSkillPath", () => {
	it("a path inside the bundled skills dir is bundled; a sibling dir sharing the prefix is not", () => {
		expect(isBundledSkillPath(join(BUNDLED_SKILLS_DIR, "research", "SKILL.md"))).toBe(true);
		expect(isBundledSkillPath(`${BUNDLED_SKILLS_DIR}-extra${sep}research${sep}SKILL.md`)).toBe(false);
		expect(isBundledSkillPath(join(tmpdir(), "elsewhere", "SKILL.md"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("resolves symlinks: a link into the bundled dir is bundled", () => {
		const linkParent = mkdtempSync(join(tmpdir(), "rpiv-bundled-link-"));
		try {
			const link = join(linkParent, "skills-link");
			symlinkSync(BUNDLED_SKILLS_DIR, link);
			expect(isBundledSkillPath(link)).toBe(true);
		} finally {
			rmSync(linkParent, { recursive: true, force: true });
		}
	});
});

describe("registerUserSkillContractsSource", () => {
	describe("when the rpiv-workflow sibling is absent", () => {
		afterEach(() => {
			vi.doUnmock("@juicesharp/rpiv-workflow/startup");
			vi.resetModules();
		});

		it("no-ops without throwing", async () => {
			vi.resetModules();
			vi.doMock("@juicesharp/rpiv-workflow/startup", () => {
				throw Object.assign(new Error("Cannot find package '@juicesharp/rpiv-workflow'"), {
					code: "ERR_MODULE_NOT_FOUND",
				});
			});
			const fresh = await import("./skill-contracts-source.js");
			await expect(fresh.registerUserSkillContractsSource()).resolves.toBeUndefined();
		});
	});
});

describe("end-to-end: user-skill contract \u2192 effective contract map", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = "" as string;
		}
		__resetSkillContracts();
	});

	it("a stage dispatching a user-installed skill gets its contract in the effective map", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-e2e-user-skill-"));
		// Project-local skill location — buildUserSkillContracts(tmpDir) reads <cwd>/.pi/skills.
		const skillDir = join(tmpDir, ".pi", "skills", "my-custom-review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
description: Custom review
contract:
  produces:
    kind: produces
    meta:
      artifactKind: review
---
Body`,
		);
		// Simulate what the loader does: register the user-skill contract provider, then flush
		const { registerSkillContractsProvider, registerSkillContracts } = await import(
			"@juicesharp/rpiv-workflow/startup"
		);
		registerSkillContractsProvider(() => {
			registerSkillContracts(buildUserSkillContracts(tmpDir), "user-skills");
		});
		await flushSkillContractProviders();

		// A workflow stage dispatching the user skill (stage name = skill name)
		const w = defineWorkflow({
			name: "test-e2e",
			start: "my-custom-review",
			stages: {
				"my-custom-review": produces(),
			},
			edges: { "my-custom-review": "stop" },
		});

		const contracts = buildEffectiveContracts([w]);

		expect(contracts.get("my-custom-review")?.produces?.meta).toEqual({ artifactKind: "review" });
	});
});

describe("owner collision: user-skills vs rpiv-pi", () => {
	afterEach(() => {
		__resetSkillContracts();
	});

	it("surfaces collision when user-skill contract diverges from bundled", async () => {
		const { registerSkillContracts } = await import("@juicesharp/rpiv-workflow/startup");
		const bundled: SkillContract = {
			source: "declared",
			produces: { kind: "produces", meta: { artifactKind: "review" } },
		};
		const user: SkillContract = {
			source: "declared",
			produces: { kind: "produces", meta: { artifactKind: "custom-review" } },
		};
		registerSkillContracts([["code-review", bundled]], "rpiv-pi");
		registerSkillContracts([["code-review", user]], "user-skills");
		const collisions = drainSkillContractCollisions();
		expect(collisions).toHaveLength(1);
		expect(collisions[0]).toContain("code-review");
		expect(collisions[0]).toContain("user-skills");
		expect(collisions[0]).toContain("rpiv-pi");
	});
});
