import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { acts, defineWorkflow, produces as producesRaw, type StageDef } from "./api.js";
import { noopCollector } from "./outcomes/index.js";
import type { CompositionComparator, SkillContract, SkillContractMap } from "./skill-contract.js";
import {
	__resetSkillContracts,
	canCompose,
	drainSkillContractCollisions,
	drainSkillContractProviderErrors,
	flushSkillContractProviders,
	getCompositionComparators,
	getSkillContracts,
	harvestStageContracts,
	legalNextSkills,
	registerCompositionComparator,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "./skill-contracts/index.js";
import { typeboxSchema } from "./typebox-adapter.js";

/** Strip symbol keys from an object tree for deep-equal comparison. */
function stripSymbols(value: unknown): unknown {
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(stripSymbols);
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>)) {
		out[key] = stripSymbols((value as Record<string, unknown>)[key]);
	}
	return out;
}

describe("skill-contracts", () => {
	afterEach(() => __resetSkillContracts());

	const declared: SkillContract = { source: "declared", produces: { kind: "produces" } };
	const harvested: SkillContract = { source: "harvested", consumes: { reads: { x: {} } } };

	it("registerSkillContracts is idempotent on name (re-register replaces)", () => {
		registerSkillContracts([
			["research", declared],
			["design", harvested],
		]);
		const updated: SkillContract = { source: "declared", consumes: { data: { type: "object" } } };
		registerSkillContracts([["research", updated]]);
		const reg = getSkillContracts();
		expect(reg.get("research")).toBe(updated);
		expect(reg.get("design")).toBe(harvested);
	});

	it("a thrown provider does NOT reject flushSkillContractProviders but IS recorded", async () => {
		const boom = new Error("provider boom");
		registerSkillContractsProvider(() => {
			throw boom;
		});
		await flushSkillContractProviders();
		const errors = drainSkillContractProviderErrors();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBe(boom);
		// Second drain is empty (drained)
		expect(drainSkillContractProviderErrors()).toHaveLength(0);
	});

	it("flush memoizes (second call is a no-op)", async () => {
		let runs = 0;
		registerSkillContractsProvider(() => {
			runs++;
		});
		await flushSkillContractProviders();
		await flushSkillContractProviders();
		expect(runs).toBe(1);
	});

	it("__resetSkillContracts empties the registry + provider list + failures + collisions + owners + flush latch", async () => {
		registerSkillContracts([["research", declared]]);
		registerSkillContractsProvider(() => {
			registerSkillContracts([["late", declared]]);
		});
		// Flush runs the provider
		await flushSkillContractProviders();
		expect(getSkillContracts().size).toBe(2);

		__resetSkillContracts();

		expect(getSkillContracts().size).toBe(0);
		// Provider list is empty — re-flush is a no-op (but memoized as undefined → actually runs fresh)
		await flushSkillContractProviders();
		expect(getSkillContracts().size).toBe(0);
		expect(drainSkillContractProviderErrors()).toHaveLength(0);
		expect(drainSkillContractCollisions()).toHaveLength(0);
	});

	describe("owner-scoping (#12 prune + #4 collision)", () => {
		it("owner re-registration prunes skills no longer included", () => {
			registerSkillContracts(
				[
					["research", declared],
					["design", declared],
				],
				"rpiv-pi",
			);
			registerSkillContracts([["research", declared]], "rpiv-pi");
			const reg = getSkillContracts();
			expect(reg.has("research")).toBe(true);
			expect(reg.has("design")).toBe(false);
		});

		it("owner prune does not affect other owners' entries", () => {
			registerSkillContracts([["research", declared]], "owner-a");
			registerSkillContracts([["design", declared]], "owner-b");
			registerSkillContracts([["research", declared]], "owner-a");
			const reg = getSkillContracts();
			expect(reg.has("research")).toBe(true);
			expect(reg.has("design")).toBe(true);
		});

		it("different owner registering same name with divergent contract pushes a collision", () => {
			registerSkillContracts([["research", declared]], "owner-a");
			const different: SkillContract = { source: "declared", produces: { kind: "side-effect" } };
			registerSkillContracts([["research", different]], "owner-b");
			const collisions = drainSkillContractCollisions();
			expect(collisions).toHaveLength(1);
			expect(collisions[0]).toContain("research");
			expect(collisions[0]).toContain("owner-b");
			expect(collisions[0]).toContain("owner-a");
			// Second drain is empty
			expect(drainSkillContractCollisions()).toHaveLength(0);
		});

		it("identical re-register from same owner records nothing", () => {
			registerSkillContracts([["research", declared]], "owner-a");
			registerSkillContracts([["research", declared]], "owner-a");
			expect(drainSkillContractCollisions()).toHaveLength(0);
		});

		it("identical re-register from different owner records nothing", () => {
			registerSkillContracts([["research", declared]], "owner-a");
			registerSkillContracts([["research", declared]], "owner-b");
			expect(drainSkillContractCollisions()).toHaveLength(0);
		});

		it("semantically-identical contract with different key order records nothing", () => {
			// Same data, different insertion order — a JSON.stringify compare would
			// read these as divergent and raise a spurious collision; the structural
			// deepEqual compare treats them as identical.
			const a: SkillContract = {
				source: "declared",
				consumes: { data: { type: "object", properties: { x: { type: "string" } } } },
				produces: { kind: "produces", meta: { artifactKind: "research" } },
			};
			const b: SkillContract = {
				produces: { meta: { artifactKind: "research" }, kind: "produces" },
				consumes: { data: { properties: { x: { type: "string" } }, type: "object" } },
				source: "declared",
			};
			registerSkillContracts([["research", a]], "owner-a");
			registerSkillContracts([["research", b]], "owner-b");
			expect(drainSkillContractCollisions()).toHaveLength(0);
		});

		it("anonymous registration relinquishes ownership claim", () => {
			registerSkillContracts([["research", declared]], "owner-a");
			registerSkillContracts([["research", declared]]); // anonymous
			// Now owner-a re-registers — no collision because anonymous took over
			registerSkillContracts([["research", declared]], "owner-a");
			expect(drainSkillContractCollisions()).toHaveLength(0);
		});
	});

	describe("harvestStageContracts", () => {
		const STUB_OUTCOME = { collector: noopCollector };
		const produces = (overrides: Partial<StageDef> = {}): StageDef =>
			producesRaw({ outcome: STUB_OUTCOME, ...overrides });

		it("harvests produces.data and consumes.data from typeboxSchema stages", () => {
			const w = defineWorkflow({
				name: "test",
				start: "a",
				stages: {
					a: produces({ outputSchema: typeboxSchema(Type.Object({ result: Type.String() })) }),
					b: producesRaw({
						outcome: STUB_OUTCOME,
						inputSchema: typeboxSchema(Type.Object({ result: Type.String() })),
					}),
				},
				edges: { a: "b", b: "stop" },
			});
			const harvested = harvestStageContracts([w]);
			// Stage 'a' dispatches skill 'a' (no explicit skill field)
			const aContract = harvested.get("a");
			expect(aContract).toBeDefined();
			expect(aContract?.source).toBe("harvested");
			expect(aContract?.produces?.kind).toBe("produces");
			expect(stripSymbols(aContract?.produces?.data)).toEqual({
				type: "object",
				properties: { result: { type: "string" } },
				required: ["result"],
			});
			// Stage 'b' dispatches skill 'b'
			const bContract = harvested.get("b");
			expect(bContract).toBeDefined();
			expect(stripSymbols(bContract?.consumes?.data)).toEqual({
				type: "object",
				properties: { result: { type: "string" } },
				required: ["result"],
			});
		});

		it("skips non-dispatching stages (run/prompt)", () => {
			const w = defineWorkflow({
				name: "test",
				start: "a",
				stages: {
					a: acts({ run: async () => {} }),
				},
				edges: { a: "stop" },
			});
			const harvested = harvestStageContracts([w]);
			expect(harvested.size).toBe(0);
		});

		it("harvests reads from stage.reads", () => {
			const w = defineWorkflow({
				name: "test",
				start: "a",
				stages: {
					a: producesRaw({ outcome: STUB_OUTCOME, reads: ["research"] }),
				},
				edges: { a: "stop" },
			});
			const harvested = harvestStageContracts([w]);
			const contract = harvested.get("a");
			expect(contract?.consumes?.reads).toEqual({ research: {} });
		});

		it("does not harvest meta (declared-only)", () => {
			const w = defineWorkflow({
				name: "test",
				start: "a",
				stages: { a: produces() },
				edges: { a: "stop" },
			});
			const harvested = harvestStageContracts([w]);
			const contract = harvested.get("a");
			expect(contract?.produces?.meta).toBeUndefined();
			expect(contract?.consumes?.meta).toBeUndefined();
		});

		it("last-writer wins when multiple stages dispatch the same skill", () => {
			const w = defineWorkflow({
				name: "test",
				start: "a",
				stages: {
					a: produces({ outputSchema: typeboxSchema(Type.Object({ v: Type.Number() })) }),
					b: produces({ outputSchema: typeboxSchema(Type.Object({ v: Type.String() })) }),
				},
				edges: { a: "b", b: "stop" },
			});
			(w.stages.b as StageDef).skill = "a"; // both dispatch skill "a"
			const harvested = harvestStageContracts([w]);
			const contract = harvested.get("a");
			expect(stripSymbols(contract?.produces?.data)).toEqual({
				type: "object",
				properties: { v: { type: "string" } },
				required: ["v"],
			});
		});
	});

	describe("canCompose", () => {
		const stringProducer: SkillContract = {
			source: "declared",
			produces: {
				kind: "produces",
				data: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			},
		};
		const stringConsumer: SkillContract = {
			source: "declared",
			consumes: {
				data: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			},
		};
		const numberConsumer: SkillContract = {
			source: "declared",
			consumes: {
				data: { type: "object", properties: { name: { type: "number" } }, required: ["name"] },
			},
		};
		const noDataConsumer: SkillContract = {
			source: "declared",
			consumes: { reads: { x: {} } },
		};

		it("returns ok:true for compatible schemas", () => {
			registerSkillContracts([
				["research", stringProducer],
				["design", stringConsumer],
			]);
			expect(canCompose("research", "design")).toEqual({ ok: true });
		});

		it("returns ok:false for incompatible schemas", () => {
			registerSkillContracts([
				["research", stringProducer],
				["design", numberConsumer],
			]);
			const result = canCompose("research", "design");
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("name");
		});

		it("returns ok:true when consumer has no consumes.data (degrade)", () => {
			registerSkillContracts([
				["research", stringProducer],
				["side-effect", noDataConsumer],
			]);
			expect(canCompose("research", "side-effect")).toEqual({ ok: true });
		});

		it("returns ok:true when producer has no produces.data (degrade)", () => {
			registerSkillContracts([
				["research", { source: "declared", produces: { kind: "produces" } }],
				["design", numberConsumer],
			]);
			expect(canCompose("research", "design")).toEqual({ ok: true });
		});

		it("returns ok:true when neither skill is in the registry (unknown)", () => {
			expect(canCompose("unknown-a", "unknown-b")).toEqual({ ok: true });
		});

		it("accepts an explicit contracts map", () => {
			const map = new Map([
				["research", stringProducer],
				["design", numberConsumer],
			]);
			const result = canCompose("research", "design", map);
			expect(result.ok).toBe(false);
		});
	});

	describe("legalNextSkills", () => {
		const stringProducer: SkillContract = {
			source: "declared",
			produces: {
				kind: "produces",
				data: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			},
		};
		const stringConsumer: SkillContract = {
			source: "declared",
			consumes: {
				data: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			},
		};
		const numberConsumer: SkillContract = {
			source: "declared",
			consumes: {
				data: { type: "object", properties: { name: { type: "number" } }, required: ["name"] },
			},
		};

		it("includes compatible skills and excludes incompatible ones", () => {
			registerSkillContracts([
				["research", stringProducer],
				["design", stringConsumer],
				["validate", numberConsumer],
			]);
			const next = legalNextSkills("research");
			expect(next).toContain("design");
			expect(next).not.toContain("validate");
		});

		it("returns sorted results", () => {
			registerSkillContracts([
				["research", stringProducer],
				["alpha", stringConsumer],
				["zeta", stringConsumer],
			]);
			const next = legalNextSkills("research");
			expect(next).toEqual(["alpha", "research", "zeta"]);
		});

		it("accepts an explicit contracts map", () => {
			const map = new Map([
				["research", stringProducer],
				["design", stringConsumer],
			]);
			const next = legalNextSkills("research", map);
			expect(next).toContain("design");
		});
	});

	describe("canCompose — reads-channel (meta) promotion", () => {
		const kindComparator: CompositionComparator = (produces, consumes, ch) => {
			const want = (consumes.reads?.[ch]?.meta as { artifactKind?: string } | undefined)?.artifactKind;
			const got = (produces.meta as { artifactKind?: string } | undefined)?.artifactKind;
			return !want || !got || want === got ? { ok: true } : { ok: false, reason: "artifactKind mismatch" };
		};
		const contracts: SkillContractMap = new Map([
			["blueprint", { source: "declared", produces: { kind: "produces", meta: { artifactKind: "plan" } } }],
			["revise", { source: "declared", produces: { kind: "produces", meta: { artifactKind: "plan" } } }],
			["design", { source: "declared", produces: { kind: "produces", meta: { artifactKind: "design" } } }],
			["implement", { source: "declared", consumes: { reads: { plans: { meta: { artifactKind: "plan" } } } } }],
		]);

		it("positively adjudicates a matching reads edge via the registered comparator", () => {
			registerCompositionComparator("plans", kindComparator);
			expect(canCompose("blueprint", "implement", contracts).ok).toBe(true);
		});
		it('multi-publisher: revise also composes into implement (both publish plan to "plans")', () => {
			registerCompositionComparator("plans", kindComparator);
			expect(canCompose("revise", "implement", contracts).ok).toBe(true);
		});
		it("rejects a reads edge whose producer kind is disjoint", () => {
			registerCompositionComparator("plans", kindComparator);
			expect(canCompose("design", "implement", contracts).ok).toBe(false);
		});
		it("degrades (ok) when no comparator is registered", () => {
			expect(canCompose("design", "implement", contracts).ok).toBe(true);
		});
	});

	describe("composition comparators", () => {
		const plansComparator: CompositionComparator = () => ({ ok: true });

		it("registers a comparator under its channel name", () => {
			registerCompositionComparator("plans", plansComparator);
			expect(getCompositionComparators().get("plans")).toBe(plansComparator);
		});

		it("is idempotent on channel name (re-register replaces)", () => {
			const first: CompositionComparator = () => ({ ok: true });
			const second: CompositionComparator = () => ({ ok: false, reason: "x" });
			registerCompositionComparator("plans", first);
			registerCompositionComparator("plans", second);
			expect(getCompositionComparators().get("plans")).toBe(second);
			expect(getCompositionComparators().size).toBe(1);
		});

		it("__resetSkillContracts clears the comparator slot", () => {
			registerCompositionComparator("plans", plansComparator);
			expect(getCompositionComparators().size).toBe(1);
			__resetSkillContracts();
			expect(getCompositionComparators().size).toBe(0);
		});
	});
});
