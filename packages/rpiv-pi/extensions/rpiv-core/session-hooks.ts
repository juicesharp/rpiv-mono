/**
 * Session lifecycle wiring for rpiv-core.
 *
 * Each handler body is a named helper; pi.on(...) lines are pure wiring.
 * Ordering and invariants preserved verbatim from the pre-refactor index.ts.
 */

import {
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type CleanupResult,
	cleanupPerCwdAgents,
	type SyncResult,
	summarizeCleanupSkips,
	syncBundledAgents,
} from "./agents.js";
import { renderBanner } from "./banner.js";
import { FLAG_DEBUG, MSG_TYPE_GIT_CONTEXT, MSG_TYPE_POST_COMPACT_CONTEXT } from "./constants.js";
import {
	clearGitContextCache,
	isGitMutatingCommand,
	refreshGitContextForInjection,
	resetInjectedMarker,
	takeGitContextIfChanged,
} from "./git-context.js";
import { clearInjectionState, handleToolCallGuidance, injectRootGuidance, takeRootGuidance } from "./guidance.js";
import { findMissingSiblings } from "./package-checks.js";
import { injectPipelinePointer, PIPELINE_POINTER } from "./pipeline-pointer.js";
import { isStaleCtxError } from "./utils.js";

/**
 * Module-local latch for the startup-maintenance block (per-cwd agent cleanup,
 * bundled-agent sync, and the banner). Pi fires `session_start` for every
 * session including programmatic spawns (workflow stages, batch ops), but this
 * work must run ONCE per process load, not per fire: the banner would otherwise
 * reprint on every `/wf` stage, and `syncBundledAgents` targets the global
 * `~/.pi/agent/agents/` dir whose source can't change mid-process (upgrades need
 * a restart or `/reload`) — so re-running just recomputes identical hashes.
 * `/rpiv-update-agents` and `/reload` remain the explicit re-sync paths.
 *
 * Latches on first `session_start`; reset on `/reload` + restart. Test-resettable.
 */
let startupMaintenanceDone = false;

/**
 * Sessions whose compacted-away RPIV context must be restored on their next
 * real user turn. Keying by SessionManager identity prevents a detached child
 * compaction from arming the root launcher (or another concurrent child).
 */
let postCompactSessions = new WeakSet<object>();

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetSessionHooksAnnounced(): void {
	startupMaintenanceDone = false;
	postCompactSessions = new WeakSet<object>();
}

const msgAgentsAdded = (n: number) => `Copied ${n} rpiv-pi agent(s) to ~/.pi/agent/agents/`;
const msgAgentsHealed = (parts: string[]) => `Synced bundled agent(s): ${parts.join(", ")}.`;
const msgAgentsDrift = (parts: string[]) =>
	renderBanner("rpiv-pi: bundled agents need attention", [
		...parts.map((p) => `• ${p}`),
		"",
		"Run /rpiv-update-agents to sync.",
	]);
const msgAgentsErrors = (n: number) => `Agent sync reported ${n} error(s). Run /rpiv-update-agents for details.`;
const msgMissingSiblings = (pkgs: string[]) =>
	renderBanner(`rpiv-pi: ${pkgs.length} sibling extension${pkgs.length === 1 ? "" : "s"} missing`, [
		...pkgs.map((p) => `• ${p}`),
		"",
		"Run /rpiv-setup to install them.",
	]);

type UI = { notify: (msg: string, sev: "info" | "warning" | "error") => void };

// ---------------------------------------------------------------------------
// Git-context message builders
// ---------------------------------------------------------------------------

function buildGitContextMessage(pi: ExtensionAPI, content: string) {
	return { customType: MSG_TYPE_GIT_CONTEXT, content, display: !!pi.getFlag(FLAG_DEBUG) };
}

function buildPostCompactContextMessage(pi: ExtensionAPI, rootGuidance: string | null, gitContext: string | null) {
	const parts = [
		"[rpiv post-compaction context — reference material, NOT a task. Do not acknowledge this block. Answer the user's current request; when it says to continue, resume from the compaction summary and authoritative artifacts.]",
		PIPELINE_POINTER,
		rootGuidance,
		gitContext,
	].filter((part): part is string => part !== null);
	return {
		customType: MSG_TYPE_POST_COMPACT_CONTEXT,
		content: parts.join("\n\n---\n\n"),
		display: !!pi.getFlag(FLAG_DEBUG),
	};
}

function sendGitContextMessage(pi: ExtensionAPI, content: string) {
	pi.sendMessage(buildGitContextMessage(pi, content));
}

// ---------------------------------------------------------------------------
// Registration (pure wiring)
// ---------------------------------------------------------------------------

export function registerSessionHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => onSessionStart(_event, ctx, pi));
	pi.on("session_compact", async (_event, ctx) => onSessionCompact(_event, ctx));
	pi.on("session_shutdown", async () => onSessionShutdown());
	pi.on("tool_call", async (event, ctx) => onToolCall(event, ctx, pi));
	pi.on("before_agent_start", async (event, ctx) => onBeforeAgentStart(event, ctx, pi));
}

// ---------------------------------------------------------------------------
// Named handlers
// ---------------------------------------------------------------------------

