/**
 * verdict-collector — the disk-first collection contract: the newest
 * determined-name verdict file written since the unit's snapshot wins;
 * sibling dimensions / prior rounds are excluded; the transcript scan (text +
 * write tool-arguments) is the fallback; one composite fatal names every
 * missed surface. The f9a6 replay pins the incident shape: the file exists on
 * disk while the spoken announcement typos the directory prefix.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fs as fsHandle, type Output, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERDICT_DIR } from "./shared.js";
import { type VerdictSnapshot, verdictCollector } from "./verdict-collector.js";

const DIR = VERDICT_DIR; // ".rpiv/artifacts/verdicts"
const PLAN_BASE = "2026-01-01_00-00-00_demo-plan";
const F9A6_BASE = "2026-09-03_12-35-54_p2c-verification-overhead";

const planOut = (base: string): Output =>
	({
		artifacts: [{ handle: fsHandle(`.rpiv/artifacts/plans/${base}.md`) }],
		data: {},
		kind: "",
		meta: {},
	}) as unknown as Output;

const asst = (parts: unknown[]): unknown => ({
	type: "message",
	message: { role: "assistant", content: parts },
});
const textPart = (text: string) => ({ type: "text", text });
const writeUse = (path: string) => ({ type: "tool_use", name: "write", input: { path } });
const readUse = (path: string) => ({ type: "tool_use", name: "read", input: { path } });
const editUse = (path: string) => ({
	type: "tool_use",
	name: "edit",
	input: { path, edits: [{ oldText: "a", newText: "b" }] },
});

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "f9a6-actionability-session.jsonl");

/** The persisted wire rows → the modeled branch shape: `toolCall`/`arguments`
 *  become `tool_use`/`input`, and the fixture's `/repo` machine prefix becomes
 *  this test's tmp cwd. */
const fixtureBranch = (cwd: string): unknown[] =>
	readFileSync(FIXTURE, "utf-8")
		.split("\n")
		.filter((l) => l.trim() !== "" && !l.startsWith("//"))
		.map((line) => JSON.parse(line))
		.map((row: Record<string, unknown>) => {
			const message = row.message as { role: string; content: Array<Record<string, unknown>> } | undefined;
			if (row.type !== "message" || !message || message.role !== "assistant") return row;
			return {
				...row,
				message: {
					...message,
					content: message.content.map((part) =>
						part.type === "toolCall"
							? {
									type: "tool_use",
									name: part.name,
									input: {
										...(part.arguments as Record<string, unknown>),
										path: String((part.arguments as { path: string }).path).replace(/^\/repo/, cwd),
									},
								}
							: part,
					),
				},
			};
		});

const okPathOf = (r: unknown): string | undefined => {
	const o = r as { kind?: string; artifacts?: Array<{ handle?: { path?: string } }> };
	return o.kind === "ok" ? o.artifacts?.[0]?.handle?.path : undefined;
};

