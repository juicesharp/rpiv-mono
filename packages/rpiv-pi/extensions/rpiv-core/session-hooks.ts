/**
 * Session lifecycle wiring for rpiv-core.
 *
 * Each handler body is a named helper; pi.on(...) lines are pure wiring.
 * Ordering and invariants preserved verbatim from the pre-refactor index.ts.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
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
import { FLAG_DEBUG, MSG_TYPE_GIT_CONTEXT } from "./constants.js";
import {
	clearGitContextCache,
	isGitMutatingCommand,
	resetInjectedMarker,
	takeGitContextIfChanged,
} from "./git-context.js";
import { ARTIFACTS_SUBDIR, clearInjectionState, handleToolCallGuidance, injectRootGuidance } from "./guidance.js";
import { findMissingSiblings } from "./package-checks.js";

const ARTIFACTS_ROOT = `.rpiv/${ARTIFACTS_SUBDIR}`;
const ARTIFACTS_DIRS = [
	`${ARTIFACTS_ROOT}/discover`,
	`${ARTIFACTS_ROOT}/research`,
	`${ARTIFACTS_ROOT}/designs`,
	`${ARTIFACTS_ROOT}/plans`,
	`${ARTIFACTS_ROOT}/handoffs`,
	`${ARTIFACTS_ROOT}/reviews`,
	`${ARTIFACTS_ROOT}/solutions`,
] as const;

const msgAgentsAdded = (n: number) => `Copied ${n} rpiv-pi agent(s) to ~/.pi/agent/agents/`;
const msgAgentsHealed = (parts: string[]) => `Synced bundled agent(s): ${parts.join(", ")}.`;
const msgAgentsDrift = (parts: string[]) => `${parts.join(", ")} agent(s). Run /rpiv-update-agents to sync.`;
const msgAgentsErrors = (n: number) => `Agent sync reported ${n} error(s). Run /rpiv-update-agents for details.`;
const msgMissingSiblings = (n: number, list: string) =>
	`rpiv-pi requires ${n} sibling extension(s): ${list}. Run /rpiv-setup to install them.`;

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
	pi.on("before_agent_start", async () => onBeforeAgentStart(pi));
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
	if (ctx.hasUI) {
		notifyCleanup(ctx.ui, cleanup);
		notifyAgentSyncDrift(ctx.ui, agents);
		warnMissingSiblings(ctx.ui);
	}
}

async function onSessionCompact(_event: unknown, ctx: { cwd: string }, pi: ExtensionAPI): Promise<void> {
	resetInjectionState();
	clearGitContextCache();
	resetInjectedMarker();
	injectRootGuidance(ctx.cwd, pi);
	await injectGitContext(pi, (msg) => sendGitContextMessage(pi, msg));
}

async function onSessionShutdown(): Promise<void> {
	resetInjectionState();
	clearGitContextCache();
	resetInjectedMarker();
}

async function onToolCall(event: ToolCallEvent, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	handleToolCallGuidance(event, ctx, pi);
	if (isToolCallEventType("bash", event) && isGitMutatingCommand(event.input.command)) {
		clearGitContextCache();
	}
}

async function onBeforeAgentStart(
	pi: ExtensionAPI,
): Promise<{ message: ReturnType<typeof buildGitContextMessage> } | undefined> {
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

function migrateThoughtsToArtifacts(cwd: string): void {
	const oldShared = join(cwd, "thoughts", "shared");
	const newArtifacts = join(cwd, ".rpiv", ARTIFACTS_SUBDIR);

	// Phase 1: Migrate existing thoughts/shared/ → .rpiv/artifacts/
	if (existsSync(oldShared)) {
		try {
			mkdirSync(newArtifacts, { recursive: true });

			const entries = readdirSync(oldShared, { withFileTypes: true }).filter((d) => d.isDirectory());

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

	// Phase 2: Ensure artifact directories exist (mirrors old scaffolding)
	for (const dir of ARTIFACTS_DIRS) {
		mkdirSync(join(cwd, dir), { recursive: true });
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
	ui.notify(msgMissingSiblings(missing.length, missing.map((m) => m.pkg.replace(/^npm:/, "")).join(", ")), "warning");
}
