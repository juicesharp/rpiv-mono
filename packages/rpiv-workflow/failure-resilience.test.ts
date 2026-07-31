/**
 * FRD §6 integration test — the incident replay.
 *
 * One end-to-end scenario chaining the full recover → remember → preserve →
 * gate ladder against a mock workflow whose collect-all fan-out has a unit
 * whose verification command times out deterministically. Asserts the FRD §6
 * sequence in ONE test and concludes with the cost-bound the FRD names:
 * total watchdog-attributable cost ≤ strikes × ceiling, NOT stages × ceiling.
 *
 * Depends on the behavioral phases being applied first: the
 * `createMockSessionChain` `onSend`/mutable-`toolTimeout` surface +
 * `ERR_VALIDATE_RETRY_UNCHANGED` message const; the `readSessionBranch`
 * execution provider; the `worktreeDigest` run option. See the plan's
 * ## Notes / Deferred for the resolved-default assumptions.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow, type FanoutFn, produces } from "./api.js";
import { registerWorkflowExecutionHost } from "./execution-host.js";
import { fs as fsHandle } from "./handle.js";
import { fanout } from "./loop-constructors.js";
import { ERR_VALIDATE_RETRY_UNCHANGED } from "./messages.js";
import { runWorkflow } from "./runner/index.js";
import type { BranchEntry } from "./transcript.js";
import { typeboxSchema } from "./typebox-adapter.js";

// The steering prose the strike recovery re-prompts with (module-owned in
// bash-strikes.ts). Asserted to count strikes without coupling to the
// exact wording — pin stable substrings the guidance mandates on every arm.
// The markers match the verbatim module constants (MSG_HUNG_NOT_SLOW /
// MSG_DO_NOT_RERUN_VERBATIM): "HUNG" + "Do NOT rerun" (case-sensitive).
const STEERING_HUNG_MARKER = "HUNG";
const STEERING_NO_RERUN_MARKER = "Do NOT rerun";

// A failure memo's rendered "Prior failures" block prefix (failure-memos.ts).
// Pinned as a substring so the next-sibling-unit prompt assertion is
// robust to exact wording.
const PRIOR_FAILURES_MARKER = "Prior failures";

/** Two sibling fan-out units; serialized so B's session is built after A's memo. */
const incidentUnits: FanoutFn = () => [
	{ prompt: "run the hanging-test suite", label: "hanging-test", id: "hanging-test" },
	{ prompt: "run the stable-test suite", label: "stable-test", id: "stable-test" },
];

/**
 * Build the incident workflow: collect-all fanout → validate → stop.
 *
 * `implement` is a `produces` stage whose fan-out defaults to collect-all, so a
 * failed unit soft-halts (the run survives to reach the next sibling + validate).
 * Its outcome carries a `name` (required for a produces+fanout stage to validate)
 * and a transcript-scan collector that surfaces the `.rpiv/artifacts/…` path a
 * unit emits; the parser is a no-op (no `outputSchema` ⇒ no validation on this
 * stage, so a stable unit completes on collection alone).
 */
const incidentWorkflow = () =>
	defineWorkflow({
		name: "incident-replay",
		start: "implement",
		stages: {
			implement: produces({
				outcome: {
					name: "impl-out",
					collector: {
						collect: (ctx) => {
							// Scan the branch for an artifact path the unit emitted.
							const start = Math.max(ctx.branchOffset ?? 0, 0);
							for (let i = ctx.branch.length - 1; i >= start; i--) {
								const entry = ctx.branch[i] as
									| { type?: string; message?: { role?: string; content?: unknown[] } }
									| undefined;
								if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
								const content = entry.message?.content;
								if (!Array.isArray(content)) continue;
								for (const part of content) {
									const text = (part as { type?: string; text?: string } | undefined)?.text;
									if (typeof text === "string" && text.includes(".rpiv/artifacts/")) {
										return {
											kind: "ok" as const,
											artifacts: [{ handle: fsHandle(text), role: "primary" as const }],
										};
									}
								}
							}
							return { kind: "fatal" as const, message: `${ctx.skill} produced no artifact path` };
						},
					},
					parser: { parse: () => ({ kind: "ok", payload: { kind: "impl-out", data: {} } }) },
				},
				loop: fanout({ units: incidentUnits, concurrency: 1, result: "last" }),
			}),
			// schema-validated produces stage: invalid payload ⇒ retry ⇒ validation-retry gate.
			validate: produces({
				sessionPolicy: "fresh",
				outputSchema: typeboxSchema(Type.Object({ foo: Type.Literal(2) }, { additionalProperties: true })),
				maxRetries: 1,
				// Always-invalid outcome — the gate must be reachable on the first retry.
				outcome: {
					collector: {
						collect: (ctx) => {
							// The validate branch carries an assistant message naming an artifact
							// path; surface it as the primary so the parser runs.
							const start = Math.max(ctx.branchOffset ?? 0, 0);
							for (let i = ctx.branch.length - 1; i >= start; i--) {
								const entry = ctx.branch[i] as
									| { type?: string; message?: { role?: string; content?: unknown[] } }
									| undefined;
								if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
								const content = entry.message?.content;
								if (!Array.isArray(content)) continue;
								for (const part of content) {
									const text = (part as { type?: string; text?: string } | undefined)?.text;
									if (typeof text === "string" && text.includes(".rpiv/artifacts/")) {
										return {
											kind: "ok" as const,
											artifacts: [{ handle: fsHandle(text), role: "primary" as const }],
										};
									}
								}
							}
							return {
								kind: "ok" as const,
								artifacts: [{ handle: fsHandle(".rpiv/artifacts/validate/out.md"), role: "primary" as const }],
							};
						},
					},
					// Always invalid — the gate must be reachable on the first retry.
					parser: { parse: () => ({ kind: "ok", payload: { kind: "validate-out", data: { foo: 1 } } }) },
				},
			}),
		},
		edges: { implement: "validate", validate: "stop" },
	});