describe("verdictCollector", () => {
	let cwd: string;
	const collector = verdictCollector({ dir: DIR, sourceChannel: "plans" });

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-verdict-collector-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const seedVerdict = (name: string, mtime?: Date): void => {
		mkdirSync(join(cwd, DIR), { recursive: true });
		writeFileSync(join(cwd, DIR, name), JSON.stringify({ dimension: "actionability", pass: true }), "utf-8");
		if (mtime) utimesSync(join(cwd, DIR, name), mtime, mtime);
	};

	/** The unit-start snapshot — pinned separately from collect, mirroring the
	 *  runner (snapshot before the stage body, collect after). */
	const snapOf = (plans?: Output[]): VerdictSnapshot => {
		const state = { named: { plans: plans ?? [planOut(PLAN_BASE)] } } as unknown as RunView;
		return collector.snapshot?.({ cwd, runId: "r1", stageIndex: 0, state }) as VerdictSnapshot;
	};
	const run = async (
		snapshot: VerdictSnapshot,
		args: { branch?: unknown[]; unitLabel?: string; plans?: Output[] },
	) => {
		const state = { named: { plans: args.plans ?? [planOut(PLAN_BASE)] } } as unknown as RunView;
		return collector.collect({
			cwd,
			runId: "r1",
			stageIndex: 0,
			state,
			branch: (args.branch ?? []) as never,
			branchOffset: undefined,
			snapshot,
			skill: "grade",
			...(args.unitLabel !== undefined ? { unitLabel: args.unitLabel } : {}),
		} as never);
	};

	it("collects disk-first: the newest determined-name file written since the snapshot (branch announces nothing)", async () => {
		// Present BEFORE the snapshot: a sibling artifact's verdict, a sibling
		// dimension's verdict, and this pair's prior round — all excluded.
		seedVerdict("other-plan__actionability__old.json");
		seedVerdict(`${PLAN_BASE}__correctness__old.json`);
		seedVerdict(`${PLAN_BASE}__actionability__old.json`);
		const snapshot = snapOf(); // unit start: the seeded files are prior state
		const before = await run(snapshot, { unitLabel: "actionability" });
		expect(before.kind).toBe("fatal"); // nothing new yet
		seedVerdict(`${PLAN_BASE}__actionability__new.json`);
		const result = await run(snapshot, { unitLabel: "actionability" });
		expect(result).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "fs", path: `${DIR}/${PLAN_BASE}__actionability__new.json` }, role: "primary" }],
		});
	});

	it("takes the NEWEST new file (mtime, tie broken by name)", async () => {
		seedVerdict(`${PLAN_BASE}__actionability__a.json`, new Date(2020, 0, 1));
		const snapshot = snapOf(); // unit start: a.json is prior state
		const before = await run(snapshot, { unitLabel: "actionability" });
		expect(before.kind).toBe("fatal");
		seedVerdict(`${PLAN_BASE}__actionability__b.json`, new Date(2020, 0, 2));
		seedVerdict(`${PLAN_BASE}__actionability__c.json`, new Date(2020, 0, 3));
		const result = await run(snapshot, { unitLabel: "actionability" });
		expect(result.kind).toBe("ok");
		expect(okPathOf(result)).toBe(`${DIR}/${PLAN_BASE}__actionability__c.json`);
	});

	it("determined-name tightness: a text announcement of a DIFFERENT dimension's verdict is not collected", async () => {
		const branch = [asst([textPart(`wrote ${DIR}/${PLAN_BASE}__correctness__x.json`)])];
		const result = await run(snapOf(), { branch, unitLabel: "actionability" });
		expect(result.kind).toBe("fatal");
	});

	it("loose degradation without unitLabel: today's directory pattern + widening still collects (never fatals on prior shapes)", async () => {
		const branch = [asst([textPart(`wrote ${DIR}/${PLAN_BASE}__correctness__x.json`)])];
		const result = await run(snapOf(), { branch });
		expect(result).toEqual({
			kind: "ok",
			artifacts: [{ handle: { kind: "fs", path: `${DIR}/${PLAN_BASE}__correctness__x.json` }, role: "primary" }],
		});
	});

	it("tool-args arm: a write tool-call under the verdict dir collects when text and disk miss (tightened when determined)", async () => {
		const abs = `${cwd}/${DIR}/${PLAN_BASE}__actionability__from-tool.json`;
		const branch = [asst([writeUse(abs), textPart(".riv typo — no real announcement")])];
		const result = await run(snapOf(), { branch, unitLabel: "actionability" });
		expect(result).toEqual({
			kind: "ok",
			artifacts: [
				{ handle: { kind: "fs", path: `${DIR}/${PLAN_BASE}__actionability__from-tool.json` }, role: "primary" },
			],
		});
	});

	it("tool-args arm: an edit tool-call on a NEW determined-name path collects like a write", async () => {
		const abs = `${cwd}/${DIR}/${PLAN_BASE}__actionability__from-edit.json`;
		const result = await run(snapOf(), { branch: [asst([editUse(abs)])], unitLabel: "actionability" });
		expect(okPathOf(result)).toBe(`${DIR}/${PLAN_BASE}__actionability__from-edit.json`);
	});

	it("tool-args arms exclude a prior-round path the unit merely named (edit/write that left the file untouched)", async () => {
		seedVerdict(`${PLAN_BASE}__actionability__old.json`, new Date(Date.now() - 60_000));
		const snapshot = snapOf(); // the prior file is listed with its mtime
		const prior = `${cwd}/${DIR}/${PLAN_BASE}__actionability__old.json`;
		for (const use of [editUse(prior), writeUse(prior)]) {
			const result = await run(snapshot, { branch: [asst([use])], unitLabel: "actionability" });
			expect(result.kind).toBe("fatal");
		}
		// Once the file actually changes, the same path collects (disk arm).
		seedVerdict(`${PLAN_BASE}__actionability__old.json`);
		const result = await run(snapshot, { branch: [asst([editUse(prior)])], unitLabel: "actionability" });
		expect(okPathOf(result)).toBe(`${DIR}/${PLAN_BASE}__actionability__old.json`);
	});

	it("composite fatal: names all three attempted surfaces", async () => {
		const result = await run(snapOf(), { unitLabel: "actionability" });
		expect(result.kind).toBe("fatal");
		expect((result as { message: string }).message).toMatch(/new since snapshot/);
		expect((result as { message: string }).message).toMatch(/assistant text/);
		expect((result as { message: string }).message).toMatch(/write tool-call arguments/);
	});

	it("f9a6 replay — disk arm: the on-disk verdict file wins and the .riv typo never matters", async () => {
		const snapshot = snapOf([planOut(F9A6_BASE)]); // unit start: no file yet
		seedVerdict(`${F9A6_BASE}__actionability__2026-09-03_14-04-29.json`);
		const branch = fixtureBranch(cwd);
		const result = await run(snapshot, { branch, unitLabel: "actionability", plans: [planOut(F9A6_BASE)] });
		expect(result.kind).toBe("ok");
		expect(okPathOf(result)).toBe(`${DIR}/${F9A6_BASE}__actionability__2026-09-03_14-04-29.json`);
	});

	it("f9a6 replay — no file on disk: the tool-args arm returns the write path", async () => {
		const branch = fixtureBranch(cwd);
		const result = await run(snapOf([planOut(F9A6_BASE)]), {
			branch,
			unitLabel: "actionability",
			plans: [planOut(F9A6_BASE)],
		});
		expect(result.kind).toBe("ok");
		expect(okPathOf(result)).toBe(`${DIR}/${F9A6_BASE}__actionability__2026-09-03_14-04-29.json`);
	});

	it("f9a6 replay — a mismatched dimension misses on every arm: the fatal names all three channels", async () => {
		const branch = fixtureBranch(cwd);
		const result = await run(snapOf([planOut(F9A6_BASE)]), {
			branch,
			unitLabel: "correctness",
			plans: [planOut(F9A6_BASE)],
		});
		expect(result.kind).toBe("fatal");
		expect((result as { message: string }).message).toMatch(/all missed/);
	});

	it("I2 regression — a read-only branch (the prior round's verdict read back) collects nothing: composite fatal", async () => {
		seedVerdict(`${PLAN_BASE}__actionability__old.json`);
		const snapshot = snapOf(); // the prior file is listed — the disk arm excludes it
		const branch = [asst([readUse(`${cwd}/${DIR}/${PLAN_BASE}__actionability__old.json`)])];
		const result = await run(snapshot, { branch, unitLabel: "actionability" });
		expect(result.kind).toBe("fatal");
		expect((result as { message: string }).message).toMatch(/all missed/);
	});

	it("surviving filtered surface — [write(new), read(prior)] with disk holding only the prior collects the write's new path", async () => {
		seedVerdict(`${PLAN_BASE}__actionability__old.json`);
		const snapshot = snapOf(); // prior round listed; new.json absent from disk
		const branch = [
			asst([writeUse(`${cwd}/${DIR}/${PLAN_BASE}__actionability__new.json`)]),
			asst([readUse(`${cwd}/${DIR}/${PLAN_BASE}__actionability__old.json`)]), // later in branch order — filtered, cannot win
		];
		const result = await run(snapshot, { branch, unitLabel: "actionability" });
		expect(result.kind).toBe("ok");
		expect(okPathOf(result)).toBe(`${DIR}/${PLAN_BASE}__actionability__new.json`);
	});
});
