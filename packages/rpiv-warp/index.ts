import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_HEARTBEAT_MS, getBlockingTools, getHeartbeatMs } from "./config.js";
import {
	buildIdlePromptPayload,
	buildPromptSubmitPayload,
	buildQuestionAskedPayload,
	buildSessionStartPayload,
	buildStopPayload,
	buildToolCompletePayload,
	buildWorkflowQuestionAskedPayload,
	buildWorkflowQuestionCompletePayload,
	buildWorkflowSessionStartPayload,
	lastAssistantText,
	serializePayload,
	type WarpPayload,
} from "./payload.js";
import { detectWarpEnvironment } from "./protocol.js";
import { startSpinner, stopSpinner } from "./title-spinner.js";
import { writeOSC777 } from "./warp-notify.js";

// ---------------------------------------------------------------------------
// Module-level timer state — __resetState() clears for test isolation
// ---------------------------------------------------------------------------

interface PendingBlockingCall {
	readonly toolName: string;
	readonly input?: Record<string, unknown>;
}

let pendingQuery = "";
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
let heartbeatMs = DEFAULT_HEARTBEAT_MS;
// Outstanding blocking-tool calls keyed by toolCallId. Populated on `tool_call`,
// drained on `tool_execution_end`. An ESC/abort during a blocking tool never
// fires `tool_execution_end`, so entries linger here until `agent_end` drains
// them — that drain is what clears Warp's stale "Blocked" badge.
const pendingBlockingCalls = new Map<string, PendingBlockingCall>();

// Warp's "Blocked" badge
// is driven by *reasons*, not raw tool names. `question_asked` is emitted on the
// 0→1 transition and `tool_complete` on the 1→0 transition — the same
// convention as WorkflowQuestionTransport above. Keys: `tool:<toolCallId>` for
// blocking-tool calls, `PROMPT_BLOCK_REASON` for extension UI prompts. Using a
// set of reasons (not a counter or a boolean) is what makes the double-fire of
// `ask_user_question` — which fires `tool_call` AND `ui_prompt_start` — raise
// exactly once and clear exactly once, in either event order.
let turnActive = false;
const activeBlockReasons = new Set<string>();
const PROMPT_BLOCK_REASON = "prompt";

export function __resetState(): void {
	pendingQuery = "";
	if (idleTimer !== undefined) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}
	if (heartbeatInterval !== undefined) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = undefined;
	}
	heartbeatMs = DEFAULT_HEARTBEAT_MS;
	turnActive = false;
	activeBlockReasons.clear();
	pendingBlockingCalls.clear();
}

const TITLE = "warp://cli-agent";

function emit(payload: WarpPayload): void {
	writeOSC777(TITLE, serializePayload(payload));
}

// ---------------------------------------------------------------------------
// Workflow-question transport — a run-keyed OSC emitter for the rpiv-core
// workflow-question-warp-bridge. session_id is the workflow runId (Warp's
// logical session for a parked-question badge), NOT the launcher session.
// Each method is gated per-call on supportsStructured so the bridge can call
// unconditionally outside Warp; the factory is cheap and holds no state.
// ---------------------------------------------------------------------------

export interface WorkflowQuestionTransport {
	/** A workflow run parked its FIRST outstanding question (0→≥1): emit
	 *  `session_start` (defensive) then `question_asked`. No-op outside Warp. */
	asked(runId: string): void;
	/** A workflow run's LAST outstanding question cleared (≥1→0): emit
	 *  `tool_complete`. No-op outside Warp. */
	resolved(runId: string): void;
}

export function createWorkflowQuestionTransport(cwd: string): WorkflowQuestionTransport {
	return {
		asked(runId: string): void {
			if (!detectWarpEnvironment().supportsStructured) return;
			emit(buildWorkflowSessionStartPayload(runId, cwd));
			emit(buildWorkflowQuestionAskedPayload(runId, cwd));
		},
		resolved(runId: string): void {
			if (!detectWarpEnvironment().supportsStructured) return;
			emit(buildWorkflowQuestionCompletePayload(runId, cwd));
		},
	};
}

