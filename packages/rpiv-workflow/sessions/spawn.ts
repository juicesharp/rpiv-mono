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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionPolicy } from "../api.js";
import type { RunnerCtx } from "../types.js";

/**
 * Three policy-specific decisions that used to live as five ternaries
 * scattered across sessions.ts:
 *
 *   - `branchOffset(captured)` — the offset outcomes apply to skip
 *     the prior-stage prefix in continue sessions. Fresh ignores the
 *     stage-side captured value (it's `undefined` from
 *     `computeBranchOffset` for fresh stages anyway); continue returns
 *     it as-is.
 *   - `spawn(ctx, prompt, body, pi?)` — open the session and run `body`
 *     on whichever ctx is valid for that policy (fresh → freshCtx
 *     inside `withSession`; continue → the supplied ctx, after a
 *     send+waitForIdle settles the existing session). `cancelled: true`
 *     means a fresh session was cancelled before `withSession` ran.
 *   - `send(ctx, msg, pi?)` — send into an already-established session
 *     and wait for it to settle (used by the validation-retry path).
 *
 * `pi` is required for continue (caller passes `s.pi`; the start-of-run
 * preflight has already rejected any workflow that needs continue
 * without pi). Fresh ignores the `pi` parameter.
 */
export interface SessionPolicyHandler {
	branchOffset(capturedOffset: number | undefined): number | undefined;
	spawn(
		ctx: RunnerCtx,
		prompt: string,
		body: (sessionCtx: RunnerCtx) => Promise<void>,
		pi?: ExtensionAPI,
	): Promise<{ cancelled: boolean }>;
	send(ctx: RunnerCtx, msg: string, pi?: ExtensionAPI): Promise<void>;
}

export const FRESH_HANDLER: SessionPolicyHandler = {
	branchOffset: () => undefined,
	async spawn(ctx, prompt, body) {
		const { cancelled } = await ctx.newSession({
			withSession: async (freshCtx) => {
				await freshCtx.sendUserMessage(prompt);
				await body(freshCtx);
			},
		});
		return { cancelled };
	},
	async send(ctx, msg) {
		await (ctx as unknown as { sendUserMessage(m: string): Promise<void> }).sendUserMessage(msg);
	},
};

export const CONTINUE_HANDLER: SessionPolicyHandler = {
	branchOffset: (captured) => captured,
	async spawn(ctx, prompt, body, pi) {
		if (!pi) throw new Error("CONTINUE_HANDLER.spawn: continue policy requires pi (ExtensionAPI)");
		// `pi.sendUserMessage` returns a Promise — pre-I5b we discarded it,
		// so a rejected send (e.g. transport closed, agent SDK fault)
		// surfaced as unhandledRejection past the stage boundary and the
		// runner kept walking the chain blind. Await so the rejection lands
		// on this stage's halt path. We don't `await ctx.waitForIdle({ signal })`
		// because Pi's SDK doesn't expose an abort signal yet — abandoned
		// waitForIdle from a prior retry can still settle on the next
		// continue stage's ctx (tracked, not fixed here).
		await pi.sendUserMessage(prompt);
		await ctx.waitForIdle();
		await body(ctx);
		return { cancelled: false };
	},
	async send(ctx, msg, pi) {
		if (!pi) throw new Error("CONTINUE_HANDLER.send: continue policy requires pi (ExtensionAPI)");
		await pi.sendUserMessage(msg);
		await ctx.waitForIdle();
	},
};

export function handlerFor(policy: SessionPolicy | undefined): SessionPolicyHandler {
	return policy === "continue" ? CONTINUE_HANDLER : FRESH_HANDLER;
}
