/**
 * Direct tests for `classifyAndHandleAbort` — postStage's single abort
 * dispatch (risk 4r2's deferred group). The disposition arms, each pinned
 * against the level that owns it:
 *
 *   Level 1  — fired cooperative signal   → throws WorkflowAbortError
 *   Level 2  — clean stop                 → no-abort hand-back (verdict never consulted)
 *   Level 3a — watchdog + strike remains  → steering resend + postStage tail-recursion
 *              (for ANY non-clean stop — "aborted" AND the mid-tool "error" shape)
 *   Level 3b — watchdog + strikes spent   → haltStageOrSoftHalt({ kind: "timeout" })
 *   Level 4  — aborted stop, no watchdog  → throws WorkflowAbortError
 *
 * The verdict-before-stop-shape ordering is load-bearing: a watchdog abort landing
 * mid-tool surfaces as stopReason "error", not "aborted" (run
 * 2026-08-20_14-54-40-4cc2, implement phase-1), and must still reach the strike arm.
 *
 * Wiring: `createMockSessionChain` scripts the child (branch, watchdog verdict,
 * per-send evolution); a capture spawn hands the fully-wired child ctx to the
 * direct call, so the 4a tail-recursion runs the REAL postStage pipeline
 * (outcome read → extraction → success persistence) instead of a stub.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageDef } from "../api.js";
import { LifecycleDispatcher } from "../events.js";
import { WorkflowAbortError } from "../internal-utils.js";
import type { Output } from "../output.js";
import { DEFAULT_TRIGGER } from "../triggers.js";
import type { RunState, StageSessionContext, WorkflowHostContext, WorkflowSessionContext } from "../types.js";
import { bashStrikesRemaining } from "./bash-strikes.js";
import { classifyAndHandleAbort } from "./sessions.js";

// ---------------------------------------------------------------------------
// Fixtures — the minimal slice of sessions.test.ts's wiring the classifier needs
// ---------------------------------------------------------------------------

/** Bare RunState — every field nullish/zero so tests pin the deltas the halt/success paths produce. */
const freshRunState = (): RunState => ({
	originalInput: "x",
	primaryArtifact: undefined,
	output: undefined,
	named: {},
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: {
		backwardJumps: 0,
		droppedRoutingRows: [],
		droppedFailureRows: [],
	},
	failureMemos: [],
	termination: { status: "running" },
});

/** Minimal skill stage — fresh policy, side-effect (no artifact extraction). */
const testStage: StageDef = {
	skill: "test",
	kind: "side-effect",
	sessionPolicy: "fresh",
} as StageDef;

/** Build a StageSessionContext with sensible defaults; caller supplies cwd + state + overrides. */
const stageSession = (
	overrides: Partial<StageSessionContext> & Pick<StageSessionContext, "cwd" | "state">,
): StageSessionContext => ({
	runId: "run-test",
	prompt: "/skill:test arg",
	stageName: "test",
	skill: "test",
	lifecycle: new LifecycleDispatcher(undefined),
	runIdentity: { workflow: "test-wf", totalStages: 1, trigger: DEFAULT_TRIGGER },
	stage: testStage,
	stageIndex: 0,
	snapshot: undefined,
	onSuccess: async () => {},
	...overrides,
});

/** An already-fired cooperative-cancellation signal (Level 1's trigger). */
const firedSignal = (): AbortSignal => {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
};

/**
 * Dequeue ONE scripted step and hand back its fully-wired child ctx (branch,
 * watchdog verdict holder, resetToolTimeout, onSend evolution) — the direct
 * call's stand-in for the child `spawnChildAndRun` would deliver.
 */
const captureChild = (chain: { ctx: unknown }): Promise<WorkflowSessionContext> =>
	(chain.ctx as WorkflowHostContext).spawnChild({
		prompt: "capture",
		withSession: async (child) => child,
	});

const TIMEOUT_REASON = "bash command exceeded the 180s per-command timeout and was aborted: `find /`";

