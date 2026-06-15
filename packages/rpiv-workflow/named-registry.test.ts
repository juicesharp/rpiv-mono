/**
 * Named-publish registry tests — `state.named`, `Outcome.name`,
 * `reads:`, the labelled-flag prompt format, accumulation across loops,
 * and the validator's catch for unresolved reads.
 *
 * Scope is the framework runtime; rpiv-pi conventions stay out of this
 * file (bucket outcomes are exercised in built-in-workflows.test.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, defineWorkflow, fanin, gate, produces, type StageDef, type Workflow } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import type { Outcome } from "./output-spec.js";
import { eq, gt } from "./predicates.js";
import { runWorkflow } from "./runner/index.js";
import { typeboxSchema } from "./typebox-adapter.js";
import { validateWorkflow } from "./validate-workflow.js";

// ---------------------------------------------------------------------------
// Local fixtures
// ---------------------------------------------------------------------------

const PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Outcome that scans the assistant transcript for `.rpiv/artifacts/<bucket>/<file>.md` paths. */
const makeOutcome = (name?: string): Outcome<unknown, "artifact-md", Record<string, unknown>> => ({
	...(name !== undefined ? { name } : {}),
	collector: {
		collect: (ctx) => {
			const matches: string[] = [];
			const start = Math.max(ctx.branchOffset ?? 0, 0);
			for (let i = start; i < ctx.branch.length; i++) {
				const entry = ctx.branch[i]!;
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						const m = part.text.match(PATTERN);
						if (m) matches.push(...m);
					}
				}
			}
			if (matches.length === 0) {
				return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			}
			return {
				kind: "ok",
				artifacts: matches.map((path) => ({ handle: fsHandle(path), role: "primary" as const })),
			};
		},
	},
	parser: {
		parse: (_ctx) => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }),
	},
});

const writeArtifact = (cwd: string, relPath: string, content = "") => {
	const parts = relPath.split("/");
	mkdirSync(join(cwd, ...parts.slice(0, -1)), { recursive: true });
	writeFileSync(join(cwd, relPath), content);
};

// ---------------------------------------------------------------------------
// Publish-key resolution + accumulation
// ---------------------------------------------------------------------------

