/**
 * WIP guard — the user's uncommitted work is never the run's to judge or discard.
 *
 * Earned the hard way (opendots run 2026-09-27_11-36-01-edef): the goal lens
 * graded the WHOLE working-tree diff, including an unrelated uncommitted
 * redesign, and the scoped fix reverted it.
 *
 * Three layers, strongest first:
 * 1. `captureGoalKeepingWip` backs the pre-existing dirty set up at run start.
 * 2. `wipIntact` — a pre-existing path that is no longer dirty, gone, and NOT
 *    committed by this run is a FATAL failure; the run stops at once.
 * 3. `wipNotice` — the text graders and correctors receive: judge only this
 *    run's changes, and never checkout/restore/reset/stash/clean.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fs, type Output, type RunView, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { readGoalBaseline } from "../built-ins/goal-baseline.ts";
import { captureGoal } from "../built-ins/index.ts";
import { isBookkeepingPath } from "../vcs-path.ts";
import { detectVcs, type VcsBackend, type VcsStatusEntry, vcsCommittedPaths, vcsStatusEntries } from "../vcs-status.ts";
import type { Check } from "./unit-graph.ts";

interface WipRecord {
	/** Paths dirty (tracked-modified or untracked) when the run started. */
	paths: string[];
	/** Binary patch of the tracked ones. Undefined under jj: any jj invocation
	 *  snapshots the working copy, so the copies are the restore contract. */
	patch?: string;
	/** Directory holding copies of the untracked ones. */
	untrackedDir?: string;
	/** The subset of `paths` actually copied — a path deleted at run start is not. */
	copied?: string[];
	/** Backend that produced the record. Absent on a pre-change record. */
	backend?: VcsBackend;
	/** The commit the run starts from — the base of the committed-path range. */
	snapshotRev?: string;
}

const git = (cwd: string, args: string[]): string =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 256 * 1024 * 1024,
	});