async function onSessionStart(
	_event: unknown,
	ctx: { cwd: string; hasUI: boolean; ui: UI; sessionManager: object },
	pi: ExtensionAPI,
): Promise<void> {
	postCompactSessions.delete(ctx.sessionManager);
	resetInjectionState();
	injectRootGuidance(ctx.cwd, pi);
	injectPipelinePointer(pi);
	await injectGitContext(pi, (msg) => sendGitContextMessage(pi, msg));

	// Injections above run every fire (each stage needs its own guidance + git
	// context); startup maintenance below runs once per process load — see the
	// `startupMaintenanceDone` doc-block.
	if (startupMaintenanceDone) return;
	startupMaintenanceDone = true;

	const cleanup = cleanupPerCwdAgents(ctx.cwd);
	const agents = syncBundledAgents(false);
	// Banner only when a UI is bound; the filesystem work above runs regardless,
	// so a headless first session still installs agents.
	if (ctx.hasUI) {
		notifyCleanup(ctx.ui, cleanup);
		notifyAgentSyncDrift(ctx.ui, agents);
		warnMissingSiblings(ctx.ui);
	}
}

async function onSessionCompact(_event: unknown, ctx: { sessionManager: object }): Promise<void> {
	resetInjectionState();
	clearGitContextCache();
	resetInjectedMarker();
	// NEVER call pi.sendMessage here. Auto-compaction runs before overflow retry
	// settles, so injected messages become steering queue items. With Pi's default
	// one-at-a-time delivery each item can consume its own assistant turn and
	// displace the interrupted task. Mark this exact session instead; its next
	// user-authored turn receives one merged context block from before_agent_start.
	// Overflow retry itself proceeds from the compaction summary with no synthetic
	// last message competing for the model's attention.
	//
	// Auto-compaction can also race session disposal. In that path ctx is a stale
	// proxy and the replacement session's session_start performs normal injection,
	// so swallowing only the canonical stale error remains correct.
	try {
		postCompactSessions.add(ctx.sessionManager);
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

async function onSessionShutdown(): Promise<void> {
	resetInjectionState();
	clearGitContextCache();
	resetInjectedMarker();
}

// Runs unconditionally — per-tool-call guidance injection and git-context
// cache invalidation are per-event concerns, not user-facing announcements.
// The guidance injector runs once per tool call so each stage sees the
// right surface; a bash command mid-stage must dirty the git cache for
// the next stage's `before_agent_start` git-context read.
async function onToolCall(event: ToolCallEvent, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	handleToolCallGuidance(event, ctx, pi);
	if (isToolCallEventType("bash", event) && isGitMutatingCommand(event.input.command)) {
		clearGitContextCache();
	}
}

// Runs every fire — the git-context injection is keyed off
// `takeGitContextIfChanged` which is its own dedup layer.
async function onBeforeAgentStart(
	_event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<
	| { message: ReturnType<typeof buildGitContextMessage> }
	| { message: ReturnType<typeof buildPostCompactContextMessage> }
	| undefined
> {
	if (postCompactSessions.has(ctx.sessionManager)) {
		postCompactSessions.delete(ctx.sessionManager);
		const rootGuidance = takeRootGuidance(ctx.cwd, "restored on the first user turn after compaction", true);
		const gitContext = await refreshGitContextForInjection(pi);
		return { message: buildPostCompactContextMessage(pi, rootGuidance, gitContext) };
	}

	const content = await takeGitContextIfChanged(pi);
	if (!content) return undefined;
	return { message: buildGitContextMessage(pi, content) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetInjectionState(): void {
	clearInjectionState();
}

async function injectGitContext(pi: ExtensionAPI, send: (msg: string) => void): Promise<void> {
	const msg = await takeGitContextIfChanged(pi);
	if (msg) send(msg);
}

function notifyAgentSyncDrift(ui: UI, result: SyncResult): void {
	if (result.added.length > 0) {
		ui.notify(msgAgentsAdded(result.added.length), "info");
	}
	// Self-healing events on session_start: smart-gate auto-updates and auto-removes.
	// Surface these explicitly so the user knows local files were touched.
	const healed: string[] = [];
	if (result.updated.length > 0) healed.push(`${result.updated.length} updated`);
	if (result.removed.length > 0) healed.push(`${result.removed.length} removed`);
	if (healed.length > 0) {
		ui.notify(msgAgentsHealed(healed), "info");
	}
	const drift: string[] = [];
	if (result.pendingUpdate.length > 0) drift.push(`${result.pendingUpdate.length} outdated`);
	if (result.pendingRemove.length > 0) drift.push(`${result.pendingRemove.length} removed from bundle`);
	if (drift.length > 0) {
		ui.notify(`\n${msgAgentsDrift(drift)}`, "info");
	}
	if (result.errors.length > 0) {
		ui.notify(msgAgentsErrors(result.errors.length), "warning");
	}
}

function notifyCleanup(ui: UI, result: CleanupResult): void {
	if (result.cleanedUp.length > 0) {
		ui.notify(`Cleaned up ${result.cleanedUp.length} per-project agent directory (migrated to global)`, "info");
	}
	if (result.skipped.length > 0) {
		ui.notify(
			`Preserved ${result.skipped.length} per-project agent directory (${summarizeCleanupSkips(result.skipped)})`,
			"info",
		);
	}
	if (result.errors.length > 0) {
		ui.notify(`Agent cleanup reported ${result.errors.length} error(s)`, "warning");
	}
}

function warnMissingSiblings(ui: UI): void {
	const missing = findMissingSiblings();
	if (missing.length === 0) return;
	// Leading newline so Pi's "Warning: " severity prefix sits on its own
	// line; every box row then gets Pi's 1-space continuation indent
	// uniformly and the border stays aligned.
	ui.notify(`\n${msgMissingSiblings(missing.map((m) => m.pkg.replace(/^npm:/, "")))}`, "warning");
}
