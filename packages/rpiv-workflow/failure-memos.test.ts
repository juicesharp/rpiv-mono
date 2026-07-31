/**
 * failure-memos tests — bounded log of stage/unit failures surfaced as an
 * additive prompt suffix on every subsequently-built stage/unit session.
 */

import { describe, expect, it } from "vitest";
import type { AuditContext } from "./audit-ctx.js";
import { LifecycleDispatcher } from "./events.js";
import { appendFailureMemo, failureMemoSuffix, MAX_FAILURE_MEMO_ERR_LEN, MAX_FAILURE_MEMOS } from "./failure-memos.js";
import { freshRunState } from "./runner/run-context.js";
import type { FailureMemo, RunState, UnitRef } from "./types.js";

/** A sessionless AuditContext for a non-unit (single-stage) failure, like `auditCtxFor`. */
const auditFor = (state: RunState, stageName = "build", skill = "build", unit?: UnitRef): AuditContext => ({
	session: null,
	cwd: "/tmp/x",
	runId: "run-1",
	state,
	stageName,
	skill,
	lifecycle: new LifecycleDispatcher(undefined),
	runIdentity: { workflow: "wf", totalStages: 2, trigger: { kind: "programmatic" } },
	...(unit ? { unit } : {}),
});

/** A loop-unit AuditContext — `stageName` carries the DISPLAY decoration, `unit` carries machine identity. */
const unitAuditFor = (state: RunState, unit: UnitRef): AuditContext =>
	auditFor(state, `${unit.parent} (${unit.label})`, "build", unit);

const unit = (parent: string, id: string, label = id): UnitRef => ({
	parent,
	role: "produce",
	index: 1,
	id,
	label,
});

describe("failureMemoSuffix — clean run", () => {
	it('returns "" when there are no memos (byte-identical prompt)', () => {
		expect(failureMemoSuffix(freshRunState("x"))).toBe("");
	});
});

describe("appendFailureMemo — non-unit (terminal / entry-throw) failure", () => {
	it("appends one memo shaped { stage: stageName, errMsg, ts } with NO unitId", () => {
		const state = freshRunState("x");
		appendFailureMemo(state, auditFor(state), "build failed: missing input");

		expect(state.failureMemos).toHaveLength(1);
		const memo: FailureMemo = state.failureMemos[0]!;
		expect(memo.stage).toBe("build"); // stageName — machine identity for a non-unit failure
		expect(memo.unitId).toBeUndefined();
		expect(memo.errMsg).toBe("build failed: missing input");
		expect(typeof memo.ts).toBe("string");
		expect(memo.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601-ish
	});
});

describe("appendFailureMemo — loop-unit failure", () => {
	it("appends a memo with stage = unit PARENT (machine identity) and unitId = unit id", () => {
		const state = freshRunState("x");
		// `stageName` carries the DISPLAY decoration (`parent (label)`), NOT the machine identity.
		appendFailureMemo(state, unitAuditFor(state, unit("implement", "phase-2")), "compile error");

		expect(state.failureMemos).toHaveLength(1);
		const memo = state.failureMemos[0]!;
		expect(memo.stage).toBe("implement"); // parent — machine identity, not the decorated display
		expect(memo.unitId).toBe("phase-2"); // the unit's stable audit id
		expect(memo.errMsg).toBe("compile error");
	});
});

describe("failureMemoSuffix — rendered block", () => {
	it('renders the "Prior failures …" header + one line per memo, newest-first', () => {
		const state = freshRunState("x");
		appendFailureMemo(state, auditFor(state), "first failure");
		appendFailureMemo(state, auditFor(state), "second failure");

		const suffix = failureMemoSuffix(state);
		expect(suffix.startsWith("\n\nPrior failures in this run")).toBe(true);
		// newest-first: the second failure's line appears ABOVE the first's.
		const secondIdx = suffix.indexOf("second failure");
		const firstIdx = suffix.indexOf("first failure");
		expect(secondIdx).toBeGreaterThan(-1);
		expect(firstIdx).toBeGreaterThan(-1);
		expect(secondIdx).toBeLessThan(firstIdx);
		expect(suffix).toMatch(/^- build: second failure$/m);
		expect(suffix).toMatch(/^- build: first failure$/m);
	});

	it("tags a loop-unit failure's line as `parent (unit <id>)`", () => {
		const state = freshRunState("x");
		appendFailureMemo(state, unitAuditFor(state, unit("implement", "phase-2")), "boom");

		expect(failureMemoSuffix(state)).toContain("- implement (unit phase-2): boom");
	});
});

describe("bounding", () => {
	it("drops the OLDEST memo once MAX_FAILURE_MEMOS is exceeded (length stays <= cap)", () => {
		const state = freshRunState("x");
		// Fill the cap, then one more.
		for (let i = 0; i <= MAX_FAILURE_MEMOS; i++) {
			appendFailureMemo(state, auditFor(state), `failure ${i}`);
		}
		expect(state.failureMemos.length).toBe(MAX_FAILURE_MEMOS);
		// Oldest ("failure 0") dropped; newest ("failure <MAX>") retained.
		expect(state.failureMemos.some((m) => m.errMsg === "failure 0")).toBe(false);
		expect(state.failureMemos.some((m) => m.errMsg === `failure ${MAX_FAILURE_MEMOS}`)).toBe(true);
	});

	it("truncates an over-long errMsg to MAX_FAILURE_MEMO_ERR_LEN + a trailing ellipsis", () => {
		const state = freshRunState("x");
		const longMsg = "x".repeat(MAX_FAILURE_MEMO_ERR_LEN + 50);
		appendFailureMemo(state, auditFor(state), longMsg);

		const memo = state.failureMemos[0]!;
		expect(memo.errMsg.length).toBe(MAX_FAILURE_MEMO_ERR_LEN + 1); // cap + the ellipsis char
		expect(memo.errMsg.endsWith("…")).toBe(true);
		expect(memo.errMsg.slice(0, -1)).toBe("x".repeat(MAX_FAILURE_MEMO_ERR_LEN));
	});

	it("leaves a within-cap errMsg byte-identical (no truncation, no ellipsis)", () => {
		const state = freshRunState("x");
		const msg = "y".repeat(MAX_FAILURE_MEMO_ERR_LEN); // exactly at the cap
		appendFailureMemo(state, auditFor(state), msg);
		expect(state.failureMemos[0]!.errMsg).toBe(msg);
	});

	it("renders at most MAX_FAILURE_MEMOS lines, newest-first", () => {
		const state = freshRunState("x");
		for (let i = 0; i < MAX_FAILURE_MEMOS + 5; i++) {
			appendFailureMemo(state, auditFor(state), `failure ${i}`);
		}
		const lines = failureMemoSuffix(state)
			.split("\n")
			.filter((l) => l.startsWith("- "));
		expect(lines.length).toBe(MAX_FAILURE_MEMOS);
	});
});
