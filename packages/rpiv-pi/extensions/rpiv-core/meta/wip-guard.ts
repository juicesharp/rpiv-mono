/**
 * WIP guard — the user's uncommitted work is never the run's to judge or discard.
 *
 * Earned the hard way (opendots run 2026-09-27_11-36-01-edef): the implement
 * unit's goal lens graded the WHOLE working-tree diff, which included an
 * unrelated, uncommitted popover redesign from the night before; it flagged
 * the redesign as "something the goal did not ask for", and the scoped fix —
 * obeying "touch only the files the evidence names" — ran `git checkout --`
 * on it. build/ship subtract the run-start baseline; meta did not.
 *
 * Three layers, strongest first:
 * 1. `captureGoalKeepingWip` backs the pre-existing dirty set up at run start
 *    (a binary patch of the tracked paths + copies of the untracked ones), so
 *    nothing a run does can lose it.
 * 2. `wipIntact` — a deterministic check on every side-effect unit: a
 *    pre-existing path that is no longer dirty (reverted) or gone (deleted
 *    untracked) is a FATAL failure — the run stops at once, no correction
 *    round, naming the backup to restore from.
 * 3. `wipNotice` — the text graders and correctors receive: judge only this
 *    run's changes, and never checkout/restore/reset/stash/clean.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fs, type Output, type RunView, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { gitDirtyEntries, readGoalBaseline } from "../built-ins/goal-baseline.js";
import { captureGoal } from "../built-ins/index.js";
import type { Check } from "./unit-graph.js";

interface WipRecord {
	/** Paths dirty (tracked-modified or untracked) when the run started. */
	paths: string[];
	/** Binary patch of the tracked ones, restorable with `git apply`. */
	patch?: string;
	/** Directory holding copies of the untracked ones. */
	untrackedDir?: string;
}

const git = (cwd: string, args: string[]): string =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 256 * 1024 * 1024,
	});

/** build's goal capture, plus a restorable backup of the pre-existing dirty set. */
export const captureGoalKeepingWip = (ctx: ScriptContext): Omit<Output, "meta"> => {
	const out = captureGoal(ctx);
	const baseline = out.artifacts.find((a) => a.role === "baseline" && a.handle.kind === "fs");
	const paths = readGoalBaseline(baseline?.handle.kind === "fs" ? baseline.handle.path : undefined, ctx.cwd);
	if (paths.length === 0) return out;

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rel = `.rpiv/artifacts/goal/wip-${stamp}`;
	const untracked = new Set(
		gitDirtyEntries(ctx.cwd)
			.filter((e) => e.xy === "??")
			.map((e) => e.path),
	);
	const tracked = paths.filter((p) => !untracked.has(p));
	const record: WipRecord = { paths };
	mkdirSync(join(ctx.cwd, dirname(rel)), { recursive: true });
	if (tracked.length > 0) {
		record.patch = `${rel}.patch`;
		writeFileSync(join(ctx.cwd, record.patch), git(ctx.cwd, ["diff", "HEAD", "--binary", "--", ...tracked]));
	}
	const copies = paths.filter((p) => untracked.has(p) && existsSync(join(ctx.cwd, p)));
	if (copies.length > 0) {
		record.untrackedDir = `${rel}-untracked`;
		for (const p of copies) {
			mkdirSync(dirname(join(ctx.cwd, record.untrackedDir, p)), { recursive: true });
			cpSync(join(ctx.cwd, p), join(ctx.cwd, record.untrackedDir, p), { recursive: true });
		}
	}
	writeFileSync(join(ctx.cwd, `${rel}.json`), `${JSON.stringify(record, null, 2)}\n`);
	return { ...out, artifacts: [...out.artifacts, { handle: fs(`${rel}.json`), role: "wip" }] };
};

const wipRecord = (state: RunView, cwd: string): WipRecord | undefined => {
	const a = state.named.goal?.at(-1)?.artifacts.find((x) => x.role === "wip" && x.handle.kind === "fs");
	if (a?.handle.kind !== "fs") return undefined;
	try {
		return JSON.parse(readFileSync(join(cwd, a.handle.path), "utf-8")) as WipRecord;
	} catch {
		return undefined;
	}
};

/** FATAL when a path that carried the user's work at run start is no longer dirty or is gone. */
export const wipIntact: Check = {
	name: "wip-intact",
	run: (ctx) => {
		const rec = wipRecord(ctx.state, ctx.cwd);
		if (!rec || rec.paths.length === 0) return [];
		const dirty = new Set(gitDirtyEntries(ctx.cwd).map((e) => e.path));
		const restore = [
			rec.patch ? `git apply ${rec.patch}` : "",
			rec.untrackedDir ? `cp -R ${rec.untrackedDir}/. .` : "",
		]
			.filter(Boolean)
			.join(" && ");
		return rec.paths
			.filter((p) => !dirty.has(p))
			.map((p) => ({
				source: "wip-intact",
				reason: `pre-existing uncommitted work in ${p} was reverted or deleted by this run`,
				evidence: `restore with: ${restore}`,
				fatal: true,
			}));
	},
};

/** The instruction every grader and corrector of a side-effect unit receives. */
export const wipNotice = (state: RunView, cwd: string): string => {
	const rec = wipRecord(state, cwd);
	const lines = [
		"NEVER run git checkout, restore, reset, stash, or clean, and never revert or delete changes this run did not make.",
	];
	if (rec && rec.paths.length > 0) {
		lines.push(
			`These paths carried the user's uncommitted work BEFORE this run — they are not this run's output: never judge, flag, or revert them: ${rec.paths.join(", ")}`,
		);
	}
	return lines.join(" ");
};