function cancelIdleTimer(): void {
	if (idleTimer !== undefined) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}
}

function startIdleTimer(ctx: ExtensionContext, branch: SessionEntry[]): void {
	cancelIdleTimer();
	idleTimer = setTimeout(() => {
		idleTimer = undefined;
		const summary = lastAssistantText(branch);
		emit(buildIdlePromptPayload(ctx, summary));
	}, 300);
	if (typeof (idleTimer as ReturnType<typeof setTimeout>).unref === "function") {
		(idleTimer as ReturnType<typeof setTimeout>).unref();
	}
}

function startHeartbeat(ctx: ExtensionContext, ms: number): void {
	stopHeartbeat();
	if (ms <= 0) return; // disabled
	heartbeatInterval = setInterval(() => {
		emit(buildPromptSubmitPayload(ctx, pendingQuery));
	}, ms);
	if (typeof heartbeatInterval.unref === "function") {
		heartbeatInterval.unref();
	}
}

function stopHeartbeat(): void {
	if (heartbeatInterval !== undefined) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = undefined;
	}
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
}

function captureBlockingCall(toolCallId: string, toolName: string, input: unknown): void {
	pendingBlockingCalls.set(toolCallId, { toolName, input: asRecord(input) });
}

/**
 * Add a reason Warp's badge should read "Blocked". Returns true iff this
 * transitioned the reason set from empty → ≥1, i.e. the caller must emit
 * `question_asked` exactly once for this block episode.
 */
function addBlockReason(reason: string): boolean {
	const wasEmpty = activeBlockReasons.size === 0;
	activeBlockReasons.add(reason);
	return wasEmpty;
}

/**
 * Remove a reason Warp's badge should read "Blocked". Returns true iff the
 * reason was present AND this emptied the set, i.e. the caller must emit
 * `tool_complete` exactly once for this block episode.
 */
function removeBlockReason(reason: string): boolean {
	if (!activeBlockReasons.delete(reason)) return false;
	return activeBlockReasons.size === 0;
}

function consumeBlockingCall(toolCallId: string): PendingBlockingCall | undefined {
	const call = pendingBlockingCalls.get(toolCallId);
	pendingBlockingCalls.delete(toolCallId);
	return call;
}

function readBranch(ctx: ExtensionContext): SessionEntry[] {
	return ctx.sessionManager.getBranch() as SessionEntry[];
}

// Mirror Pi's own tab title: `<mascot> - <repo>`, or `<mascot> - <session> - <repo>`
// once the session is named. We replace the mascot while retaining the complete
// title structure; push/pop restores Pi's mascot verbatim on stop.
function titleSuffix(ctx: ExtensionContext): string {
	const project = basename(ctx.cwd);
	const sessionName = ctx.sessionManager.getSessionName()?.trim();
	return sessionName ? ` - ${sessionName} - ${project}` : ` - ${project}`;
}

