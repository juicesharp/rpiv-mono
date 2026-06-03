/**
 * Session policy dispatch. Owns the three policy-specific decisions the
 * stage / phase machinery has to make per session: which branch offset
 * the outcome sees, how the session is opened, and how an
 * already-established session is sent to.
 *
 * Two handlers — `FRESH_HANDLER` and `CONTINUE_HANDLER` — implement the
 * interface; `handlerFor(policy)` picks. Everything else in the
 * `sessions/` directory is policy-agnostic.
 */

import type { SessionPolicy } from "../api.js";
import type { WorkflowHost } from "../host.js";
import type { WorkflowHostContext } from "../types.js";

/**
 * Three policy-specific decisions that used to live as five ternaries
 * scattered across sessions.ts:
 *
 *   - `branchOffset(captured)` — the offset outcomes apply to skip
 *     the prior-stage prefix in continue sessions. Fresh ignores the
 *     stage-side captured value (it's `undefined` from
 *     `computeBranchOffset` for fresh stages anyway); continue returns
 *     it as-is.
 *   - `spawn(ctx, prompt, body, host?)` — open the session and run `body`
 *     on whichever ctx is valid for that policy (fresh → freshCtx
 *     inside `withSession`; continue → the supplied ctx, after a
 *     send+waitForIdle settles the existing session). `cancelled: true`
 *     means a fresh session was cancelled before `withSession` ran.
 *   - `send(ctx, msg, host?)` — send into an already-established session
 *     and wait for it to settle (used by the validation-retry path).
 *
 * `host` is the registry-level fallback for continue stages — used only
 * when `ctx.sendUserMessage` is absent (the outer command ctx at the
 * very start of a workflow whose first stage is continue-policy).
 * Everywhere else (continue stages following any other stage),
 * `ctx.sendUserMessage` is present and preferred because Pi marks the
 * captured host stale after `ctx.newSession()`. `enforceSessionInvariants`
 * still requires a host whenever any stage is continue-policy so the
 * start-stage path has a working fallback. Fresh ignores `host` entirely.
 */
export interface SessionPolicyHandler {
	branchOffset(capturedOffset: number | undefined): number | undefined;
	spawn(
		ctx: WorkflowHostContext,
		prompt: string,
		body: (sessionCtx: WorkflowHostContext) => Promise<void>,
		host?: WorkflowHost,
	): Promise<{ cancelled: boolean }>;
	send(ctx: WorkflowHostContext, msg: string, host?: WorkflowHost): Promise<void>;
}

export const FRESH_HANDLER: SessionPolicyHandler = {
	branchOffset: () => undefined,
	async spawn(ctx, prompt, body) {
		const { cancelled } = await ctx.newSession({
			// `freshCtx` is a `WorkflowSessionContext` — the port guarantees
			// `sendUserMessage` on the replacement ctx, so no runtime guard.
			withSession: async (freshCtx) => {
				await freshCtx.sendUserMessage(prompt);
				await body(freshCtx);
			},
		});
		return { cancelled };
	},
	async send(ctx, msg) {
		// At runtime ctx is the in-session replacement (a
		// `WorkflowSessionContext`), but the shared `SessionPolicyHandler`
		// types it as the base `WorkflowHostContext` (continue's send may run
		// on the senderless start ctx), so this seam keeps a defensive guard.
		if (!ctx.sendUserMessage) {
			throw new Error("FRESH_HANDLER.send: replacement ctx missing sendUserMessage");
		}
		await ctx.sendUserMessage(msg);
	},
};

export const CONTINUE_HANDLER: SessionPolicyHandler = {
	branchOffset: (captured) => captured,
	async spawn(ctx, prompt, body, host) {
		// Prefer the live `ctx.sendUserMessage` over the captured `host`.
		// Pi marks the registry-level host handle stale after the first
		// `ctx.newSession()`, so a continue stage that follows a fresh
		// stage would throw "extension ctx is stale" if we called
		// `host.sendUserMessage` here. The inner replacement ctx delivered
		// to `withSession` always exposes `sendUserMessage` (the port
		// marks it optional because only the outer command ctx lacks it).
		// `host` remains the fallback for the workflow-start-with-continue
		// case where there is no inner ctx yet — `enforceSessionInvariants`
		// requires a host whenever any stage is continue-policy, so the
		// fallback can be taken safely.
		//
		// Awaiting the send (vs fire-and-forget) lands transport errors on
		// this stage's halt path; pre-I5b we discarded the promise and the
		// runner walked the chain blind on rejection.
		await sendIntoExistingSession(ctx, host, prompt);
		await ctx.waitForIdle();
		await body(ctx);
		return { cancelled: false };
	},
	async send(ctx, msg, host) {
		// Same precedence as spawn: live ctx first, captured host as
		// fallback. Validation-retry sends always run inside a stage's
		// session, so `ctx.sendUserMessage` is present in practice; the
		// host branch is there for symmetry with spawn.
		await sendIntoExistingSession(ctx, host, msg);
		await ctx.waitForIdle();
	},
};

/**
 * Send a message into the already-active session. Prefers the live
 * `ctx.sendUserMessage`; falls back to the captured registry-level
 * `host.sendUserMessage` only when ctx doesn't expose one (workflow start
 * with a continue-first-stage). Throws if neither path is available —
 * `enforceSessionInvariants` should have rejected the workflow before
 * we land here.
 */
async function sendIntoExistingSession(
	ctx: WorkflowHostContext,
	host: WorkflowHost | undefined,
	msg: string,
): Promise<void> {
	if (ctx.sendUserMessage) {
		await ctx.sendUserMessage(msg);
		return;
	}
	if (host) {
		await host.sendUserMessage(msg);
		return;
	}
	throw new Error(
		"CONTINUE_HANDLER: neither ctx.sendUserMessage nor a workflow host available — continue policy requires one of them",
	);
}

export function handlerFor(policy: SessionPolicy | undefined): SessionPolicyHandler {
	return policy === "continue" ? CONTINUE_HANDLER : FRESH_HANDLER;
}