/** The branch the death-scene reader returns for unit A's failed session. */
const failedSessionBranch = (): BranchEntry[] =>
	[
		mockAssistantMessage("Running hanging-test…", "toolUse"),
		mockAssistantMessage("bash: command timed out", "aborted"),
	] as BranchEntry[];

/** Read every JSONL row the audit layer wrote under cwd. */
const readStageRows = (cwd: string): Array<Record<string, unknown>> => {
	const dir = join(cwd, ".rpiv", "workflows", "runs");
	const files = readdirSync(dir);
	const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
	// line 0 is the header; the rest are stage rows.
	return lines.slice(1).map((l) => JSON.parse(l));
};

describe("failure-resilience — FRD §6 incident replay", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-failure-resilience-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("chains recover → remember → preserve → gate and bounds watchdog cost to strikes × ceiling", async () => {
		// --- Host injection: readSessionBranch via the execution provider ---
		// Parallel to resolveModel (sourced `options.readSessionBranch ??
		// provider.readSessionBranch` in detachExecutor); the death-scene writer
		// reads it from AuditContext at failure time. The provider is auto-reset in
		// test/setup.ts beforeEach (__resetWorkflowExecutionHost).
		const readSessionBranch = vi.fn(() => failedSessionBranch());

		// Plant unit A's persisted session JSONL so `locateSessionFile` resolves it
		// (rung 1 → rung 3). The child advertises this path via `sessionFile`; the
		// death-scene writer only needs the file to EXIST at that path (its
		// transcript content comes from the injected `readSessionBranch` mock, not
		// the file body). Mirrors death-scene.test.ts:217-219.
		const unitASessionFile = join(tmpDir, "unit-a-session.jsonl");
		writeFileSync(unitASessionFile, `${JSON.stringify({ type: "session", id: "test-session" })}\n`, "utf8");

		// Two sibling units serialized (concurrency: 1) + one validate stage = 3
		// spawnChild calls. Unit A's child drives strike recovery IN PLACE via the
		// `onSend` mechanism (each sendUserMessage re-arms toolTimeout + appends
		// an aborted branch) — no second spawn for the strikes.
		//
		// Default strike ceiling is 2 (BASH_TIMEOUT_STRIKES module default): initial
		// timeout + 2 onSend re-arms ⇒ strikes 1, 2 recover, the 3rd postStage
		// exhausts ⇒ soft-halt. See ## Notes / Deferred for the resolved-default
		// assumption.
		const reArm = {
			reason: "bash command exceeded the 180s per-command timeout and was aborted: `hanging-test`",
		};
		const chain = createMockSessionChain({
			cwd: tmpDir,
			maxConcurrency: 1,
			steps: [
				{
					// Unit A "hanging-test": aborted stop + toolTimeout; onSend re-arms
					// the verdict on each strike's resend until exhaustion.
					branch: [mockAssistantMessage("running hanging-test", "aborted")],
					toolTimeout: reArm,
					sessionFile: unitASessionFile,
					onSend: [
						{ branch: [mockAssistantMessage("retry hanging-test", "aborted")], toolTimeout: reArm },
						{ branch: [mockAssistantMessage("retry hanging-test", "aborted")], toolTimeout: reArm },
					],
				},
				{
					// Unit B "stable-test": completes; its INITIAL prompt carries the
					// "Prior failures" memo suffix because A's memo was appended.
					branch: [mockAssistantMessage("stable-test green; wrote .rpiv/artifacts/impl/stable.md")],
				},
				{
					// validate stage: assistant names an artifact, but the outcome
					// hard-returns an invalid payload so the schema-retry opens.
					branch: [mockAssistantMessage("validated; wrote .rpiv/artifacts/validate/out.md")],
				},
			],
		});

		// Register the provider so detachExecutor builds the executor from the
		// chain ctx (the registerWorkflowExecutionHost test pattern) AND threads
		// readSessionBranch onto RunContext → SessionContext → AuditContext.
		registerWorkflowExecutionHost({
			createHost: () => ({ host: chain.ctx }),
			readSessionBranch,
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: incidentWorkflow(),
			input: "ship the fix",
			// run option: a FIXED digest so the validation-retry gate sees the
			// baseline == the post-askAgentToFix digest ⇒ abort (no observable fix).
			worktreeDigest: () => "fixed-digest",
		});

		const rows = readStageRows(tmpDir);

		// ───────────────────────── Rung 1: recover → exhaust → memo ─────────────────────────
		// Unit A soft-halted (collect-all): a NON-terminal collected:true failed
		// row landed, carrying the watchdog reason. The run did NOT terminate here.
		const unitAFailure = rows.find(
			(r) => r.status === "failed" && typeof r.collected === "boolean" && r.unitId === "hanging-test",
		);
		expect(unitAFailure, "unit A exhaustion wrote a collected:true failed row").toBeDefined();
		expect(unitAFailure!.collected).toBe(true);
		expect(String(unitAFailure!.errMsg)).toContain("per-command timeout");
		// Strike recovery fired exactly ceiling (2) times before exhaustion: the
		// steering re-prompts are the only sendUserMessages carrying the
		// hung/no-rerun guidance into unit A's child.
		const steeringMessages = chain.sentMessages.filter(
			(m) => m.includes(STEERING_HUNG_MARKER) && m.includes(STEERING_NO_RERUN_MARKER),
		);
		expect(steeringMessages.length).toBeLessThanOrEqual(2);
		expect(steeringMessages.length).toBeGreaterThanOrEqual(1);

		// ───────────────────────── Rung 2: next sibling unit names the failure ─────────────────────────
		// Unit B's INITIAL prompt (built by buildUnitSession AFTER A's memo
		// appended) carries the "Prior failures" memo block.
		const unitBPrompt = chain.sentMessages.find((m) => m.includes("/skill:implement") && m.includes("stable-test"));
		expect(unitBPrompt, "unit B was dispatched").toBeDefined();
		expect(unitBPrompt!).toContain(PRIOR_FAILURES_MARKER);

		// ───────────────────────── Rung 3: death-scene artifact exists ─────────────────────────
		// The death-scene artifact fired for free off the shared recordUnitHalt
		// writer: a sidecar .md exists under .rpiv/artifacts/failures/ carrying
		// errMsg + tool calls + the session-file path, sourced via the injected
		// readSessionBranch.
		expect(readSessionBranch).toHaveBeenCalled();
		const failuresDir = join(tmpDir, ".rpiv", "artifacts", "failures");
		expect(existsSync(failuresDir), "failures artifact directory was created").toBe(true);
		const artifactFiles = readdirSync(failuresDir).filter((f) => f.endsWith(".md"));
		expect(artifactFiles.length, "a death-scene artifact was written").toBeGreaterThanOrEqual(1);
		const body = readFileSync(join(failuresDir, artifactFiles[0]!), "utf-8");
		expect(body).toContain("per-command timeout");
		expect(body).toMatch(/\.jsonl/); // the absolute session-file path

		// ───────────────────────── Rung 4: validate does not blind-retry ─────────────────────────
		// Validation-retry gate, mechanism-1: the validate stage failed schema,
		// askAgentToFix ran (one captured retry prompt), but the worktree digest
		// was UNCHANGED ⇒ the gate aborted instead of blind-retrying. The terminal
		// failure carries ERR_VALIDATE_RETRY_UNCHANGED and the run ends at validate.
		const validateFailure = rows.find((r) => r.stage === "validate" && r.status === "failed");
		expect(validateFailure, "validate recorded a terminal failure").toBeDefined();
		expect(String(validateFailure!.errMsg)).toContain(ERR_VALIDATE_RETRY_UNCHANGED("validate"));
		// Exactly ONE validation-retry prompt was sent (the agent WAS asked to fix
		// before the digest was compared) — no second produce/validate cycle.
		const retryPrompts = chain.sentMessages.filter((m) => m.includes("doesn't satisfy the expected output schema"));
		expect(retryPrompts).toHaveLength(1);

		// ───────────────────────── Cost-bound conclusion (FRD §6) ─────────────────────────
		// The hung command's watchdog-attributable cost is bounded to the strike
		// ceiling on ONE unit (≤ strikes × ceiling): unit A exhausted after ≤ 2
		// strikes, and the run SURVIVED it — unit B ran and validate ran. The
		// cascade that killed four stages in the incident is broken: only ONE unit
		// failed to a watchdog, not the whole run.
		expect(result.success).toBe(false); // validate terminated the run at the validation gate — expected
		const watchdogFailures = rows.filter((r) => String(r.errMsg ?? "").includes("per-command timeout"));
		expect(watchdogFailures.length).toBe(1); // contained to unit A — NOT propagated across stages
		expect(unitBPrompt).toBeDefined(); // the run reached unit B after A's failure
		expect(validateFailure).toBeDefined(); // the run reached validate after the fan-out
	});
});
