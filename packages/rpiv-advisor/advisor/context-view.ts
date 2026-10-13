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
 * Absence and stand-down are not failures: no adapter installed, or an adapter
 * that stood down for a reason that is genuinely "no view here" (refused,
 * stood-down, empty), leaves the caller on its own history. An adapter that
 * *answered* and then broke the hand-off is a different matter — a rejected
 * claim, a malformed answer, a mismatched identity, or an invalidated snapshot.
 * Falling back there silently reinstates the uncompressed path this module
 * exists to avoid, so it is reported as `broken` and the caller is expected to
 * surface it.
 */

import type { buildSessionContext, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Wire channel. The version lives in the name so both halves can move independently. */
export const CONTEXT_VIEW_CHANNEL = "billion-context-pi:context-view:v1";

/** The extension that owns this channel. An answer from anyone else is not ours. */
export const CONTEXT_VIEW_PROVIDER = "billion-context-pi";

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

/**
 * The `inactive` reasons that really do mean "no view here, use your own
 * history": the host is unsupported, the adapter stood down for a proxy/native
 * host, or the projection came back with nothing. Every other reason — including
 * one this version has never heard of — is a hand-off that broke, because
 * falling back would send the uncompressed history this module exists to avoid.
 */
const ABSENT_REASONS = new Set(["refused", "stood-down", "empty"]);

// Read structurally — the answer crosses an extension boundary, so nothing is
// trusted, and the descriptions below are deliberately bounded: an answer
// carries the whole conversation in `messages`, and this text reaches the tool
// result, and from there the model's context.
function typeOf(value: unknown): string {
	if (value === null) return "null";
	return Array.isArray(value) ? "array" : typeof value;
}

function shortText(value: unknown, limit: number): string {
	return typeof value === "string" ? value.slice(0, limit) : typeOf(value);
}

function describeFailure(value: unknown): string {
	if (value instanceof Error) return shortText(value.message, 200);
	if (typeof value === "string") return shortText(value, 200);
	return `a non-Error rejection (${typeOf(value)})`;
}

/** Classify the adapter's answer. Only `available` and a plain stand-down are
 *  usable; everything else is a broken hand-off the caller has to surface. */
function classify(result: unknown, sessionId: string): ContextViewOutcome {
	if (typeof result !== "object" || result === null) {
		return { kind: "broken", detail: `the adapter answered with ${typeOf(result)}, not a result object` };
	}
	const {
		status,
		provider,
		sessionId: forSession,
		messages,
		reason,
	} = result as {
		status?: unknown;
		provider?: unknown;
		sessionId?: unknown;
		messages?: unknown;
		reason?: unknown;
	};

	if (status === "available") {
		// The answer's own identity is checked rather than assumed: another
		// extension answering on the same channel, or a stale answer projected
		// for a different session, must not be reviewed as this branch.
		if (provider !== CONTEXT_VIEW_PROVIDER) {
			return {
				kind: "broken",
				detail: `the answer came from ${shortText(provider, 60)}, not ${CONTEXT_VIEW_PROVIDER}`,
			};
		}
		if (forSession !== sessionId) {
			return { kind: "broken", detail: "the answer was projected for a different session" };
		}
		if (!Array.isArray(messages)) {
			return { kind: "broken", detail: `the adapter's answer carried ${typeOf(messages)}, not messages` };
		}
		return { kind: "available", messages: messages as ContextViewMessages };
	}

	if (status === "inactive") {
		if (typeof reason === "string" && ABSENT_REASONS.has(reason)) return { kind: "absent" };
		return {
			kind: "broken",
			detail: `the adapter stood down for a reason that is not a plain absence: ${shortText(reason, 60)}`,
		};
	}

	return { kind: "broken", detail: `the adapter returned an unusable answer (status: ${shortText(status, 60)})` };
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

	const sessionId = ctx.sessionManager.getSessionId();
	let claimed: Promise<unknown> | undefined;
	try {
		events.emit(CONTEXT_VIEW_CHANNEL, {
			version: 1,
			sessionId,
			ctx,
			// Synchronous by contract (event-bus handlers run before emit() returns),
			// which is what makes a missing claim mean "no provider installed"
			// rather than "a slow provider".
			claim: (result: Promise<unknown>) => {
				// First claim wins: a second provider answering must not replace the
				// answer already being awaited, and the discarded promise must not
				// reject unobserved.
				if (claimed) {
					Promise.resolve(result).catch(() => {});
					return;
				}
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
	return classify(result, sessionId);
}
