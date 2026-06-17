/**
 * Session opening — the child-spawn primitive every stage and loop unit runs
 * through. Detachment collapses the old fresh-vs-continue handler table: with
 * every stage isolated in its own child session, "send into an existing
 * session" no longer exists, so the 3-rung stale-ctx fallback ladder, the
 * registry-host fallback param, and both defensive `sendUserMessage` guards
 * are gone. The ONLY decision that still
 * varies by policy is the branch offset; continue policy collapses to a fresh
 * child (no shipped workflow uses it — its prior-session lineage cannot survive
 * detachment, by design — OQ1).
 */

import type { SessionPolicy } from "../api.js";
import type { ExecutionLane, WorkflowHostContext, WorkflowSessionContext } from "../host.js";
import type { SkillContractMap } from "../skill-contract.js";
import type { StageSession } from "../types.js";

/**
 * The per-policy branch offset — fresh ignores the stage-captured value
 * (`undefined` from `computeBranchOffset` anyway); continue flows it through so
 * a continue stage's outcome still skips the offset its row recorded (trail /
 * replay symmetry). The sole surviving policy divergence.
 */
export function branchOffsetFor(policy: SessionPolicy | undefined, captured: number | undefined): number | undefined {
	return policy === "continue" ? captured : undefined;
}

/**
 * Which lane a stage's child binds to: a skill whose contract declares
 * `interaction: "foreground"` gets the single-slot real-UI lane; everything
 * else (declared background, or undeclared → background-safe) runs in the
 * concurrent headless lane. The validator forbids fanning a `foreground` skill
 * (`checkFanoutInteraction`), so a fanout unit is always background here.
 */
export function laneFor(skillContracts: SkillContractMap | undefined, skill: string): ExecutionLane {
	return skillContracts?.get(skill)?.produces?.interaction === "foreground" ? "foreground" : "background";
}

/**
 * THE child-spawn primitive. Open an isolated child session (parent stays
 * valid), let the host send the prompt + apply lane/model, wait for the agent
 * to settle, then run `body` on the guaranteed-in-session child ctx. Up to
 * `ctx.maxConcurrency` of these may be in flight (the loop's semaphore bounds
 * fanout; single stages run one).
 */
export function spawnChildAndRun(
	ctx: WorkflowHostContext,
	s: Pick<StageSession, "prompt" | "lane" | "model" | "signal">,
	body: (child: WorkflowSessionContext) => Promise<void>,
): Promise<void> {
	return ctx.spawnChild({
		prompt: s.prompt,
		lane: s.lane,
		model: s.model,
		signal: s.signal,
		withSession: async (child) => {
			await child.waitForIdle();
			await body(child);
		},
	});
}

/**
 * THE reattach primitive — the detached replacement for the deleted
 * live-session swap (`ctx.switchSession`). Spawn a child bound to the PERSISTED
 * session at `sessionFile` (the host opens it, no fresh creation, no initial `prompt`),
 * then run `body` on the in-session child ctx whose `getBranch` reflects the
 * prior transcript. `body` is `reattachStageSession` (sessions/reattach.ts),
 * which promotes from the loaded branch or nudges via `resendIntoChild`.
 *
 * `sessionFile` is supplied by the resume entry (a `locateSessionFile` hit), so
 * the host always has a real file; a missing/in-memory case is gated upstream.
 * There is NO `{ cancelled }` arm — a detached reattach has no live-session swap
 * for the user to dismiss.
 */
export function reattachChildSession(
	ctx: WorkflowHostContext,
	s: Pick<StageSession, "prompt" | "lane" | "model" | "signal">,
	sessionFile: string,
	body: (child: WorkflowSessionContext) => Promise<void>,
): Promise<void> {
	return ctx.spawnChild({
		prompt: s.prompt, // carried for parity; NOT replayed in reattach mode (the host skips it)
		lane: s.lane,
		model: s.model,
		signal: s.signal,
		reattach: { sessionFile },
		withSession: async (child) => {
			await child.waitForIdle();
			await body(child);
		},
	});
}

/**
 * Re-prompt an already-open child and wait for it to settle — the
 * validation-retry path (`askAgentToFix`) and the resume reattach nudge.
 * Replaces the old policy-handler send path; the child ctx always exposes
 * `sendUserMessage`, so no guard.
 *
 * IDLE-BEFORE-REPROMPT INVARIANT: uses `sendUserMessage` (which QUEUES, safe
 * mid-stream), NOT `prompt()` — the SDK THROWS "Agent is already processing" if
 * `prompt()` is called while streaming. Every entry point honors this:
 * `spawnChildAndRun` calls `waitForIdle()` before `body`, and the host's
 * `prompt()` is only the single initial send. Callers must never call a child's
 * `prompt()` again after the first; re-prompts go through `sendUserMessage` here.
 */
export async function resendIntoChild(child: WorkflowSessionContext, msg: string): Promise<void> {
	await child.sendUserMessage(msg);
	await child.waitForIdle();
}
