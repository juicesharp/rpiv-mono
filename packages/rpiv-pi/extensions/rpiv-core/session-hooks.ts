/**
 * Session lifecycle wiring for rpiv-core.
 *
 * Each handler body is a named helper; pi.on(...) lines are pure wiring.
 * Ordering and invariants preserved verbatim from the pre-refactor index.ts.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentEndEvent,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	parseSkillBlock,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type CleanupResult,
	cleanupPerCwdAgents,
	type SyncResult,
	summarizeCleanupSkips,
	syncBundledAgents,
} from "./agents.js";
import { FLAG_DEBUG, MSG_TYPE_GIT_CONTEXT } from "./constants.js";
import {
	clearGitContextCache,
	isGitMutatingCommand,
	resetInjectedMarker,
	takeGitContextIfChanged,
} from "./git-context.js";
import { ARTIFACTS_SUBDIR, clearInjectionState, handleToolCallGuidance, injectRootGuidance } from "./guidance.js";
import { findMissingSiblings } from "./package-checks.js";
import { BUNDLED_SKILL_NAMES } from "./paths.js";

/**
 * Module-local "already announced" latch for the startup banner block
 * (cleanup / agent-sync drift / missing-siblings warning). Pi fires
 * `session_start` for every session including programmatic spawns
 * (workflow stages, batch ops, any extension's `newSession` call).
 * Filesystem work runs every fire — the banner notifications should NOT,
 * or `/wf <large>` re-emits the entire startup splash 10 times.
 *
 * Latches on the first banner emission. Reset on `/reload` (module
 * reload) and on process restart. Test-resettable via
 * `__resetSessionHooksAnnounced()`.
 *
 * Replaces an earlier coupling to rpiv-workflow's child-session Symbol —
 * "have I announced yet" is a per-extension concern, not a per-spawner
 * one. No other package needs to know whether session_start came from
 * the user or from a programmatic spawner.
 */
let bannerAnnounced = false;

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetSessionHooksAnnounced(): void {
	bannerAnnounced = false;
}

const msgAgentsAdded = (n: number) => `Copied ${n} rpiv-pi agent(s) to ~/.pi/agent/agents/`;
const msgAgentsHealed = (parts: string[]) => `Synced bundled agent(s): ${parts.join(", ")}.`;
const msgAgentsDrift = (parts: string[]) => `${parts.join(", ")} agent(s). Run /rpiv-update-agents to sync.`;
const msgAgentsErrors = (n: number) => `Agent sync reported ${n} error(s). Run /rpiv-update-agents for details.`;
function msgMissingSiblings(pkgs: string[]): string {
	const n = pkgs.length;
	const title = `rpiv-pi: ${n} sibling extension${n === 1 ? "" : "s"} missing`;
	const body = [...pkgs.map((p) => `• ${p}`), "", "Run /rpiv-setup to install them."];
	const total = Math.max(title.length + 6, ...body.map((l) => l.length + 4));
	const top = `╭─ ${title} ${"─".repeat(total - title.length - 5)}╮`;
	const middle = body.map((l) => `│  ${l.padEnd(total - 4)}│`).join("\n");
	const bottom = `╰${"─".repeat(total - 2)}╯`;
	return `${top}\n${middle}\n${bottom}`;
}

type UI = { notify: (msg: string, sev: "info" | "warning" | "error") => void };

// ---------------------------------------------------------------------------
// Git-context message builders
// ---------------------------------------------------------------------------

function buildGitContextMessage(pi: ExtensionAPI, content: string) {
	return { customType: MSG_TYPE_GIT_CONTEXT, content, display: !!pi.getFlag(FLAG_DEBUG) };
}

function sendGitContextMessage(pi: ExtensionAPI, content: string) {
	pi.sendMessage(buildGitContextMessage(pi, content));
}

// ---------------------------------------------------------------------------
// Registration (pure wiring)
// ---------------------------------------------------------------------------

export function registerSessionHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => onSessionStart(_event, ctx, pi));
	pi.on("session_compact", async (_event, ctx) => onSessionCompact(_event, ctx, pi));
	pi.on("session_shutdown", async () => onSessionShutdown());
	pi.on("tool_call", async (event, ctx) => onToolCall(event, ctx, pi));
	pi.on("before_agent_start", async (event, ctx) => onBeforeAgentStart(event, ctx, pi));
	pi.on("agent_end", async (_event, ctx) => onAgentEnd(_event, ctx));
}

// ---------------------------------------------------------------------------
// Named handlers
// ---------------------------------------------------------------------------

