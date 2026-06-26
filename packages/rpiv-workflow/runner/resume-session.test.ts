/**
 * Session-backed resume — end-to-end through `resumeWorkflow`:
 *
 *   - structured dispatch: failed trailer with `session` → promotion path
 *     (spawnChild with `reattach`); `session: null` → cold re-run
 *     (spawnChild without `reattach`);
 *   - PROMOTION: the adopted branch already announces the artifact →
 *     completed row, chain advances, nothing sent into the session
 *     (issue #70's scenario);
 *   - fallback ladder: no reattach / missing session file → notify +
 *     cold re-run;
 *   - reattach cancellation → sessionless skipped row (mirrors the
 *     live pre-open cancellation);
 *   - REATTACH: promotion miss → REATTACH_PROMPT + waitForIdle + the
 *     standard postStage (success persists; a second failure writes a
 *     session-backed failure row, keeping the run resumable);
 *   - continue-policy stages scope promotion extraction with the PERSISTED
 *     `branchOffset`.
 *
 * The host ctx is hand-rolled (not `createMockSessionChain`) because these
 * tests need a `spawnChild` that branches on the `reattach` option, which the
 * chain fixture doesn't model.
 *
 * NOTE: these exercise the resume ladder rewritten over `reattachChildSession`
 * (the detached replacement for `switchSession`); they run green once that
 * production rewrite lands.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "../api.js";
import { registerWorkflowExecutionHost } from "../execution-host.js";
import { fs as fsHandle } from "../handle.js";
import type { WorkflowSessionContext } from "../host.js";
import {
	MSG_RESUME_PROMOTED,
	MSG_RESUME_REATTACHED,
	MSG_RESUME_SESSION_FALLBACK,
	REATTACH_PROMPT,
} from "../messages.js";
import type { CollectCtx, Outcome } from "../output-spec.js";
import {
	appendStage,
	readAllStages,
	type SessionRef,
	STATE_SCHEMA_VERSION,
	type WorkflowHeader,
	type WorkflowStage,
	writeHeader,
} from "../state/index.js";
import { lastMatchInBranch } from "../transcript.js";
import { typeboxSchema } from "../typebox-adapter.js";
import type { WorkflowHostContext } from "../types.js";
import { resumeWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-resume-session-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const header: WorkflowHeader = {
	runId: "2026-06-11_09-00-00-ab12",
	workflow: "wf",
	input: "ship it",
	ts: "2026-06-11T09:00:00Z",
	v: STATE_SCHEMA_VERSION,
};

/** Collector that adopts whatever artifact path the branch announced. */
const announceOutcome = (collectSpy?: (ctx: CollectCtx) => void): Outcome => ({
	collector: {
		collect: (ctx: CollectCtx) => {
			collectSpy?.(ctx);
			const m = lastMatchInBranch(ctx.branch, /\.rpiv\/artifacts\/\S+\.md/g, ctx.branchOffset);
			return m
				? { kind: "ok" as const, artifacts: [{ handle: fsHandle(m), role: "primary" as const }] }
				: { kind: "ok" as const, artifacts: [] }; // produces ⇒ contract-fatal ⇒ promotion miss
		},
	},
});

const singleStageWorkflow = (outcome: Outcome, sessionPolicy: "fresh" | "continue" = "fresh"): Workflow =>
	({
		name: "wf",
		start: "build",
		stages: { build: { kind: "produces", sessionPolicy, outcome } },
		edges: { build: "stop" },
	}) as Workflow;