describe("state.named — publish key resolution + accumulation", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-named-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("publishes under outcome.name when the outcome carries one", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p1.md");

		const workflow = defineWorkflow({
			name: "wf",
			start: "blueprint",
			stages: {
				blueprint: produces({ outcome: makeOutcome("plans") }),
			},
			edges: { blueprint: "stop" },
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] }],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		// JSONL row carries the artifact under the produces stage; reading
		// the named slot via the runner's behavior is what we care about.
		// We assert prompt-side resolution in the reads tests below.
		expect(result.lastArtifact).toBe(".rpiv/artifacts/plans/p1.md");
	});

	it("falls back to stage record key when outcome has no name", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/anything/a.md");
		writeArtifact(tmpDir, ".rpiv/artifacts/anything/b.md");

		const workflow = defineWorkflow({
			name: "wf",
			start: "produce-it",
			stages: {
				"produce-it": produces({ outcome: makeOutcome() /* no name */ }),
				"consume-it": acts({ reads: ["produce-it"] }),
			},
			edges: { "produce-it": "consume-it", "consume-it": "stop" },
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/anything/a.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		// The downstream "consume-it" stage built its prompt from
		// state.named["produce-it"] — by stage record key, since the outcome
		// had no name.
		expect(chain.sentMessages).toContain("/skill:consume-it --produce-it .rpiv/artifacts/anything/a.md");
	});

	it("accumulates outputs across loop iterations — each produces run appends", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p1.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p2.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p3.md", "---\nblockers_count: 0\n---\n");

		// Use a frontmatter-reading outcome so the gate routes deterministically.
		const fmOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
			name: "plans",
			collector: makeOutcome("plans").collector,
			parser: {
				parse: (ctx) => {
					const primary = ctx.artifacts[0];
					if (primary?.handle.kind !== "fs") {
						return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
					}
					const abs = primary.handle.path.startsWith("/")
						? primary.handle.path
						: join(ctx.cwd, primary.handle.path);
					if (!existsSync(abs)) {
						return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
					}
					const text = readFileSync(abs, "utf-8");
					const m = text.match(/blockers_count:\s*(\d+)/);
					return {
						kind: "ok",
						payload: { kind: "artifact-md", data: { blockers_count: Number(m?.[1] ?? 0) } },
					};
				},
			},
		};

		// produce → gate that loops back to produce; produce emits a different
		// file each time (mock steps are sequential). Output is published
		// under "plans" each iteration → array of 3 by the end.
		const workflow = defineWorkflow({
			name: "wf",
			start: "produce",
			stages: {
				produce: produces({
					outcome: fmOutcome,
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
				done: acts(),
			},
			edges: {
				produce: gate("blockers_count", { produce: gt(0), done: eq(0) }, "done"),
				done: "stop",
			},
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] },
				{ branch: [mockAssistantMessage("done")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		// produce ran 3 times — only the LAST path is exposed as lastArtifact,
		// but state.named["plans"] internally is an array of length 3.
		expect(result.lastArtifact).toBe(".rpiv/artifacts/plans/p3.md");
		expect(result.stagesCompleted).toBe(4); // 3× produce + 1× done
	});
});

// ---------------------------------------------------------------------------
// reads: prompt format
// ---------------------------------------------------------------------------

describe("reads: prompt format", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-reads-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("builds a labelled-flag prompt from upstream named slots", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p.md");
		writeArtifact(tmpDir, ".rpiv/artifacts/reviews/r.md");

		const workflow = defineWorkflow({
			name: "wf",
			start: "blueprint",
			stages: {
				blueprint: produces({ outcome: makeOutcome("plans") }),
				review: produces({ outcome: makeOutcome("reviews") }),
				revise: acts({ reads: ["plans", "reviews"] }),
			},
			edges: { blueprint: "review", review: "revise", revise: "stop" },
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/r.md")] },
				{ branch: [mockAssistantMessage("revised")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:blueprint x",
			"/skill:review .rpiv/artifacts/plans/p.md",
			"/skill:revise --plans .rpiv/artifacts/plans/p.md --reviews .rpiv/artifacts/reviews/r.md",
		]);
	});

	it("repeats the flag for each artifact when a stage's output carries multiple", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/a.md");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/b.md");

		const workflow = defineWorkflow({
			name: "wf",
			start: "produce",
			stages: {
				produce: produces({ outcome: makeOutcome("plans") }),
				consume: acts({ reads: ["plans"] }),
			},
			edges: { produce: "consume", consume: "stop" },
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/a.md and .rpiv/artifacts/plans/b.md")],
				},
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages[1]).toBe(
			"/skill:consume --plans .rpiv/artifacts/plans/a.md --plans .rpiv/artifacts/plans/b.md",
		);
	});

	it("reads the LATEST entry when the slot accumulated multiple iterations", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p1.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p2.md", "---\nblockers_count: 0\n---\n");

		const fmOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
			name: "plans",
			collector: makeOutcome("plans").collector,
			parser: {
				parse: (ctx) => {
					const primary = ctx.artifacts[0];
					if (primary?.handle.kind !== "fs") {
						return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
					}
					const abs = primary.handle.path.startsWith("/")
						? primary.handle.path
						: join(ctx.cwd, primary.handle.path);
					if (!existsSync(abs)) {
						return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
					}
					const text = readFileSync(abs, "utf-8");
					const m = text.match(/blockers_count:\s*(\d+)/);
					return {
						kind: "ok",
						payload: { kind: "artifact-md", data: { blockers_count: Number(m?.[1] ?? 0) } },
					};
				},
			},
		};

		// produce → loops back to produce while blockers>0; once blockers==0,
		// flows to consume which reads "plans" (should be the LATEST entry).
		const workflow = defineWorkflow({
			name: "wf",
			start: "produce",
			stages: {
				produce: produces({
					outcome: fmOutcome,
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
				consume: acts({ reads: ["plans"] }),
			},
			edges: {
				produce: gate("blockers_count", { produce: gt(0), consume: eq(0) }, "consume"),
				consume: "stop",
			},
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages.at(-1)).toBe("/skill:consume --plans .rpiv/artifacts/plans/p2.md");
	});
});

