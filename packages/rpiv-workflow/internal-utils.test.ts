/**
 * Parity tests for `applyCompletedStage` — the single authority for
 * "a completed produces stage mutates the rolling artifact state."
 *
 * Covers the four stage-kind cases in one place (no duplication across
 * `runner/script-stage.ts:advancePrimaryForScript` and
 * `sessions/sessions.ts:maybeAdvancePrimary`:
 *   1. produces-with-artifacts  → primary advances, named appends
 *   2. produces with empty artifacts → primary unchanged, named still appends
 *   3. side-effect (acts)       → primary + named untouched
 *   4. terminal (inheritsArtifacts: false) → primary cleared
 *
 * Plus named-slot append-order (array history preserved across repeated
 * calls to the same key).
 */

import { describe, expect, it } from "vitest";
import type { StageDef } from "./api.js";
import { applyCompletedStage, resolveSkill } from "./chain-state.js";
import type { Artifact } from "./handle.js";
import { fs as fsHandle } from "./handle.js";
import { globalSlot, lazyProviderRegistry, withTimeout } from "./internal-utils.js";
import type { Output } from "./output.js";
import type { RunState } from "./types.js";
import { SchemaTimeoutError } from "./validate-output.js";

// NOTE: test/setup.ts runs beforeEach and clears globalThis Symbol.for slots via
// __resetSkillContracts. globalSlot tests below use dedicated Symbol.for keys
// (prefixed test:) and clean up after themselves to avoid cross-pollution.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeArtifact = (path: string): Artifact => ({ handle: fsHandle(path), role: "primary" });

const fakeOutput = (artifacts: readonly Artifact[] = []): Output => ({
	kind: "artifacts",
	artifacts,
	data: {},
	meta: { stage: "test", stageNumber: 1, ts: "", runId: "" },
});

const freshState = (): RunState => ({
	originalInput: "",
	primaryArtifact: undefined,
	output: undefined,
	named: {},
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: { backwardJumps: 0, droppedRoutingRows: [], droppedFailureRows: [] },
	termination: { status: "running" },
});

/** Minimal produces stage def — `applyCompletedStage` only reads `kind` and `outcome?.name`. */
const producesDef = (outcomeName?: string): StageDef =>
	({
		kind: "produces",
		sessionPolicy: "fresh",
		...(outcomeName !== undefined
			? { outcome: { name: outcomeName, collector: { collect: () => ({ kind: "ok", artifacts: [] }) } } }
			: {}),
	}) as StageDef;

