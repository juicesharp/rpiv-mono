import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditContext } from "./audit-ctx.js";
import {
	DEATH_SCENE_MAX_TOOL_CALLS,
	DEATH_SCENE_TOOL_ARG_MAX_CHARS,
	type DeathScene,
	deathSceneFilePath,
	extractDeathScene,
	formatDeathScene,
	writeDeathSceneArtifact,
} from "./death-scene.js";
import { LifecycleDispatcher } from "./events.js";
import type { BranchEntry } from "./transcript.js";
import type { RunState, WorkflowHostContext } from "./types.js";

/** A minimal assistant turn + two tool uses, the shape `readSessionBranch` returns. */
const branchWithToolCalls = (): BranchEntry[] => [
	{
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "build it" }] },
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "tool_use", name: "bash", input: { command: "npm test" } },
				{ type: "text", text: "Running tests." },
			],
		},
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: "edit",
					input: { path: "src/a.ts", content: "x".repeat(DEATH_SCENE_TOOL_ARG_MAX_CHARS + 50) },
				},
				{ type: "text", text: "Final words before the halt." },
			],
		},
	},
];

describe("death-scene pure helpers", () => {
	const freshState = (): RunState => ({
		originalInput: "x",
		primaryArtifact: undefined,
		output: undefined,
		named: {},
		stagesCompleted: 0,
		lastAllocatedStageNumber: 7,
		telemetry: { backwardJumps: 0, droppedRoutingRows: [], droppedFailureRows: [] },
		failureMemos: [],
		termination: { status: "running" },
	});

	const auditFor = (overrides: Partial<AuditContext> = {}): AuditContext => ({
		session: { id: "sess-1" },
		cwd: "/repo",
		runId: "run-1",
		state: freshState(),
		stageName: "build",
		skill: "build",
		lifecycle: new LifecycleDispatcher(undefined),
		runIdentity: { workflow: "wf", totalStages: 2, trigger: { kind: "programmatic" } },
		allocatedStageNumber: 7,
		...overrides,
	});

	it("deathSceneFilePath uses runId_stageNumber_unitId when a unit id is present", () => {
		const path = deathSceneFilePath(
			"/repo",
			auditFor({ unit: { parent: "fanout", role: "produce", index: 2, id: "unit-b", label: "Unit B" } }),
		);
		expect(path).toBe(join("/repo", ".rpiv", "artifacts", "failures", "run-1_7_unit-b.md"));
	});

	it("deathSceneFilePath falls back to the sanitized stage name when no unit id", () => {
		const path = deathSceneFilePath("/repo", auditFor({ stageName: "build/app" }));
		// "/" is sanitized to "_" so the segment cannot escape failures/.
		expect(path).toBe(join("/repo", ".rpiv", "artifacts", "failures", "run-1_7_build_app.md"));
	});

	it("deathSceneFilePath appends _u<index> when a unit is present but has no id (assess-loop case)", () => {
		// Assess units are identified by (role, round) with no stable id; the decorated stageName
		// already carries the round tag, but filename uniqueness must not depend on that decoration.
		const path = deathSceneFilePath(
			"/repo",
			auditFor({
				stageName: "assess (r1·produce)",
				unit: { parent: "assess", role: "produce", index: 1, label: "r1·produce" },
			}),
		);
		// Sanitized decorated stage name + `_u1` suffix (the round index).
		expect(path).toBe(join("/repo", ".rpiv", "artifacts", "failures", "run-1_7_assess_(r1·produce)_u1.md"));
	});

	it("extractDeathScene carries runId/stage/errMsg/sessionFile, the last-N tool calls, and the final assistant text", () => {
		const scene = extractDeathScene(auditFor(), "boom", branchWithToolCalls(), "/repo/sess-1.jsonl");
		expect(scene.runId).toBe("run-1");
		expect(scene.stage).toBe("build");
		expect(scene.stageNumber).toBe(7);
		expect(scene.errMsg).toBe("boom");
		expect(scene.sessionFile).toBe("/repo/sess-1.jsonl");
		expect(scene.finalText).toBe("Final words before the halt.");
		// Both tool uses survived (fewer than the cap) — in branch order.
		expect(scene.toolCalls.map((c) => c.name)).toEqual(["bash", "edit"]);
	});

	it("extractDeathScene truncates tool args to the cap with a trailing ellipsis", () => {
		const scene = extractDeathScene(auditFor(), "boom", branchWithToolCalls(), "/repo/sess-1.jsonl");
		const editArgs = scene.toolCalls.find((c) => c.name === "edit")!.args;
		expect(editArgs.length).toBe(DEATH_SCENE_TOOL_ARG_MAX_CHARS + 1); // cap + "…"
		expect(editArgs.endsWith("…")).toBe(true);
	});

	it("extractDeathScene keeps only the last DEATH_SCENE_MAX_TOOL_CALLS tool calls", () => {
		const many: BranchEntry[] = [];
		for (let i = 0; i < DEATH_SCENE_MAX_TOOL_CALLS + 3; i++) {
			many.push({
				type: "message",
				message: { role: "assistant", content: [{ type: "tool_use", name: `t${i}`, input: {} }] },
			});
		}
		const scene = extractDeathScene(auditFor(), "boom", many, "/repo/s.jsonl");
		expect(scene.toolCalls).toHaveLength(DEATH_SCENE_MAX_TOOL_CALLS);
		// The TAIL is kept (most recent), so the first retained name is t3.
		expect(scene.toolCalls.map((c) => c.name)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
	});

	it("extractDeathScene omits finalText when there is no assistant text", () => {
		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "bash", input: {} }] } },
		];
		const scene = extractDeathScene(auditFor(), "boom", branch, "/repo/s.jsonl");
		expect(scene.finalText).toBeUndefined();
	});

	it("formatDeathScene renders the runId, stage+number, errMsg, session path, final text, and tool calls", () => {
		const scene: DeathScene = {
			runId: "run-1",
			stage: "build",
			stageNumber: 7,
			errMsg: "extraction failed",
			finalText: "I tried.",
			toolCalls: [{ name: "bash", args: '{"command":"npm test"}' }],
			sessionFile: "/repo/sess-1.jsonl",
		};
		const md = formatDeathScene(scene);
		expect(md).toContain("# Death scene: build");
		expect(md).toContain("**Run:** `run-1`");
		expect(md).toContain("**Stage:** `build` (#7)");
		expect(md).toContain("**Error:** extraction failed");
		expect(md).toContain("**Session file:** `/repo/sess-1.jsonl`");
		expect(md).toContain("## Final assistant text");
		expect(md).toContain("I tried.");
		expect(md).toContain("## Last 1 tool call");
		expect(md).toContain("`bash`");
		expect(md).toContain('{"command":"npm test"}');
	});

	it("formatDeathScene renders the unit line only when unitId is present", () => {
		const base: DeathScene = {
			runId: "r",
			stage: "s",
			stageNumber: 1,
			errMsg: "e",
			toolCalls: [],
			sessionFile: "/f",
		};
		expect(formatDeathScene(base)).not.toContain("**Unit:**");
		expect(formatDeathScene({ ...base, unitId: "unit-a" })).toContain("**Unit:** `unit-a`");
	});
});

