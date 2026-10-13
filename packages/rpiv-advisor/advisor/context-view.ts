/**
 * context-view — consumer half of the cross-extension context view (protocol
 * v1, provider: billion-context-pi). The advisor reviews the executor's branch,
 * but rebuilding that branch from session entries hands it Pi's raw history:
 * the compression adapter's projection (summary injection, ref tags, pairing
 * sanitization, reasoning drop) is applied inside the adapter's own context
 * transform and never lands in the entries. Asking the adapter to project the
 * branch as it stands gives the advisor the same context the executor's model
 * saw, and stays read-only — the provider rebuilds the projection into isolated
 * state and hands back a deep copy, so no compression state is saved or mutated
 * on the advisor's behalf. Image stripping is not part of that projection: it
 * runs later, at Pi's before_provider_request hook.
 *
 * Absence and stand-down are not failures: no adapter installed, or an inactive
 * answer (adapter refused, adapter stood down, session mismatch, nothing to
 * project), leaves the caller on its own history. An adapter that *answered* and
 * then broke the hand-off is a different matter — falling back there silently
 * reinstates the uncompressed path this module exists to avoid — so it is
 * reported as `broken` and the caller is expected to surface it.
 */

import type { buildSessionContext, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Wire channel. The version lives in the name so both halves can move independently. */
export const CONTEXT_VIEW_CHANNEL = "billion-context-pi:context-view:v1";

/** The adapter's projection is the same element type Pi's resolved context holds. */
export type ContextViewMessages = ReturnType<typeof buildSessionContext>["messages"];

/**
 * The three answers a caller has to tell apart:
 *  - `available`: the adapter projected the branch — use it;
 *  - `absent`:    no adapter, or a legitimate stand-down — fall back to Pi's history;
 *  - `broken`:    the adapter answered and the hand-off failed — the caller must
 *                 surface it rather than review the uncompressed history.
 */
export type ContextViewOutcome =
	| { kind: "available"; messages: ContextViewMessages }
	| { kind: "absent" }
	| { kind: "broken"; detail: string };

// Read structurally — the answer crosses an extension boundary, so only
// `status` and `messages` are trusted, and only as far as they are checked.
function availableMessages(result: unknown): ContextViewMessages | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const { status, messages } = result as { status?: unknown; messages?: unknown };
	if (status !== "available" || !Array.isArray(messages)) return undefined;
	return messages as ContextViewMessages;
}

function isInactive(result: unknown): boolean {
	if (typeof result !== "object" || result === null) return false;
	return (result as { status?: unknown }).status === "inactive";
}

function describeFailure(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Ask the installed compression adapter to project this branch. Never throws:
 * every failure is classified, because the caller has to distinguish "no
 * adapter" from "the adapter broke".
 */
export async function requestContextView(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ContextViewOutcome> {
	// Capability probe, mirroring the provider's: a host (or test double)
	// without an event bus has no adapter to ask, and must fall back rather
	// than fail the call.
	const events = pi?.events;
	if (typeof events?.emit !== "function") return { kind: "absent" };

	let claimed: Promise<unknown> | undefined;
	try {
		events.emit(CONTEXT_VIEW_CHANNEL, {
			version: 1,
			sessionId: ctx.sessionManager.getSessionId(),
			ctx,
			// Synchronous by contract (event-bus handlers run before emit() returns),
			// which is what makes a missing claim mean "no provider installed"
			// rather than "a slow provider".
			claim: (result: Promise<unknown>) => {
				claimed = result;
			},
		});
	} catch (err) {
		return { kind: "broken", detail: `asking the adapter threw: ${describeFailure(err)}` };
	}
	if (!claimed) return { kind: "absent" };

	let result: unknown;
	try {
		result = await claimed;
	} catch (err) {
		return { kind: "broken", detail: `the adapter's answer was rejected: ${describeFailure(err)}` };
	}
	const messages = availableMessages(result);
	if (messages) return { kind: "available", messages };
	if (isInactive(result)) return { kind: "absent" };
	return { kind: "broken", detail: `the adapter returned an unusable answer: ${describeFailure(result)}` };
}