/** Minimal side-effect stage def — `applyCompletedStage` only reads `kind`. */
const actsDef = (overrides: Partial<StageDef> = {}): StageDef =>
	({ kind: "side-effect", sessionPolicy: "fresh", ...overrides }) as StageDef;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("applyCompletedStage", () => {
	it("produces stage with artifacts: advances primary and appends to named", () => {
		const state = freshState();
		const def = producesDef();
		const art = fakeArtifact("plans/p1.md");
		const output = fakeOutput([art]);

		applyCompletedStage(state, def, "blueprint", output);

		expect(state.primaryArtifact).toBe(art);
		expect(state.named.blueprint).toEqual([output]);
	});

	it("produces stage with empty artifacts: primary unchanged, named still appends the Output", () => {
		const state = freshState();
		const existing = fakeArtifact("old.md");
		state.primaryArtifact = existing;

		const def = producesDef();
		const output = fakeOutput([]); // no artifacts

		applyCompletedStage(state, def, "blueprint", output);

		// Primary stays as-is — no artifact[0] to advance to
		expect(state.primaryArtifact).toBe(existing);
		// Named still records the Output
		expect(state.named.blueprint).toEqual([output]);
	});

	it("produces stage uses outcome.name as named key when set", () => {
		const state = freshState();
		const def = producesDef("plans");
		const art = fakeArtifact("plans/p1.md");
		const output = fakeOutput([art]);

		applyCompletedStage(state, def, "blueprint", output);

		expect(state.primaryArtifact).toBe(art);
		// Key is "plans" (outcome.name), not "blueprint" (stage record key)
		expect(state.named.plans).toEqual([output]);
		expect(state.named.blueprint).toBeUndefined();
	});

	it("side-effect stage (acts): primary and named left untouched", () => {
		const existing = fakeArtifact("old.md");
		const state = freshState();
		state.primaryArtifact = existing;
		state.named = { "prior-stage": [fakeOutput([existing])] };

		const def = actsDef();
		const output = fakeOutput();

		applyCompletedStage(state, def, "commit", output);

		expect(state.primaryArtifact).toBe(existing);
		expect(state.named).toEqual({ "prior-stage": [expect.any(Object)] });
	});

	it("terminal stage (inheritsArtifacts: false): clears primary, named untouched", () => {
		const existing = fakeArtifact("old.md");
		const state = freshState();
		state.primaryArtifact = existing;
		state.named = { "prior-stage": [fakeOutput([existing])] };

		// `terminal()` sets `inheritsArtifacts: false`
		const def = actsDef({ inheritsArtifacts: false });
		const output = fakeOutput();

		applyCompletedStage(state, def, "cleanup", output);

		expect(state.primaryArtifact).toBeUndefined();
		// Named is never cleared — it's an additive history channel
		expect(state.named).toEqual({ "prior-stage": [expect.any(Object)] });
	});

	it("named slot accumulates across repeated calls (append order preserved)", () => {
		const state = freshState();
		const def = producesDef("plans");

		const art1 = fakeArtifact("plans/p1.md");
		const output1 = fakeOutput([art1]);
		const art2 = fakeArtifact("plans/p2.md");
		const output2 = fakeOutput([art2]);

		applyCompletedStage(state, def, "blueprint", output1);
		applyCompletedStage(state, def, "blueprint", output2);

		// Primary tracks the latest (second call)
		expect(state.primaryArtifact).toBe(art2);
		// Named is an array preserving history order
		expect(state.named.plans).toEqual([output1, output2]);
	});

	it("does not mutate state.output or stagesCompleted (those stay at call sites)", () => {
		const state = freshState();
		state.output = fakeOutput();
		state.stagesCompleted = 5;

		const def = producesDef();
		const art = fakeArtifact("plans/p1.md");
		const output = fakeOutput([art]);

		applyCompletedStage(state, def, "blueprint", output);

		// output and stagesCompleted are NOT changed by the reducer
		expect(state.output).not.toBe(output);
		expect(state.stagesCompleted).toBe(5);
	});
});