async function onSessionStart(
	_event: unknown,
	ctx: { cwd: string; hasUI: boolean; ui: UI },
	pi: ExtensionAPI,
): Promise<void> {
	resetInjectionState();
	injectRootGuidance(ctx.cwd, pi);
	migrateThoughtsToArtifacts(ctx.cwd);
	await injectGitContext(pi, (msg) => sendGitContextMessage(pi, msg));
	const cleanup = cleanupPerCwdAgents(ctx.cwd);
	const agents = syncBundledAgents(false);
	// Banner emits once per module load (process start or /reload). Programmatic
	// session spawns (workflow stages, any other extension's newSession) inherit
	// the latched state and stay silent. Filesystem work above always runs.
	if (ctx.hasUI && !bannerAnnounced) {
		notifyCleanup(ctx.ui, cleanup);
		notifyAgentSyncDrift(ctx.ui, agents);
		warnMissingSiblings(ctx.ui);
		bannerAnnounced = true;
	}
}

async function onSessionCompact(_event: unknown, ctx: { cwd: string }, pi: ExtensionAPI): Promise<void> {
	resetInjectionState();
	clearGitContextCache();
	resetInjectedMarker();
	// After auto-compaction the extension runner ctx may be stale
	// (invalidated by a concurrent session replacement or reload).
	// Fall back to process.cwd() when the proxy throws.
	let cwd: string;
	try {
		cwd = ctx.cwd;
	} catch {
		cwd = process.cwd();
	}
	injectRootGuidance(cwd, pi);
	await injectGitContext(pi, (msg) => sendGitContextMessage(pi, msg));
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

// Runs every fire — `rpiv: <skill>` is a per-stage display string (each
// stage owns the status line during its run), and the git-context injection
// is keyed off `takeGitContextIfChanged` which is its own dedup layer.
async function onBeforeAgentStart(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<{ message: ReturnType<typeof buildGitContextMessage> } | undefined> {
	const parsed = parseSkillBlock(event.prompt);
	if (parsed && isOwnedSkill(parsed.name)) ctx.ui.setStatus("rpiv-skill", `rpiv: ${parsed.name}`);
	const content = await takeGitContextIfChanged(pi);
	if (!content) return undefined;
	return { message: buildGitContextMessage(pi, content) };
}

async function onAgentEnd(_event: AgentEndEvent, ctx: ExtensionContext): Promise<void> {
	ctx.ui.setStatus("rpiv-skill", undefined);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Allowlist of rpiv-pi's own skill names, sourced from the shared
// `BUNDLED_SKILL_NAMES` constant. Prevents the status bar from claiming
// `rpiv:` ownership of user-supplied or third-party skills. The set is
// computed once at module load in paths.ts.
function isOwnedSkill(name: string): boolean {
	return BUNDLED_SKILL_NAMES.has(name);
}

function resetInjectionState(): void {
	clearInjectionState();
}

function migrateThoughtsToArtifacts(cwd: string): void {
	const oldShared = join(cwd, "thoughts", "shared");
	if (!existsSync(oldShared)) return;

	try {
		const entries = readdirSync(oldShared, { withFileTypes: true });
		if (entries.length === 0) return; // empty source — nothing to copy, leave on disk

		const newArtifacts = join(cwd, ".rpiv", ARTIFACTS_SUBDIR);
		mkdirSync(newArtifacts, { recursive: true });

		for (const entry of entries) {
			const src = join(oldShared, entry.name);
			const dest = join(newArtifacts, entry.name);
			cpSync(src, dest, { recursive: true, errorOnExist: false, force: true });
			if (!existsSync(dest)) {
				console.warn(`[rpiv-pi] migration: failed to copy ${src} → ${dest}`);
				return; // abort — don't delete source if copy failed
			}
		}

		// All copies verified — safe to remove source
		rmSync(oldShared, { recursive: true, force: true });

		// Remove thoughts/ root only if empty (preserves thoughts/me/ etc.)
		const thoughtsRoot = join(cwd, "thoughts");
		try {
			if (readdirSync(thoughtsRoot).length === 0) {
				rmSync(thoughtsRoot, { recursive: true, force: true });
			}
		} catch {
			// thoughts/ already gone or unreadable — not an error
		}
	} catch (e) {
		console.warn(`[rpiv-pi] migration: ${e instanceof Error ? e.message : String(e)}`);
		// Never crash session_start — migration is best-effort
	}
}

async function injectGitContext(pi: ExtensionAPI, send: (msg: string) => void): Promise<void> {
	const msg = await takeGitContextIfChanged(pi);
	if (msg) send(msg);
}

function notifyAgentSyncDrift(ui: UI, result: SyncResult): void {
	if (result.added.length > 0) {
		ui.notify(msgAgentsAdded(result.added.length), "info");
	}
	// Self-healing events on session_start: legacy-migration overwrites + smart-gate
	// auto-removes. Surface these explicitly so the user knows local files were touched.
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
		ui.notify(msgAgentsDrift(drift), "info");
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