/** Trimmed stdout, or `""` on any failure — a probe never throws. */
const tryRead = (bin: string, args: string[], cwd: string): string => {
	try {
		return execFileSync(bin, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
};

/** The commit a run starts from — `@-` under jj, `HEAD` under git. */
const SNAPSHOT_REV_ARGS: Readonly<Record<"jj" | "git", string[]>> = {
	jj: ["--no-pager", "log", "-r", "@-", "--no-graph", "-T", "commit_id"],
	git: ["rev-parse", "HEAD"],
};
const snapshotRevOf = (cwd: string, backend: VcsBackend): string =>
	backend === "none" ? "" : tryRead(backend, SNAPSHOT_REV_ARGS[backend], cwd);

/**
 * Backend-aware backup. Under jj every dirty path is copied — jj snapshots the
 * working copy on every invocation, so a run-start patch can be absorbed, and
 * `record.patch` stays undefined. Under git the tracked paths ride the binary
 * patch. `backend` is tested POSITIVELY for git: a `none` probe must not enter
 * the patch arm, where `git()` would throw.
 */
const backupDirty = (
	ctx: ScriptContext,
	rel: string,
	paths: string[],
	dirty: VcsStatusEntry[],
	backend: VcsBackend,
): WipRecord => {
	const record: WipRecord = { paths, backend, snapshotRev: snapshotRevOf(ctx.cwd, backend) };
	const untracked = new Set(dirty.filter((e) => e.xy === "??").map((e) => e.path));
	if (backend === "git" && paths.some((p) => !untracked.has(p))) {
		record.patch = `${rel}.patch`;
		writeFileSync(
			join(ctx.cwd, record.patch),
			git(ctx.cwd, ["diff", "HEAD", "--binary", "--", ...paths.filter((p) => !untracked.has(p))]),
		);
	}
	const copySet = backend === "jj" ? paths : paths.filter((p) => untracked.has(p));
	const copies = copySet.filter((p) => existsSync(join(ctx.cwd, p)));
	if (copies.length > 0) {
		record.untrackedDir = `${rel}-untracked`;
		record.copied = copies;
		for (const p of copies) {
			mkdirSync(dirname(join(ctx.cwd, record.untrackedDir, p)), { recursive: true });
			cpSync(join(ctx.cwd, p), join(ctx.cwd, record.untrackedDir, p), { recursive: true });
		}
	}
	return record;
};

/** The restore recipe for one path. A path neither arm covers gets an explicit
 *  message, never an empty string. */
const restoreHint = (rec: WipRecord, path: string): string => {
	const covered = rec.copied ? rec.copied.includes(path) : rec.untrackedDir !== undefined;
	const parts = [
		rec.untrackedDir && covered ? `cp -R ${rec.untrackedDir}/. .` : "",
		rec.patch ? `git apply ${rec.patch}` : "",
	].filter(Boolean);
	return parts.length > 0
		? parts.join(" && ")
		: `no automatic restore — ${path} was already deleted at run start; re-delete it if this run recreated it`;
};

/** build's goal capture, plus a restorable backup of the pre-existing dirty set. */
export const captureGoalKeepingWip = (ctx: ScriptContext): Omit<Output, "meta"> => {
	const out = captureGoal(ctx);
	const baseline = out.artifacts.find((a) => a.role === "baseline" && a.handle.kind === "fs");
	const paths = readGoalBaseline(baseline?.handle.kind === "fs" ? baseline.handle.path : undefined, ctx.cwd);
	if (paths.length === 0) return out;

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rel = `.rpiv/artifacts/goal/wip-${stamp}`;
	mkdirSync(join(ctx.cwd, dirname(rel)), { recursive: true });
	const backend = detectVcs(ctx.cwd);
	const record = backupDirty(ctx, rel, paths, vcsStatusEntries(ctx.cwd, backend), backend);
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

/** FATAL when a path that carried the user's work at run start is no longer dirty
 *  or is gone — and the run did not commit it. */
export const wipIntact: Check = {
	name: "wip-intact",
	run: (ctx) => {
		const rec = wipRecord(ctx.state, ctx.cwd);
		if (!rec) return [];
		// A record written before the seam filtered bookkeeping paths still lists
		// the run's own `.rpiv/` artifacts. They can never be dirty again, so they
		// must not read as reverted work.
		const paths = rec.paths.filter((p) => !isBookkeepingPath(p));
		if (paths.length === 0) return [];
		const backend = detectVcs(ctx.cwd);
		const dirty = new Set(vcsStatusEntries(ctx.cwd, backend).map((e) => e.path));
		const missing = paths.filter((p) => !dirty.has(p));
		if (missing.length === 0) return [];
		// A missing path may be COMMITTED, not reverted: under jj the run's own
		// `jj split` + `jj new` empties `@`'s diff but keeps the work in `@-`.
		const committed = new Set(rec.snapshotRev ? vcsCommittedPaths(ctx.cwd, rec.snapshotRev, backend) : []);
		return missing
			.filter((p) => !committed.has(p))
			.map((p) => ({
				source: "wip-intact",
				reason: `pre-existing uncommitted work in ${p} was reverted or deleted by this run`,
				evidence: `restore with: ${restoreHint(rec, p)}`,
				fatal: true,
			}));
	},
};

/** The instruction every grader and corrector of a side-effect unit receives. */
export const wipNotice = (state: RunView, cwd: string): string => {
	const rec = wipRecord(state, cwd);
	const paths = (rec?.paths ?? []).filter((p) => !isBookkeepingPath(p));
	const lines = [
		"NEVER run git checkout, restore, reset, stash, or clean, never jj abandon, jj restore, or jj op restore, and never revert or delete changes this run did not make.",
	];
	if (paths.length > 0) {
		lines.push(
			`These paths carried the user's uncommitted work BEFORE this run — they are not this run's output: never judge, flag, or revert them: ${paths.join(", ")}`,
		);
	}
	return lines.join(" ");
};