/** Write a Pi-shaped session file whose header carries `id`. */
const writeSessionFile = (id: string): string => {
	const dir = join(tmpDir, "pi-sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-06-11_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd: tmpDir })}\n`);
	return file;
};

const failedRow = (session: SessionRef | null): WorkflowStage => ({
	stageNumber: 1,
	stage: "build",
	skill: "build",
	status: "failed",
	ts: "t1",
	errMsg: "interrupted",
	session,
});

const writeRun = (rows: WorkflowStage[]): void => {
	writeHeader(tmpDir, header);
	for (const r of rows) appendStage(tmpDir, header.runId, r);
};

interface Harness {
	ctx: WorkflowHostContext;
	notifications: Array<{ msg: string; level: string }>;
	/** Messages sent INTO the adopted session (reattach prompt, retry fixes). */
	sentIntoSession: string[];
	/** Marker for the reattach path (spawnChild WITH `reattach`) — old switchSession. */
	switchSessionSpy: ReturnType<typeof vi.fn>;
	/** Marker for the cold-re-run path (spawnChild WITHOUT `reattach`) — old newSession. */
	newSessionSpy: ReturnType<typeof vi.fn>;
}

/**
 * Hand-rolled host ctx. `switchBranch` is the adopted session's LIVE branch
 * array (mutated by `onSessionSend` to simulate the agent answering);
 * `omitSwitchSession` exercises the "host cannot reattach" rung. The cold
 * re-run path (spawnChild without `reattach`) delivers a fresh session whose
 * branch announces `coldAnnounce` so the fallback completes the stage.
 */
function makeHarness(opts: {
	switchBranch?: unknown[];
	omitSwitchSession?: boolean;
	switchCancelled?: boolean;
	onSessionSend?: (msg: string, branch: unknown[]) => void;
	coldAnnounce?: string;
}): Harness {
	const notifications: Array<{ msg: string; level: string }> = [];
	const sentIntoSession: string[] = [];
	const ui = {
		notify: (msg: string, level?: string) => notifications.push({ msg, level: level ?? "info" }),
	};

	const sessionCtxFor = (branch: unknown[], id: string, file: string | undefined): WorkflowSessionContext =>
		({
			cwd: tmpDir,
			hasUI: false,
			ui,
			sessionManager: {
				getBranch: () => branch,
				getSessionId: () => id,
				getSessionFile: () => file,
			},
			waitForIdle: async () => {},
			maxConcurrency: 1,
			spawnChild: spawnChildSpy,
			sendUserMessage: async (msg: string) => {
				sentIntoSession.push(msg);
				opts.onSessionSend?.(msg, branch);
			},
		}) as unknown as WorkflowSessionContext;

	// Cold-re-run marker (spawnChild WITHOUT reattach).
	const newSessionSpy = vi.fn();
	// Reattach marker (spawnChild WITH reattach) — receives (sessionFile, options).
	const switchSessionSpy = vi.fn();

	const spawnChildSpy = vi.fn(
		async (options: {
			prompt?: string;
			lane?: string;
			reattach?: { sessionFile: string };
			withSession: (c: WorkflowSessionContext) => Promise<void>;
		}) => {
			// Reattach (promotion / resume of a persisted session). `omitSwitchSession`
			// models a host that declines reattach → falls through to a cold child.
			if (options.reattach && !opts.omitSwitchSession) {
				switchSessionSpy(options.reattach.sessionFile, options);
				// A scripted cancellation REJECTS — the dispatcher treats it as an
				// unfilled slot (the detached replacement for the old `{cancelled}`).
				if (opts.switchCancelled) throw new Error("reattach cancelled");
				await options.withSession(sessionCtxFor(opts.switchBranch ?? [], "sess-1", options.reattach.sessionFile));
				return;
			}
			// Cold re-run — fresh child whose branch announces `coldAnnounce`.
			newSessionSpy(options);
			const branch = [mockAssistantMessage(opts.coldAnnounce ?? "no artifact here")];
			await options.withSession(sessionCtxFor(branch, "cold-session", undefined));
		},
	);

	const ctx = {
		cwd: tmpDir,
		hasUI: false,
		ui,
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "outer-session",
			getSessionFile: () => undefined,
		},
		waitForIdle: async () => {},
		maxConcurrency: 1,
		spawnChild: spawnChildSpy,
	} as unknown as WorkflowHostContext;

	return { ctx, notifications, sentIntoSession, switchSessionSpy, newSessionSpy };
}

const resume = (ctx: WorkflowHostContext, workflow: Workflow) => resumeWorkflow(ctx, { workflow, header, ref: "@1" });

/** Minimal WorkflowHost for the continue-policy arm (registers the dispatched skill). */
const fakeHost = () => ({
	registerCommand: () => {},
	sendUserMessage: async () => {},
	getCommands: () => [{ name: "skill:build", source: "skill" }],
});

// ---------------------------------------------------------------------------
// Promotion (issue #70)
// ---------------------------------------------------------------------------

