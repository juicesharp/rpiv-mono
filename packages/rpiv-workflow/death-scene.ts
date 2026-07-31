/**
 * death-scene.ts — forensic Markdown artifact written on stage/unit failure.
 *
 * On any transition to failed (terminal failure or a collect-all unit soft-halt),
 * the two failure-record writers (`recordFatalFailure` /
 * `recordUnitHalt` in `audit.ts`) call `writeDeathSceneArtifact` immediately
 * after they persist the JSONL failure row. The writer locates the just-failed
 * session's persisted JSONL, re-reads its branch through the host-injected
 * `AuditContext.readSessionBranch` (NO live-session re-query — the child is already
 * torn down), extracts the forensic scene, and writes a sidecar `.md` under
 * `<cwd>/.rpiv/artifacts/failures/`.
 *
 * Fail-soft throughout and SYNCHRONOUS: the entire body is try/caught, and on
 * ANY failure (locate miss, reader throw, write error) it warns via
 * `ctx.ui.notify(..., "warning")` and
 * continues — the original failure (already persisted by `recordFailureRow`)
 * is never masked. Skips SILENTLY (no throw, no artifact, no warning) when
 * `audit.session === null` (sessionless failures: entry throws, seam aborts
 * via `auditCtxFor`) or `audit.readSessionBranch === undefined` (programmatic
 * embedder / no provider).
 *
 * No JSONL row is written — the artifact is a sidecar `.md`, never read by the
 * resume fold, so `STATE_SCHEMA_VERSION` is NOT bumped.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditContext } from "./audit-ctx.js";
import type { WorkflowHostContext } from "./host.js";
import { locateSessionFile } from "./sessions/locate.js";
import { type BranchEntry, iterToolUses, lastAssistantText } from "./transcript.js";

/** How many trailing tool calls the artifact carries (most-recent first wins via slice). */
export const DEATH_SCENE_MAX_TOOL_CALLS = 5;

/** Per-tool-call args JSON cap; a trailing "…" marks a truncation. */
export const DEATH_SCENE_TOOL_ARG_MAX_CHARS = 500;

/** One tool call in the death scene — name + args JSON (truncated). */
export interface DeathSceneToolCall {
	name: string;
	args: string;
}

/** The forensic payload rendered into the sidecar Markdown. */
export interface DeathScene {
	runId: string;
	stage: string;
	stageNumber: number;
	/** Present iff the failure belongs to a loop unit (`audit.unit.id`). */
	unitId?: string;
	errMsg: string;
	/** Final assistant text (`lastAssistantText`); omitted when empty/absent. */
	finalText?: string;
	/** Last-N tool calls (name + truncated args). */
	toolCalls: DeathSceneToolCall[];
	/** Absolute on-disk path of the persisted session JSONL. */
	sessionFile: string;
}

/**
 * Sanitize an author-controlled segment (stage name / unit id / runId) for use
 * as a single filename component: strip path separators + control chars (so the
 * segment can't escape `failures/` or mangle the filename) and collapse
 * whitespace runs to `_`. Falls back to `"stage"` for an all-disallowed input.
 */
function sanitizeSegment(segment: string): string {
	const cleaned = segment.replace(/[\\/\u0000-\u001f]/g, "_").replace(/\s+/g, "_");
	return cleaned || "stage";
}

/**
 * The artifact path: `<cwd>/.rpiv/artifacts/failures/<runId>_<stageNumber>_<unitId-or-stage>.md`.
 * The unit segment is the unit's stable id when present (`audit.unit.id`), else
 * the stage name — BOTH sanitized: real unit ids carry path separators
 * (`"phase 2/5"`), which would otherwise nest the artifact in a surprise
 * subdirectory. Pure — no I/O.
 */
export function deathSceneFilePath(cwd: string, audit: AuditContext): string {
	const stageNumber = audit.allocatedStageNumber ?? audit.state.lastAllocatedStageNumber;
	// `unit.id` is the stable disambiguator when present (fanout/iterate). Assess-loop units
	// carry no id (identified by `(role, round)`); append `_u<index>` so filename uniqueness
	// does NOT depend on the decorated stageName's `r{index}·{phase}` tag — the decoration
	// disambiguates today, but display strings are not a uniqueness contract. The whole segment
	// (index included) is routed through sanitizeSegment so it cannot escape failures/.
	const unitBase = audit.unit?.id ?? (audit.unit ? `${audit.stageName}_u${audit.unit.index}` : audit.stageName);
	const unitSegment = sanitizeSegment(unitBase);
	const runSegment = sanitizeSegment(audit.runId);
	return join(cwd, ".rpiv", "artifacts", "failures", `${runSegment}_${stageNumber}_${unitSegment}.md`);
}

/**
 * JSON-stringify a tool-call's input, truncated to the args cap. A trailing "…"
 * marks a truncation; an un-stringifiable input degrades to `String(input)`.
 */
function truncateArgs(input: Record<string, unknown>): string {
	let json: string;
	try {
		json = JSON.stringify(input);
	} catch {
		json = String(input);
	}
	if (json.length <= DEATH_SCENE_TOOL_ARG_MAX_CHARS) return json;
	return `${json.slice(0, DEATH_SCENE_TOOL_ARG_MAX_CHARS)}…`;
}