describe("writeDeathSceneArtifact", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-death-scene-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const freshState = (): RunState => ({
		originalInput: "x",
		primaryArtifact: undefined,
		output: undefined,
		named: {},
		stagesCompleted: 0,
		lastAllocatedStageNumber: 3,
		telemetry: { backwardJumps: 0, droppedRoutingRows: [], droppedFailureRows: [] },
		failureMemos: [],
		termination: { status: "running" },
	});

	const makeCtx = () => {
		const notifications: Array<{ msg: string; level: string }> = [];
		const ctx = {
			cwd: tmpDir,
			ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) },
		} as unknown as WorkflowHostContext;
		return { ctx, notifications };
	};

	const auditFor = (overrides: Partial<AuditContext> = {}): AuditContext => ({
		session: { id: "sess-1" },
		cwd: tmpDir,
		runId: "run-1",
		state: freshState(),
		stageName: "build",
		skill: "build",
		lifecycle: new LifecycleDispatcher(undefined),
		runIdentity: { workflow: "wf", totalStages: 2, trigger: { kind: "programmatic" } },
		allocatedStageNumber: 3,
		...overrides,
	});

	const failuresDir = (): string => join(tmpDir, ".rpiv", "artifacts", "failures");

	it("(a) writes the artifact with the full body on an in-session terminal failure", () => {
		// Plant the session JSONL so locateSessionFile resolves it by id.
		const sessionFile = join(tmpDir, "2026-01-01T00-00-00-000Z_sess-1.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "sess-1" })}\n`, "utf8");
		// audit.session carries the id; locateSessionFile finds the file by id glob.
		const audit = auditFor({ session: { id: "sess-1", file: sessionFile } });
		const reader = vi.fn(() => branchWithToolCalls());

		writeDeathSceneArtifact(makeCtx().ctx, { ...audit, readSessionBranch: reader }, "terminal boom");

		const artifactPath = deathSceneFilePath(tmpDir, audit);
		expect(existsSync(artifactPath)).toBe(true);
		const md = readFileSync(artifactPath, "utf8");
		expect(md).toContain("**Run:** `run-1`");
		expect(md).toContain("**Stage:** `build` (#3)");
		expect(md).toContain("**Error:** terminal boom");
		expect(md).toContain("**Session file:**");
		expect(md).toContain("Final words before the halt.");
		expect(md).toContain("`bash`");
		expect(reader).toHaveBeenCalledWith(sessionFile);
	});

	it("(b) skips (no artifact, no warning) when audit.session === null", () => {
		const { ctx, notifications } = makeCtx();
		const reader = vi.fn(() => branchWithToolCalls());
		writeDeathSceneArtifact(ctx, auditFor({ session: null, readSessionBranch: reader }), "boom");
		expect(reader).not.toHaveBeenCalled();
		expect(notifications).toEqual([]);
		expect(existsSync(failuresDir())).toBe(false);
	});

	it("(c) skips (no throw, no artifact, no warning) when audit.readSessionBranch === undefined", () => {
		const { ctx, notifications } = makeCtx();
		writeDeathSceneArtifact(ctx, auditFor(), "boom");
		expect(notifications).toEqual([]);
		expect(existsSync(failuresDir())).toBe(false);
	});

	it("(d) warns + continues when locateSessionFile returns null (session file missing)", () => {
		const { ctx, notifications } = makeCtx();
		const reader = vi.fn(() => branchWithToolCalls());
		// A session id with no matching file on disk ⇒ locateSessionFile returns null.
		writeDeathSceneArtifact(ctx, auditFor({ session: { id: "no-such-session" }, readSessionBranch: reader }), "boom");
		expect(reader).not.toHaveBeenCalled();
		expect(notifications.some((n) => n.level === "warning" && n.msg.includes("session file not located"))).toBe(true);
		expect(existsSync(failuresDir())).toBe(false);
	});

	it("(e) warns + continues when the reader throws", () => {
		const sessionFile = join(tmpDir, "2026-01-01T00-00-00-000Z_sess-1.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "sess-1" })}\n`, "utf8");
		const { ctx, notifications } = makeCtx();
		const reader = vi.fn(() => {
			throw new Error("disk read failed");
		});
		writeDeathSceneArtifact(
			ctx,
			auditFor({ session: { id: "sess-1", file: sessionFile }, readSessionBranch: reader }),
			"boom",
		);
		expect(reader).toHaveBeenCalled();
		expect(notifications.some((n) => n.level === "warning" && n.msg.includes("death-scene artifact failed"))).toBe(
			true,
		);
		expect(existsSync(failuresDir())).toBe(false);
	});

	it("(f) no-regression — a clean run (writer never called) creates no failures directory", () => {
		// The writer is ONLY invoked from recordTerminalFailure / recordUnitHalt.
		// A success path never reaches it; the skip arms above already prove no
		// dir is created. This asserts the dir is genuinely absent from a fresh
		// tmp cwd before any failure — the byte-identical-to-today baseline.
		expect(existsSync(failuresDir())).toBe(false);
	});
});