describe("session-backed resume — promotion", () => {
	it("adopts the interrupted session's announced artifact: completed row, nothing sent, chain advances", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("done — wrote .rpiv/artifacts/impl/build.md")],
		});

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.switchSessionSpy).toHaveBeenCalledWith(file, expect.anything());
		expect(h.newSessionSpy).not.toHaveBeenCalled();
		// Promotion sends NOTHING — the old branch already carried the work.
		expect(h.sentIntoSession).toEqual([]);
		expect(h.notifications.some((n) => n.msg === MSG_RESUME_PROMOTED("build"))).toBe(true);

		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "completed"]);
		// The promoted row is session-backed by the ADOPTED session.
		expect(rows[1]?.session).toEqual({ id: "sess-1", file });
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/build.md");
	});

	it("promotion validation-exhausted halts exactly as live — session-backed failure row", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("done — wrote .rpiv/artifacts/impl/build.md")],
		});
		// The adopted artifact exists but its data fails the output schema;
		// onInvalid: "halt" skips retries → validation-exhausted.
		const workflow = {
			name: "wf",
			start: "build",
			stages: {
				build: {
					kind: "produces",
					sessionPolicy: "fresh",
					outcome: announceOutcome(),
					outputSchema: typeboxSchema(Type.Object({ impossible: Type.Literal(1) })),
					onInvalid: "halt",
				},
			},
			edges: { build: "stop" },
		} as unknown as Workflow;

		const result = await resume(h.ctx, workflow);

		expect(result.success).toBe(false);
		expect(result.error).toContain("output validation failed after retries");
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
		expect(rows[1]?.session).toEqual({ id: "sess-1", file });
	});

	it("dispatches on the structured session field: a sessionless failed trailer re-runs cold", async () => {
		writeRun([failedRow(null)]);
		const h = makeHarness({ coldAnnounce: "wrote .rpiv/artifacts/impl/cold.md" });

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.switchSessionSpy).not.toHaveBeenCalled();
		expect(h.newSessionSpy).toHaveBeenCalledTimes(1);
		// Silent arm — no fallback notice for rows that never had a session.
		expect(h.notifications.some((n) => n.msg.includes("re-running the stage"))).toBe(false);
	});

	it("continue-policy stage scopes promotion extraction with the PERSISTED branchOffset", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file, branchOffset: 1 })]);
		const collectSpy = vi.fn();
		const h = makeHarness({
			switchBranch: [
				mockAssistantMessage("PRIOR STAGE noise .rpiv/artifacts/wrong/prior.md"),
				mockAssistantMessage("done — wrote .rpiv/artifacts/impl/cont.md"),
			],
		});

		const result = await resumeWorkflow(h.ctx, {
			workflow: singleStageWorkflow(announceOutcome(collectSpy), "continue"),
			header,
			host: fakeHost(),
			ref: "@1",
		});

		expect(result.success).toBe(true);
		// The collector saw the persisted offset — not a freshly-derived one.
		expect(collectSpy.mock.calls[0]?.[0]?.branchOffset).toBe(1);
		// And the offset kept the prior stage's announcement out of the result.
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/cont.md");
	});
});

// ---------------------------------------------------------------------------
// Fallback ladder
// ---------------------------------------------------------------------------

describe("session-backed resume — fallback ladder", () => {
	it("session file gone (deleted / different machine) → notify + cold re-run", async () => {
		writeRun([failedRow({ id: "sess-1", file: join(tmpDir, "gone", "x_sess-1.jsonl") })]);
		const h = makeHarness({ coldAnnounce: "wrote .rpiv/artifacts/impl/cold.md" });

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.switchSessionSpy).not.toHaveBeenCalled();
		expect(h.newSessionSpy).toHaveBeenCalledTimes(1);
		expect(
			h.notifications.some((n) => n.msg === MSG_RESUME_SESSION_FALLBACK("build", "session file not found")),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Reattach (promotion miss → continue the session from its leaf)
// ---------------------------------------------------------------------------

describe("session-backed resume — reattach", () => {
	it("promotion miss → REATTACH_PROMPT into the session; agent finishes; normal success path", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("was mid-work, no artifact yet")],
			onSessionSend: (msg, branch) => {
				// The nudged agent finishes and announces.
				if (msg === REATTACH_PROMPT("build")) {
					branch.push(mockAssistantMessage("finished — wrote .rpiv/artifacts/impl/late.md"));
				}
			},
		});

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(true);
		expect(h.sentIntoSession).toEqual([REATTACH_PROMPT("build")]);
		expect(h.notifications.some((n) => n.msg === MSG_RESUME_REATTACHED("build"))).toBe(true);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "completed"]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/late.md");
	});

	it("reattach second failure → session-backed failure row (the run stays resumable)", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);
		// Agent never announces — promotion misses AND the reattached turn
		// still produces nothing (produces-contract fatal).
		const h = makeHarness({
			switchBranch: [mockAssistantMessage("was mid-work, no artifact yet")],
			onSessionSend: (_msg, branch) => {
				branch.push(mockAssistantMessage("sorry, still nothing"));
			},
		});

		const result = await resume(h.ctx, singleStageWorkflow(announceOutcome()));

		expect(result.success).toBe(false);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
		// The new failure row carries the adopted session — resumable again.
		expect(rows[1]?.session).toEqual({ id: "sess-1", file });
	});
});

// ---------------------------------------------------------------------------
// Resume-detach parity (L4-01) — resume must build the executor host via the
// provider exactly like a live run, instead of executing on the bare launcher
// ctx (which has no real `spawnChild`). The other suites in this file register
// NO provider, so `detachExecutor` degrades to the passed ctx and their
// hand-injected `spawnChild` IS the executor — they prove the contract. These
// prove the production WIRING: with a provider registered, resume runs on the
// provider's host, and the launcher is only the observer createHost is built from.
// ---------------------------------------------------------------------------