export default function (pi: ExtensionAPI): void {
	const warp = detectWarpEnvironment();
	if (!warp.isWarp || !warp.supportsStructured) return;

	const blockingTools = getBlockingTools();
	heartbeatMs = getHeartbeatMs();

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		emit(buildSessionStartPayload(ctx));
	});

	pi.on("before_agent_start", async (event) => {
		pendingQuery = event.prompt ?? "";
	});

	pi.on("agent_start", async (_event, ctx) => {
		// A missed `agent_end` (crash/reload) could leave a stale
		// Blocked reason pinned, which would suppress every future raise AND leave
		// Warp's badge lit. Reset BOTH structures here: the reason set and
		// `pendingBlockingCalls` are created and removed together everywhere else, so
		// clearing only the reasons would let the next `agent_end` drain the orphaned
		// call and emit a `tool_complete` with nothing raised before it. Clearing the
		// map unconditionally keeps the two provably in step — anything still pending
		// at turn start is stale by definition, since `agent_end` drains it and
		// `session_shutdown` clears it on every real turn. If a reason WAS pinned, tell
		// Warp the block is over before announcing the new turn; Warp's badge is driven
		// by reasons, so the map alone never warrants an emit.
		const hadStaleReason = activeBlockReasons.size > 0;
		activeBlockReasons.clear();
		pendingBlockingCalls.clear();
		if (hadStaleReason) {
			emit(buildToolCompletePayload(ctx, "ask_user_question", undefined));
		}
		turnActive = true;
		emit(buildSessionStartPayload(ctx)); // Item 2: defensive re-announce
		emit(buildPromptSubmitPayload(ctx, pendingQuery));
		startSpinner(titleSuffix(ctx));
		cancelIdleTimer(); // Item 3: cancel pending idle from previous turn
		startHeartbeat(ctx, heartbeatMs); // Item 4: heartbeat
	});

	pi.on("agent_end", async (_event, ctx) => {
		// ESC/abort during a blocking tool never fires `tool_execution_end`, so the
		// "Blocked" badge would stay stale. Drain any outstanding blocking calls
		// (emit `tool_complete` for each) to unblock before announcing the stop.
		const hadBlocked = activeBlockReasons.size > 0;
		activeBlockReasons.clear();
		let cleared = false;
		for (const [, call] of pendingBlockingCalls) {
			emit(buildToolCompletePayload(ctx, call.toolName, call.input));
			cleared = true;
		}
		pendingBlockingCalls.clear();
		if (hadBlocked && !cleared) {
			// ESC during an extension UI prompt that gated a
			// NON-blocking tool (e.g. a permission prompt). The drain above emitted
			// nothing, so clear the badge here.
			emit(buildToolCompletePayload(ctx, "ask_user_question", undefined));
		}
		emit(buildStopPayload(ctx, readBranch(ctx)));
		stopSpinner();
		stopHeartbeat(); // Item 4: stop heartbeat
		turnActive = false;
		startIdleTimer(ctx, readBranch(ctx)); // Item 3: schedule idle_prompt after 300ms
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!blockingTools.has(event.toolName)) return;
		captureBlockingCall(event.toolCallId, event.toolName, event.input); // Item 6: capture input
		if (addBlockReason(`tool:${event.toolCallId}`)) {
			emit(buildQuestionAskedPayload(ctx));
			stopSpinner();
			stopHeartbeat(); // Item 4: pause heartbeat
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!blockingTools.has(event.toolName)) return;
		const pending = consumeBlockingCall(event.toolCallId); // Item 6: consume input
		if (removeBlockReason(`tool:${event.toolCallId}`)) {
			emit(buildToolCompletePayload(ctx, event.toolName, pending?.input));
			startSpinner(titleSuffix(ctx));
			startHeartbeat(ctx, heartbeatMs); // Item 4: resume heartbeat
		}
	});

	// Raise Warp's Blocked badge for ANY blocking extension UI prompt, not just
	// blockingTools name matches. Permission prompts are not tool calls — they are
	// `ctx.ui` raised inside a `tool_call` handler on the gated tool — so the
	// name-based check above can never see them.
	pi.on("ui_prompt_start", async (_event, ctx) => {
		if (!turnActive) return; // config modal etc. outside a turn
		if (addBlockReason(PROMPT_BLOCK_REASON)) {
			emit(buildQuestionAskedPayload(ctx));
			stopSpinner();
			stopHeartbeat();
		}
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		if (!removeBlockReason(PROMPT_BLOCK_REASON)) return;
		emit(buildToolCompletePayload(ctx, "ask_user_question", undefined));
		if (turnActive) {
			// Never (re)start a heartbeat outside a turn.
			startSpinner(titleSuffix(ctx));
			startHeartbeat(ctx, heartbeatMs);
		}
	});

	pi.on("session_shutdown", async () => {
		cancelIdleTimer();
		stopHeartbeat();
		pendingQuery = "";
		activeBlockReasons.clear();
		pendingBlockingCalls.clear();
		turnActive = false;
		stopSpinner();
	});
}