describe("sessions — abort classifier (direct)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-abort-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("Level 1: a fired signal throws WorkflowAbortError — even over a recoverable watchdog verdict", async () => {
		// The signal check dominates the whole dispatch: an aborted stop AND a live
		// watchdog verdict are both present, yet the genuine abort wins (resume must
		// re-dispatch the unit; a strike retry here would swallow the cancellation).
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("partial", "aborted")], toolTimeout: { reason: TIMEOUT_REASON } }],
		});
		const child = await captureChild(chain);
		const onFailure = vi.fn();
		const s = stageSession({ cwd: tmpDir, state: freshRunState(), signal: firedSignal(), onFailure });

		await expect(
			classifyAndHandleAbort(
				chain.ctx as WorkflowHostContext,
				child,
				s,
				{ branch: [], stop: "aborted" },
				null,
				undefined,
			),
		).rejects.toBeInstanceOf(WorkflowAbortError);

		// Threw BEFORE the watchdog arm: verdict unread/unreset, no strike consumed,
		// no steering resend, no halt row written.
		expect(child.toolTimeout?.()).toEqual({ reason: TIMEOUT_REASON });
		expect(bashStrikesRemaining(s)).toBe(2);
		expect(chain.sentMessages.some((m) => m.includes("HUNG, not merely slow"))).toBe(false);
		expect(onFailure).not.toHaveBeenCalled();
		expect(existsSync(join(tmpDir, ".rpiv", "workflows", "runs"))).toBe(false);
	});

	it("Level 2: a clean stop returns undefined — the caller proceeds to its happy-path switch", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			// A watchdog verdict is present but must never be consulted — a clean stop
			// exits at Level 2, BEFORE the watchdog read.
			steps: [{ branch: [mockAssistantMessage("done")], toolTimeout: { reason: TIMEOUT_REASON } }],
		});
		const child = await captureChild(chain);
		const onFailure = vi.fn();
		const s = stageSession({ cwd: tmpDir, state: freshRunState(), onFailure });

		await expect(
			classifyAndHandleAbort(
				chain.ctx as WorkflowHostContext,
				child,
				s,
				{ branch: [], stop: "stop" },
				null,
				undefined,
			),
		).resolves.toBeUndefined();

		expect(bashStrikesRemaining(s)).toBe(2);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("Level 4: an aborted stop with a cold signal and NO watchdog throws WorkflowAbortError before any row write", async () => {
		// ESC / session.abort(): the SDK RESOLVES prompt() with stopReason:"aborted"
		// and no toolTimeout verdict. A genuine abort must throw before any
		// collected:true row lands, so resume re-dispatches the unit cleanly.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("partial", "aborted")] }],
		});
		const child = await captureChild(chain);
		const onFailure = vi.fn();
		const s = stageSession({ cwd: tmpDir, state: freshRunState(), onFailure });

		await expect(
			classifyAndHandleAbort(
				chain.ctx as WorkflowHostContext,
				child,
				s,
				{ branch: [], stop: "aborted" },
				null,
				undefined,
			),
		).rejects.toBeInstanceOf(WorkflowAbortError);

		expect(onFailure).not.toHaveBeenCalled();
		expect(existsSync(join(tmpDir, ".rpiv", "workflows", "runs"))).toBe(false);
	});

	it("Level 3a: a strike-backed watchdog timeout resets the verdict, resends steering, and tail-recurses postStage", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					// Initial turn: the bash call overran and the watchdog aborted it.
					branch: [mockAssistantMessage("scanning", "aborted")],
					toolTimeout: { reason: TIMEOUT_REASON },
					// Resumed turn after the steering resend: a normal completion.
					onSend: [{ branch: [mockAssistantMessage("diagnosed; all green")], toolTimeout: undefined }],
				},
			],
		});
		const child = await captureChild(chain);
		const state = freshRunState();
		const onFailure = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});
		const s = stageSession({ cwd: tmpDir, state, onSuccess, onFailure, bashTimeoutStrikes: 1 });

		await expect(
			classifyAndHandleAbort(
				chain.ctx as WorkflowHostContext,
				child,
				s,
				{ branch: [], stop: "aborted" },
				null,
				undefined,
			),
		).resolves.toBe("continue");

		// The strike was consumed and the steering rode into the SAME child.
		expect(bashStrikesRemaining(s)).toBe(0);
		const steering = chain.sentMessages.find((m) => m.includes("HUNG, not merely slow"));
		expect(steering).toContain(TIMEOUT_REASON);
		// The watchdog verdict was reset before the resend (and the resumed turn set none).
		expect(child.toolTimeout?.()).toBeUndefined();
		// The tail-recursed postStage ran the resumed turn to a recorded success.
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("Level 3a: a watchdog abort surfaced as an infra-death 'error' stop still reaches the strike arm", async () => {
		// The mid-tool abort shape (run 2026-08-20_14-54-40-4cc2, implement phase-1):
		// the killed bash returns an error toolResult and the loop records the
		// strangled follow-up request as stopReason:"error" — NOT "aborted". The
		// watchdog verdict must own the turn anyway; gating on the stop shape sent
		// this to the stop arm, where "error" reads as infra death and hard-fails.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("", "error")],
					toolTimeout: { reason: TIMEOUT_REASON },
					onSend: [{ branch: [mockAssistantMessage("diagnosed; all green")], toolTimeout: undefined }],
				},
			],
		});
		const child = await captureChild(chain);
		const state = freshRunState();
		const onFailure = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});
		const s = stageSession({ cwd: tmpDir, state, onSuccess, onFailure, bashTimeoutStrikes: 1 });

		await expect(
			classifyAndHandleAbort(
				chain.ctx as WorkflowHostContext,
				child,
				s,
				{ branch: [], stop: "error" },
				null,
				undefined,
			),
		).resolves.toBe("continue");

		// Recovered exactly like the "aborted" shape: strike consumed, steering
		// resent into the same child, resumed turn recorded as a success.
		expect(bashStrikesRemaining(s)).toBe(0);
		expect(chain.sentMessages.some((m) => m.includes("HUNG, not merely slow"))).toBe(true);
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("Level 3b: watchdog timeout with strikes exhausted routes to haltStageOrSoftHalt — terminal fail carrying the reason", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("scanning", "aborted")], toolTimeout: { reason: TIMEOUT_REASON } }],
		});
		const child = await captureChild(chain);
		const state = freshRunState();
		const onFailure = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});
		// Pre-exhausted ceiling: consumeBashStrike refuses, so the classifier takes
		// the escalation seam instead of the retry arm.
		const s = stageSession({ cwd: tmpDir, state, onSuccess, onFailure, bashTimeoutStrikes: 0 });

		await expect(
			classifyAndHandleAbort(
				chain.ctx as WorkflowHostContext,
				child,
				s,
				{ branch: [], stop: "aborted" },
				null,
				undefined,
			),
		).resolves.toBe("continue");

		// Terminal halt (non-collect-all): the failure fired with the watchdog
		// reason and no steering resend / recursed success happened.
		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toContain("per-command timeout");
		expect(chain.sentMessages.some((m) => m.includes("HUNG, not merely slow"))).toBe(false);
		expect(onSuccess).not.toHaveBeenCalled();
	});
});