describe("session-backed resume — detaches to the provider's executor host", () => {
	/** A launcher whose `spawnChild` THROWS — any reliance on it (the pre-L4-01
	 *  behavior) surfaces as a thrown error instead of silently passing. */
	const throwingLauncher = (): WorkflowHostContext =>
		({
			cwd: tmpDir,
			hasUI: false,
			ui: { notify: () => {} },
			sessionManager: {
				getBranch: () => [],
				getSessionId: () => "outer-session",
				getSessionFile: () => undefined,
			},
			waitForIdle: async () => {},
			maxConcurrency: 1,
			spawnChild: () => {
				throw new Error("LAUNCHER spawnChild must not run on resume — resume must detach to the executor host");
			},
		}) as unknown as WorkflowHostContext;

	it("reattaches the resumed stage on the provider host, never the launcher ctx", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);

		// The provider's executor host is the recording harness ctx; the launcher we
		// pass to resumeWorkflow throws if its spawnChild is ever touched.
		const h = makeHarness({ switchBranch: [mockAssistantMessage("wrote .rpiv/artifacts/x/a.md")] });
		let createHostCalls = 0;
		let observerSeen: unknown;
		registerWorkflowExecutionHost({
			createHost: (observer) => {
				createHostCalls++;
				observerSeen = observer;
				return { host: h.ctx };
			},
		});

		const launcher = throwingLauncher();
		const result = await resumeWorkflow(launcher, {
			workflow: singleStageWorkflow(announceOutcome()),
			header,
			ref: "@1",
		});

		// The provider built the executor from the launcher OBSERVER...
		expect(createHostCalls).toBe(1);
		expect(observerSeen).toBe(launcher);
		// ...and the resumed stage reattached on the PROVIDER host (the launcher's
		// throwing spawnChild was never reached — promotion adopted the artifact).
		expect(h.switchSessionSpy).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("threads the provider's resolveModel onto resumed stages", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);

		const h = makeHarness({ switchBranch: [mockAssistantMessage("wrote .rpiv/artifacts/x/a.md")] });
		const resolveModel = vi.fn(() => ({ model: "anthropic/claude-opus-4-8" }));
		registerWorkflowExecutionHost({
			createHost: () => ({ host: h.ctx }),
			resolveModel,
		});

		const result = await resumeWorkflow(throwingLauncher(), {
			workflow: singleStageWorkflow(announceOutcome()),
			header,
			ref: "@1",
		});

		// The resumed stage resolved its per-child model through the provider — proving
		// resolveModel is threaded onto resumed stages, not just live ones.
		expect(result.success).toBe(true);
		expect(resolveModel).toHaveBeenCalledWith({ stage: "build", skill: "build" });
	});

	it("threads the lane name to createHost — header.workflow when the run carried no --name alias", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);

		const h = makeHarness({ switchBranch: [mockAssistantMessage("wrote .rpiv/artifacts/x/a.md")] });
		let seen: { name?: string; workflow?: string; input?: string } | undefined;
		registerWorkflowExecutionHost({
			createHost: (_observer, opts) => {
				seen = { name: opts.name, workflow: opts.workflow, input: opts.input };
				return { host: h.ctx };
			},
		});

		const result = await resumeWorkflow(throwingLauncher(), {
			workflow: singleStageWorkflow(announceOutcome()),
			header, // no `name` field — falls back to header.workflow ("wf")
			ref: "@1",
		});

		expect(result.success).toBe(true);
		expect(seen?.name).toBe("wf");
		expect(seen?.workflow).toBe("wf");
		expect(seen?.input).toBe("ship it");
	});

	it("prefers header.name (the --name alias) over the workflow for the lane name", async () => {
		const file = writeSessionFile("sess-1");
		writeRun([failedRow({ id: "sess-1", file })]);

		const h = makeHarness({ switchBranch: [mockAssistantMessage("wrote .rpiv/artifacts/x/a.md")] });
		let seen: { name?: string; workflow?: string; input?: string } | undefined;
		registerWorkflowExecutionHost({
			createHost: (_observer, opts) => {
				seen = { name: opts.name, workflow: opts.workflow, input: opts.input };
				return { host: h.ctx };
			},
		});

		const result = await resumeWorkflow(throwingLauncher(), {
			workflow: singleStageWorkflow(announceOutcome()),
			header: { ...header, name: "nightly-ship" },
			ref: "@1",
		});

		expect(result.success).toBe(true);
		expect(seen?.name).toBe("nightly-ship");
		expect(seen?.workflow).toBe("wf");
		expect(seen?.input).toBe("ship it");
	});
});
