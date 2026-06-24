/**
 * detach-lane.test.ts — Phase 3 detach wiring on the RUN path.
 *
 * Two contracts the lane switcher rides on:
 *   1. `detachExecutor` forwards a lane `name` to `provider.createHost` — the
 *      run path passes `options.name ?? workflow.name`, so rpiv-pi records the
 *      lane under a human-readable label.
 *   2. `dispose` (which, in rpiv-pi, evicts the lane) runs in the runner's
 *      `finally` on EVERY terminal path — success, failure, AND abort — so a
 *      settled run can never strand its lane.
 *
 * Script-stage workflows are the vehicle: they never open a child session, so
 * the provider host needs nothing beyond `cwd` and the run completes without a
 * scripted session chain.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acts, defineWorkflow } from "../api.js";
import { __resetWorkflowExecutionHost, registerWorkflowExecutionHost } from "../execution-host.js";
import { runWorkflow } from "./runner.js";

/** Register a spy provider that echoes the observer as the executor host and
 *  records the createHost opts + a dispose spy. */
function spyProvider() {
	const dispose = vi.fn();
	let opts:
		| {
				runId: string;
				childSessionsDir: string;
				name?: string;
				workflow?: string;
				input?: string;
		  }
		| undefined;
	registerWorkflowExecutionHost({
		createHost: (observer, o) => {
			opts = o;
			return { host: observer, dispose };
		},
	});
	return { dispose, lastOpts: () => opts };
}

const noopStage = (run: () => void = () => {}) =>
	defineWorkflow({
		name: "ship-flow",
		start: "tick",
		stages: { tick: acts.script({ run }) },
		edges: { tick: "stop" },
	});

// A per-test tmpdir cwd so name claims (names.json) + JSONL rows never collide
// with sibling test files that share the default mock cwd.
let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-detach-lane-"));
	__resetWorkflowExecutionHost();
});
afterEach(() => {
	__resetWorkflowExecutionHost();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("detachExecutor — lane name threading (run path)", () => {
	it("forwards workflow.name to createHost when no --name is given", async () => {
		const provider = spyProvider();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await runWorkflow(chain.ctx, { workflow: noopStage(), input: "x" });

		expect(result.success).toBe(true);
		expect(provider.lastOpts()?.name).toBe("ship-flow");
		expect(typeof provider.lastOpts()?.runId).toBe("string");
		expect(typeof provider.lastOpts()?.childSessionsDir).toBe("string");
		expect(provider.lastOpts()?.workflow).toBe("ship-flow");
		expect(provider.lastOpts()?.input).toBe("x");
	});

	it("forwards options.name over workflow.name when --name is supplied", async () => {
		const provider = spyProvider();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await runWorkflow(chain.ctx, { workflow: noopStage(), input: "x", name: "my-alias" });

		expect(result.success).toBe(true);
		expect(provider.lastOpts()?.name).toBe("my-alias");
		expect(provider.lastOpts()?.workflow).toBe("ship-flow");
		expect(provider.lastOpts()?.input).toBe("x");
	});
});

describe("detachExecutor — dispose runs in finally on every terminal path", () => {
	it("disposes on a successful run", async () => {
		const provider = spyProvider();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await runWorkflow(chain.ctx, { workflow: noopStage(), input: "x" });

		expect(result.success).toBe(true);
		expect(provider.dispose).toHaveBeenCalledTimes(1);
	});

	it("disposes on a failing run (a throwing script stage)", async () => {
		const provider = spyProvider();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await runWorkflow(chain.ctx, {
			workflow: noopStage(() => {
				throw new Error("stage blew up");
			}),
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(provider.dispose).toHaveBeenCalledTimes(1);
	});

	it("disposes on an aborted run (signal aborted before the first stage)", async () => {
		const provider = spyProvider();
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const ac = new AbortController();
		ac.abort();

		const result = await runWorkflow(chain.ctx, { workflow: noopStage(), input: "x", signal: ac.signal });

		expect(result.success).toBe(false);
		expect(provider.dispose).toHaveBeenCalledTimes(1);
	});
});