/**
 * Pure extractor — assemble a `DeathScene` from the persisted branch + the
 * failure's audit identity. No I/O. `toolCalls` are the LAST
 * `DEATH_SCENE_MAX_TOOL_CALLS` tool uses in branch order (forward scan via
 * `iterToolUses`, then tail slice); `finalText` is the last assistant message's
 * joined text parts (via `lastAssistantText`), omitted when empty.
 */
export function extractDeathScene(
	audit: AuditContext,
	errMsg: string,
	branch: BranchEntry[],
	sessionFile: string,
): DeathScene {
	const all: DeathSceneToolCall[] = [];
	for (const use of iterToolUses(branch)) {
		all.push({ name: use.name, args: truncateArgs(use.input) });
	}
	const toolCalls = all.slice(-DEATH_SCENE_MAX_TOOL_CALLS);
	const finalText = lastAssistantText(branch);
	const stageNumber = audit.allocatedStageNumber ?? audit.state.lastAllocatedStageNumber;
	return {
		runId: audit.runId,
		stage: audit.stageName,
		stageNumber,
		...(audit.unit?.id ? { unitId: audit.unit.id } : {}),
		errMsg,
		...(finalText ? { finalText } : {}),
		toolCalls,
		sessionFile,
	};
}

/**
 * Pure formatter — render a `DeathScene` as forensic Markdown. No I/O. The body
 * carries runId, stage (+number), unit (when present), errMsg, the absolute
 * session-file path, the final assistant text, and the last-N tool calls (each
 * with its truncated args under a fenced block).
 */
export function formatDeathScene(scene: DeathScene): string {
	const lines: string[] = [];
	lines.push(`# Death scene: ${scene.stage}`);
	lines.push("");
	lines.push(`- **Run:** \`${scene.runId}\``);
	lines.push(`- **Stage:** \`${scene.stage}\` (#${scene.stageNumber})`);
	if (scene.unitId) lines.push(`- **Unit:** \`${scene.unitId}\``);
	lines.push(`- **Error:** ${scene.errMsg}`);
	lines.push(`- **Session file:** \`${scene.sessionFile}\``);
	lines.push("");
	lines.push("## Final assistant text");
	lines.push("");
	lines.push(scene.finalText?.trim() ? scene.finalText.trim() : "_(none)_");
	lines.push("");
	const callCount = scene.toolCalls.length;
	lines.push(`## Last ${callCount} tool call${callCount === 1 ? "" : "s"}`);
	lines.push("");
	if (callCount === 0) {
		lines.push("_(none)_");
	} else {
		for (const call of scene.toolCalls) {
			// Fence one backtick longer than the longest backtick run in the args, so
			// a ``` inside a tool arg cannot break out of its fenced block.
			const longestRun = call.args.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
			const fence = "`".repeat(Math.max(3, longestRun + 1));
			lines.push(`- \`${call.name}\``);
			lines.push(`  ${fence}`);
			lines.push(`  ${call.args}`);
			lines.push(`  ${fence}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Impure orchestrator — write the death-scene artifact for a failed stage/unit.
 *
 * SKIPS silently (no throw, no artifact, no warning) when:
 *   - `audit.session === null` — sessionless failures (entry throws, seam aborts
 *     via `auditCtxFor`, which never populates `readSessionBranch`); there is no
 *     persisted session to read.
 *   - `audit.readSessionBranch === undefined` — programmatic embedder / no
 *     provider; the host never injected the reader.
 *
 * WARNS + continues (`ctx.ui.notify(..., "warning")`) when
 * `locateSessionFile` returns null, the reader returns
 * undefined/an empty branch, or any step throws — the original failure, already
 * persisted by `recordFailureRow`, is never masked.
 *
 * Synchronous by design: the caller (`recordFatalFailure` /
 * `recordUnitHalt`) has already persisted the failure row; the artifact is a
 * best-effort sidecar, not a reconstruction input, so it never blocks the run's
 * terminal bookkeeping.
 */
export function writeDeathSceneArtifact(ctx: WorkflowHostContext, audit: AuditContext, errMsg: string): void {
	// Sessionless failures carry no persisted session — nothing to read, no artifact.
	if (audit.session === null) return;
	// No host-injected reader ⇒ degrade silently (programmatic embedder / no provider).
	const readSessionBranch = audit.readSessionBranch;
	if (readSessionBranch === undefined) return;

	try {
		const sessionFile = locateSessionFile(audit.session, audit.runId, audit.cwd);
		if (!sessionFile) {
			ctx.ui.notify(
				`[rpiv-workflow] death-scene artifact skipped: session file not located for stage "${audit.stageName}"`,
				"warning",
			);
			return;
		}
		const branch = readSessionBranch(sessionFile);
		if (!branch || branch.length === 0) {
			ctx.ui.notify(
				`[rpiv-workflow] death-scene artifact skipped: empty transcript for stage "${audit.stageName}"`,
				"warning",
			);
			return;
		}
		const scene = extractDeathScene(audit, errMsg, branch, sessionFile);
		const artifactPath = deathSceneFilePath(audit.cwd, audit);
		mkdirSync(dirname(artifactPath), { recursive: true });
		writeFileSync(artifactPath, formatDeathScene(scene), "utf8");
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(`[rpiv-workflow] death-scene artifact failed: ${reason}`, "warning");
	}
}