// ---------------------------------------------------------------------------
// reads: fanin() all-entries projection (fanout-and-synthesize)
// ---------------------------------------------------------------------------

describe("reads: fanin() all-entries projection", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-fanin-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** A frontmatter-reading "plans" outcome so the loop-back gate routes deterministically. */
	const fmPlansOutcome = (): Outcome<unknown, "artifact-md", Record<string, unknown>> => ({
		name: "plans",
		collector: makeOutcome("plans").collector,
		parser: {
			parse: (ctx) => {
				const primary = ctx.artifacts[0];
				if (primary?.handle.kind !== "fs") {
					return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
				}
				const abs = primary.handle.path.startsWith("/") ? primary.handle.path : join(ctx.cwd, primary.handle.path);
				if (!existsSync(abs)) {
					return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
				}
				const text = readFileSync(abs, "utf-8");
				const m = text.match(/blockers_count:\s*(\d+)/);
				return { kind: "ok", payload: { kind: "artifact-md", data: { blockers_count: Number(m?.[1] ?? 0) } } };
			},
		},
	});

	it("reads EVERY accumulated entry when the read is wrapped in fanin()", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p1.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p2.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p3.md", "---\nblockers_count: 0\n---\n");

		const workflow = defineWorkflow({
			name: "wf",
			start: "produce",
			stages: {
				produce: produces({
					outcome: fmPlansOutcome(),
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
				synthesize: acts({ reads: [fanin("plans")] }),
			},
			edges: {
				produce: gate("blockers_count", { produce: gt(0), synthesize: eq(0) }, "synthesize"),
				synthesize: "stop",
			},
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] },
				{ branch: [mockAssistantMessage("synthesized")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		// The synthesize barrier sees all three plan handles, in run order.
		expect(chain.sentMessages.at(-1)).toBe(
			"/skill:synthesize --plans .rpiv/artifacts/plans/p1.md --plans .rpiv/artifacts/plans/p2.md --plans .rpiv/artifacts/plans/p3.md",
		);
	});

	it("mixes fanin (all) and bare (latest) reads in declared order", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p1.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p2.md", "---\nblockers_count: 0\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/reviews/r.md");

		const workflow = defineWorkflow({
			name: "wf",
			start: "produce",
			stages: {
				produce: produces({
					outcome: fmPlansOutcome(),
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
				review: produces({ outcome: makeOutcome("reviews") }),
				synthesize: acts({ reads: [fanin("plans"), "reviews"] }),
			},
			edges: {
				produce: gate("blockers_count", { produce: gt(0), review: eq(0) }, "review"),
				review: "synthesize",
				synthesize: "stop",
			},
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/r.md")] },
				{ branch: [mockAssistantMessage("synthesized")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		// All of plans (run order), then the latest of reviews — declared order.
		expect(chain.sentMessages.at(-1)).toBe(
			"/skill:synthesize --plans .rpiv/artifacts/plans/p1.md --plans .rpiv/artifacts/plans/p2.md --reviews .rpiv/artifacts/reviews/r.md",
		);
	});

	it("treats an explicit { all: false } read as latest-wins", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p1.md", "---\nblockers_count: 1\n---\n");
		writeArtifact(tmpDir, ".rpiv/artifacts/plans/p2.md", "---\nblockers_count: 0\n---\n");

		const workflow = defineWorkflow({
			name: "wf",
			start: "produce",
			stages: {
				produce: produces({
					outcome: fmPlansOutcome(),
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
				consume: acts({ reads: [{ name: "plans", all: false }] }),
			},
			edges: {
				produce: gate("blockers_count", { produce: gt(0), consume: eq(0) }, "consume"),
				consume: "stop",
			},
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages.at(-1)).toBe("/skill:consume --plans .rpiv/artifacts/plans/p2.md");
	});
});

// ---------------------------------------------------------------------------
// reads: validation + preflight
// ---------------------------------------------------------------------------

describe("reads: validation + preflight", () => {
	it("rejects a workflow whose reads references a non-published name", () => {
		const workflow = defineWorkflow({
			name: "wf",
			start: "consume",
			stages: {
				consume: acts({ reads: ["does-not-exist"] }),
			},
			edges: { consume: "stop" },
		});

		const issues = validateWorkflow(workflow);
		const err = issues.find((i) => /does-not-exist/.test(i.message));
		expect(err?.severity).toBe("error");
		expect(err?.message).toMatch(/no produces stage in this workflow publishes it/);
	});

	it("accepts reads that resolves through outcome.name", () => {
		const workflow = defineWorkflow({
			name: "wf",
			start: "p",
			stages: {
				p: produces({ outcome: makeOutcome("plans") }),
				c: acts({ reads: ["plans"] }),
			},
			edges: { p: "c", c: "stop" },
		});
		expect(validateWorkflow(workflow).filter((i) => i.severity === "error")).toEqual([]);
	});

	it("accepts reads that resolves through stage record key (no outcome.name)", () => {
		const workflow = defineWorkflow({
			name: "wf",
			start: "p",
			stages: {
				p: produces({ outcome: makeOutcome() }),
				c: acts({ reads: ["p"] }),
			},
			edges: { p: "c", c: "stop" },
		});
		expect(validateWorkflow(workflow).filter((i) => i.severity === "error")).toEqual([]);
	});

	it("accepts a fanin() read of a published channel", () => {
		const workflow = defineWorkflow({
			name: "wf",
			start: "p",
			stages: {
				p: produces({ outcome: makeOutcome("plans") }),
				c: acts({ reads: [fanin("plans")] }),
			},
			edges: { p: "c", c: "stop" },
		});
		expect(validateWorkflow(workflow).filter((i) => i.severity === "error")).toEqual([]);
	});

	it("rejects a fanin() read of a non-published name (normalized channel in the message)", () => {
		const workflow = defineWorkflow({
			name: "wf",
			start: "consume",
			stages: {
				consume: acts({ reads: [fanin("does-not-exist")] }),
			},
			edges: { consume: "stop" },
		});
		const issues = validateWorkflow(workflow);
		const err = issues.find((i) => /does-not-exist/.test(i.message));
		expect(err?.severity).toBe("error");
		// Proves the object read is normalized — never "[object Object]".
		expect(issues.some((i) => /\[object Object\]/.test(i.message))).toBe(false);
	});
});

describe("reads: runtime preflight halts when slot is empty", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-named-halt-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("halts the chain when a stage reads a name that no upstream has filled yet", async () => {
		// `consume` reads `produce`, but in this workflow the START is `consume` —
		// so when consume runs, produce hasn't published anything. Validator
		// passes (produce IS a producing stage in the workflow), but runtime
		// must halt.
		const workflow: Workflow = {
			name: "wf",
			start: "consume",
			stages: {
				consume: acts({ reads: ["produce"] }) as StageDef,
				produce: produces({ outcome: makeOutcome() }),
			},
			edges: { consume: "stop", produce: "stop" },
		};

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("should never run")] }],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/reads "produce"/);
		expect(result.error).toMatch(/state.named\["produce"\] is empty/);
	});

	it("halts naming the normalized channel for a fanin() read with an empty slot", async () => {
		// Same shape as above but the read is wrapped in fanin() — proves the
		// preflight normalizes the object read (no "[object Object]" key regression).
		const workflow: Workflow = {
			name: "wf",
			start: "consume",
			stages: {
				consume: acts({ reads: [fanin("produce")] }) as StageDef,
				produce: produces({ outcome: makeOutcome() }),
			},
			edges: { consume: "stop", produce: "stop" },
		};

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("should never run")] }],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/reads "produce"/);
		expect(result.error).toMatch(/state.named\["produce"\] is empty/);
	});
});
