/**
 * lane-streaming — the host's session-view wrapper backing LaneSession.getStreamingMessage().
 *
 * The lane surfaces (viewer + dock) read the in-flight partial assistant message after each
 * streaming tick to render live thinking. That partial lives ONLY in the SDK's message_update
 * event payload — no public AgentSession getter exposes it, and isStreaming is too coarse to
 * dedup (it stays true during mid-turn tool execution, when the assistant turn is already
 * committed to getBranch()). So this view subscribes ONCE to the child and tracks the partial
 * off the message_start/update/end brackets, exposing it via getStreamingMessage() that clears
 * EXACTLY at message_end — the instant the turn folds into getBranch() — so a surface never
 * double-renders the committed turn.
 *
 * The view delegates every other LaneSession member to the raw session; the host publishes the
 * view as currentSession and keeps the raw session local for abort + teardown + snapshot.
 * dispose() tears down the capture subscription (the host calls it in its per-stage finally).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LaneSession } from "./run-lane-registry.js";

/** The agent event the raw session's subscribe listener receives — derived from the SDK
 *  signature so this module imports no SDK event-type value. */
type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

/** A LaneSession that also carries a disposer for its internal capture subscription. */
export interface LaneSessionView extends LaneSession {
	/** Tear down the internal message-stream subscription (host per-stage finally). */
	dispose(): void;
}

/**
 * Wrap a live child AgentSession in a LaneSession view that tracks the in-flight partial.
 * Subscribes once: message_start/update of an assistant role set the partial; message_end (or
 * a non-assistant message_start) clears it — the per-turn dedup signal. Every other member
 * delegates to the raw session, so the viewer/dock read getBranch/getCwd/getToolDefinition/
 * subscribe unchanged.
 */
export function createLaneSessionView(session: AgentSession): LaneSessionView {
	let streaming: AssistantMessage | undefined;
	const unsub = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "message_start":
			case "message_update":
				// Only an assistant turn streams thinking/text; any other role clears a stale partial.
				streaming = event.message.role === "assistant" ? (event.message as AssistantMessage) : undefined;
				break;
			case "message_end":
				// The turn just committed into getBranch() — drop the partial so it isn't double-rendered.
				streaming = undefined;
				break;
		}
	});
	return {
		get sessionId() {
			return session.sessionId;
		},
		get isStreaming() {
			return session.isStreaming;
		},
		sessionManager: session.sessionManager,
		getToolDefinition: (name) => session.getToolDefinition(name),
		subscribe: (listener) => session.subscribe(listener),
		getStreamingMessage: () => streaming,
		getUsage: () => session.getSessionStats(),
		dispose: () => unsub(),
	};
}