describe("SchemaTimeoutError", () => {
	it("is distinguishable from plain Error via instanceof", () => {
		const err = new SchemaTimeoutError("test");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(SchemaTimeoutError);
		expect(err.message).toBe("test");

		const plain = new Error("test");
		expect(plain).not.toBeInstanceOf(SchemaTimeoutError);
	});

	it("withTimeout throws SchemaTimeoutError when message is a SchemaTimeoutError instance", async () => {
		const never = new Promise<never>(() => {});
		const err = await withTimeout(never, 1, new SchemaTimeoutError("boom")).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SchemaTimeoutError);
		expect((err as Error).message).toBe("boom");
	});

	it("withTimeout throws plain Error when message is a string (backward-compatible)", async () => {
		const never = new Promise<never>(() => {});
		const err = await withTimeout(never, 1, "timeout string").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(SchemaTimeoutError);
		expect((err as Error).message).toBe("timeout string");
	});

	it("withTimeout resolves when the promise settles before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 1000, "should not fire");
		expect(result).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// resolveSkill
// ---------------------------------------------------------------------------

describe("resolveSkill", () => {
	it("returns stage name when def has no skill", () => {
		const def = { kind: "produces", sessionPolicy: "fresh" } as StageDef;
		expect(resolveSkill(def, "blueprint")).toBe("blueprint");
	});

	it("returns skill when def has explicit skill", () => {
		const def = { kind: "produces", sessionPolicy: "fresh", skill: "custom-skill" } as StageDef;
		expect(resolveSkill(def, "blueprint")).toBe("custom-skill");
	});

	it("returns skill even when it equals the stage name", () => {
		const def = { kind: "side-effect", sessionPolicy: "fresh", skill: "blueprint" } as StageDef;
		expect(resolveSkill(def, "blueprint")).toBe("blueprint");
	});
});

// ---------------------------------------------------------------------------
// globalSlot
// ---------------------------------------------------------------------------

describe("globalSlot", () => {
	it("initialises lazily on first access", () => {
		const key = Symbol.for("test:globalSlot-lazy-init");
		delete (globalThis as Record<symbol, unknown>)[key];
		let initCount = 0;
		const getSlot = globalSlot(key, () => {
			initCount++;
			return new Map<string, number>();
		});
		expect(initCount).toBe(0);
		const map = getSlot();
		expect(initCount).toBe(1);
		expect(map).toBeInstanceOf(Map);
	});

	it("returns the same value on subsequent accesses", () => {
		const key = Symbol.for("test:globalSlot-same-value");
		delete (globalThis as Record<symbol, unknown>)[key];
		const getSlot = globalSlot(key, () => new Set<string>());
		const first = getSlot();
		const second = getSlot();
		expect(first).toBe(second);
	});

	it("different keys get independent slots", () => {
		const keyA = Symbol.for("test:globalSlot-indep-a");
		const keyB = Symbol.for("test:globalSlot-indep-b");
		delete (globalThis as Record<symbol, unknown>)[keyA];
		delete (globalThis as Record<symbol, unknown>)[keyB];
		const getA = globalSlot(keyA, () => [] as string[]);
		const getB = globalSlot(keyB, () => new Map());
		expect(getA()).not.toBe(getB());
		expect(Array.isArray(getA())).toBe(true);
		expect(getB()).toBeInstanceOf(Map);
	});

	it("reset clears slot so next access re-initialises", () => {
		const key = Symbol.for("test:globalSlot-reset");
		delete (globalThis as Record<symbol, unknown>)[key];
		let initCount = 0;
		const getSlot = globalSlot(key, () => {
			initCount++;
			return { count: initCount };
		});
		const first = getSlot();
		expect(initCount).toBe(1);
		// Simulate what __resetSkillContracts does
		delete (globalThis as Record<symbol, unknown>)[key];
		const afterReset = getSlot();
		expect(initCount).toBe(2);
		expect(afterReset).not.toBe(first);
	});
});

describe("lazyProviderRegistry", () => {
	/** Fresh registry per test — unique key so global slots don't leak across tests. */
	let seq = 0;
	const fresh = (opts?: { onError: (err: unknown) => void }) => {
		const registry = lazyProviderRegistry(`test:lazy-provider-${++seq}`, opts);
		registry.reset();
		return registry;
	};

	it("runs each provider exactly once across repeated flushes", async () => {
		const registry = fresh();
		let runs = 0;
		registry.register(() => {
			runs++;
		});
		await registry.flush();
		await registry.flush();
		await registry.flush();
		expect(runs).toBe(1);
	});

	it("providers registered AFTER a flush run on the NEXT flush (the /reload re-registration path)", async () => {
		const registry = fresh();
		const ran: string[] = [];
		registry.register(() => {
			ran.push("gen-1");
		});
		await registry.flush();
		expect(ran).toEqual(["gen-1"]);

		// Pi /reload re-runs the extension entry → the provider re-registers
		// while the global slots survive. The next flush MUST run it —
		// otherwise a skill installed mid-session can never refresh its
		// contract and owner-scoped pruning never fires.
		registry.register(() => {
			ran.push("gen-2");
		});
		await registry.flush();
		expect(ran).toEqual(["gen-1", "gen-2"]);
	});

	it("a later generation runs strictly AFTER the prior flush settles (ordering chained)", async () => {
		const registry = fresh();
		const ran: string[] = [];
		let releaseFirst!: () => void;
		const gate = new Promise<void>((r) => {
			releaseFirst = r;
		});
		registry.register(async () => {
			await gate;
			ran.push("slow-first");
		});
		const first = registry.flush();
		registry.register(() => {
			ran.push("second");
		});
		const second = registry.flush();
		releaseFirst();
		await first;
		await second;
		expect(ran).toEqual(["slow-first", "second"]);
	});

	it("onError isolates a throwing provider; later registrations still flush", async () => {
		const errors: unknown[] = [];
		const registry = fresh({ onError: (e) => errors.push(e) });
		registry.register(() => {
			throw new Error("boom");
		});
		await registry.flush();
		expect(errors).toHaveLength(1);

		let ran = false;
		registry.register(() => {
			ran = true;
		});
		await registry.flush();
		expect(ran).toBe(true);
	});

	it("a provider throw without onError rejects that flush only — later registrations recover", async () => {
		const registry = fresh();
		registry.register(() => {
			throw new Error("boom");
		});
		await expect(registry.flush()).rejects.toThrow("boom");

		// The /reload re-registration path must survive a bad provider: the
		// chain is not poisoned and the new provider runs.
		let ran = false;
		registry.register(() => {
			ran = true;
		});
		await registry.flush();
		expect(ran).toBe(true);
	});

	it("flush with nothing pending and nothing flushed resolves immediately", async () => {
		const registry = fresh();
		await expect(registry.flush()).resolves.toBeUndefined();
	});
});
