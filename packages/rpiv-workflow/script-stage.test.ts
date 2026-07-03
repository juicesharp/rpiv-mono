/**
 * Tests for the `runScript` runtime branch.
 *
 * Script stages skip the skill pipeline entirely (no `/skill:<name>`
 * prompt, no `newSession`, no collector). These tests drive
 * `runWorkflow` end-to-end with `produces.script` / `acts.script` /
 * `terminal.script` stages and inspect the JSONL audit row + the
 * lifecycle event stream.
 *
 * Most tests run with `createMockSessionChain({ steps: [] })`: the
 * empty-steps queue never trips because script stages never open a
 * session. Mixed (script + skill) chains would consume the queue;
 * they live in runner.test.ts.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, defineWorkflow, produces, type ScriptContext, terminal } from "./api.js";
import type { LifecycleListeners } from "./events.js";
import { fs as fsHandle } from "./handle.js";
import { runWorkflow } from "./runner/index.js";
import { typeboxSchema } from "./typebox-adapter.js";

interface JsonlRow {
	stageNumber?: number;
	stage?: string;
	skill?: string;
	status?: string;
	output?: { kind?: string; artifacts?: unknown[]; data?: unknown; meta?: Record<string, unknown> };
	ts?: string;
}

const readState = (cwd: string): { header: Record<string, unknown>; stages: JsonlRow[] } => {
	const dir = join(cwd, ".rpiv", "workflows", "runs");
	const files = readdirSync(dir);
	expect(files).toHaveLength(1);
	const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
	return {
		header: JSON.parse(lines[0]!) as Record<string, unknown>,
		stages: lines.slice(1).map((l) => JSON.parse(l) as JsonlRow),
	};
};

/** Recorder for lifecycle event order — appends `<event>:<ref-name>` for each fire. */
function recordingListeners() {
	const events: string[] = [];
	const listeners: LifecycleListeners = {
		onWorkflowStart: () => void events.push("onWorkflowStart"),
		onStageStart: (s) => void events.push(`onStageStart:${s.name}:${s.kind}`),
		onStageRetry: (s, attempt) => void events.push(`onStageRetry:${s.name}:${attempt}`),
		onStageEnd: (s) => void events.push(`onStageEnd:${s.name}:${s.kind}`),
		onStageError: (s, err) => void events.push(`onStageError:${s.name}:${s.kind}:${err}`),
		onRoute: (from, to) => void events.push(`onRoute:${from.name}->${to}`),
		onWorkflowEnd: (r) => void events.push(`onWorkflowEnd:${r.success}`),
	};
	return { events, listeners };
}

describe("runScript", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-script-stage-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// 1. acts.script: function runs, chain advances, JSONL row stores the
	//    record key as `stage` with the `skill` field absent.
	it("acts.script — runs the function, records a row with stage=<key> and no skill field", async () => {
		let called = 0;
		const workflow = defineWorkflow({
			name: "acts-only",
			start: "tick",
			stages: { tick: acts.script({ run: () => void called++ }) },
			edges: { tick: "stop" },
		});

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(1);
		expect(called).toBe(1);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]!.stage).toBe("tick");
		expect(stages[0]!.skill).toBeUndefined();
		expect(stages[0]!.status).toBe("completed");
		expect(stages[0]!.output?.kind).toBe("side-effect");
	});

	// 2. produces.script: returns an envelope; downstream stage sees it via
	//    ctx.input / state.output.
	it("produces.script — return value flows to the next stage's ScriptContext.input", async () => {
		let observedInputKind: string | undefined;
		let observedData: unknown;

		const workflow = defineWorkflow({
			name: "pipe",
			start: "produce",
			stages: {
				produce: produces.script({
					run: () => ({ kind: "count", artifacts: [], data: { n: 7 } }),
				}),
				consume: acts.script({
					run: (ctx: ScriptContext) => {
						observedInputKind = ctx.input?.kind;
						observedData = ctx.input?.data;
					},
				}),
			},
			edges: { produce: "consume", consume: "stop" },
		});

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(2);
		expect(observedInputKind).toBe("count");
		expect(observedData).toEqual({ n: 7 });
	});

	// 3. produces.script with outputSchema rejecting once: onStageRetry
	//    fires, function called again, success on attempt 2.
	it("produces.script — outputSchema rejects once, retries, succeeds on attempt 2", async () => {
		let attempt = 0;
		const workflow = defineWorkflow({
			name: "retry-once",
			start: "compute",
			stages: {
				compute: produces.script({
					outputSchema: typeboxSchema(Type.Object({ n: Type.Integer({ minimum: 1 }) })),
					maxRetries: 2,
					run: () => {
						attempt++;
						return { kind: "count", artifacts: [], data: { n: attempt === 1 ? 0 : 3 } };
					},
				}),
			},
			edges: { compute: "stop" },
		});

		const { events, listeners } = recordingListeners();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x", lifecycle: listeners });

		expect(result.success).toBe(true);
		expect(attempt).toBe(2);
		expect(events).toContain("onStageRetry:compute:1");
		expect(events).toContain("onStageEnd:compute:script");
	});

	// 4. produces.script with outputSchema rejecting maxRetries + 1 times:
	//    terminal failure, onStageError fires.
	it("produces.script — outputSchema exhausts retries → terminal failure + onStageError", async () => {
		const workflow = defineWorkflow({
			name: "retry-exhaust",
			start: "compute",
			stages: {
				compute: produces.script({
					outputSchema: typeboxSchema(Type.Object({ n: Type.Integer({ minimum: 1 }) })),
					maxRetries: 1,
					run: () => ({ kind: "count", artifacts: [], data: { n: 0 } }),
				}),
			},
			edges: { compute: "stop" },
		});

		const { events, listeners } = recordingListeners();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x", lifecycle: listeners });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/output validation failed/i);
		expect(events).toContain("onStageRetry:compute:1");
		expect(events.some((e) => e.startsWith("onStageError:compute:script:"))).toBe(true);
		expect(events).not.toContain("onStageEnd:compute:script");
	});

	// 5. Script throw → terminal failure with MSG_SCRIPT_THREW + onStageError.
	it("acts.script — function throws → terminal failure + onStageError fires", async () => {
		const workflow = defineWorkflow({
			name: "boom",
			start: "die",
			stages: {
				die: acts.script({
					run: () => {
						throw new Error("kaboom");
					},
				}),
			},
			edges: { die: "stop" },
		});

		const { events, listeners } = recordingListeners();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x", lifecycle: listeners });

		expect(result.success).toBe(false);
		expect(result.error).toBe("die script threw: kaboom");
		expect(events.some((e) => e === "onStageError:die:script:die script threw: kaboom")).toBe(true);
		// User-facing notify message should surface MSG_SCRIPT_THREW shape.
		expect(chain.notifications.some((n) => /die script threw — stopping workflow: kaboom/.test(n.msg))).toBe(true);
	});

	// 6. terminal.script clears the rolling primary slot — downstream stage
	//    sees no inherited artifact.
	it("terminal.script — clears inherited artifact; downstream stage sees ctx.input.artifacts empty", async () => {
		const handle = fsHandle("/tmp/upstream.md");
		let observedArtifactsLen: number | undefined;

		const workflow = defineWorkflow({
			name: "terminal-clears",
			start: "upstream",
			stages: {
				upstream: produces.script({
					run: () => ({ kind: "artifact", artifacts: [{ handle, role: "primary" }], data: {} }),
				}),
				cleanup: terminal.script({ run: () => {} }),
				downstream: acts.script({
					run: (ctx: ScriptContext) => {
						observedArtifactsLen = ctx.input?.artifacts?.length;
					},
				}),
			},
			edges: { upstream: "cleanup", cleanup: "downstream", downstream: "stop" },
		});

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(3);
		// `ctx.input` for the downstream stage IS the cleanup row's output (kind: "side-effect", artifacts: []).
		expect(observedArtifactsLen).toBe(0);
		// The cleared rolling primary is observable only via the inherited
		// envelope — `RunView` no longer leaks the `primaryArtifact` slot.
	});

	// 7. Async script function awaited correctly.
	it("acts.script — async run() function is awaited before chain advances", async () => {
		const calls: string[] = [];
		const workflow = defineWorkflow({
			name: "async",
			start: "first",
			stages: {
				first: acts.script({
					run: async () => {
						await new Promise((r) => setTimeout(r, 10));
						calls.push("first-done");
					},
				}),
				second: acts.script({
					run: () => {
						calls.push("second-start");
					},
				}),
			},
			edges: { first: "second", second: "stop" },
		});

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

		expect(result.success).toBe(true);
		// `first-done` MUST land before `second-start` — the runner awaits the
		// promise before advancing the chain.
		expect(calls).toEqual(["first-done", "second-start"]);
	});

	// 8. Lifecycle event order on a clean script stage: onWorkflowStart →
	//    onStageStart → onStageEnd → onRoute(stop) → onWorkflowEnd.
	it("lifecycle order on a clean script stage matches the skill-stage order", async () => {
		const workflow = defineWorkflow({
			name: "order",
			start: "go",
			stages: { go: acts.script({ run: () => {} }) },
			edges: { go: "stop" },
		});

		const { events, listeners } = recordingListeners();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		await runWorkflow(chain.ctx, { workflow, input: "x", lifecycle: listeners });

		expect(events).toEqual([
			"onWorkflowStart",
			"onStageStart:go:script",
			"onStageEnd:go:script",
			"onRoute:go->stop",
			"onWorkflowEnd:true",
		]);
	});
});
