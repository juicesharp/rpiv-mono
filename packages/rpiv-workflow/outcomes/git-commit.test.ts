/**
 * Tests for the git-commit outcome — covers the collector + parser pair
 * on the success path, when git isn't on PATH, and when the working
 * tree isn't a git repo.
 *
 * Failure posture: no-baseline (not a git repo at snapshot time) and
 * HEAD-unchanged degrade to an honest `noOp: true` payload; git WORKING at
 * snapshot time but FAILING after the stage is `fatal` — fabricating noOp
 * there would let `gate` route on invented data. The parser is pure: it
 * never shells git and goes fatal on a foreign `meta` shape.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectCtx, ParseCtx, SnapshotCtx } from "../output-spec.js";
import {
	type GitHeadSnapshot,
	gitCommitCollector,
	gitCommitOutcome,
	gitCommitParser,
	gitHeadSnapshot,
} from "./git-commit.js";

const hasGit = (() => {
	try {
		execSync("git --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const initRepo = (cwd: string): void => {
	execSync("git init -q", { cwd });
	execSync("git config user.email test@example.com", { cwd });
	execSync("git config user.name Test", { cwd });
	execSync("git commit --allow-empty -q -m initial", { cwd });
};

const snapshotCtx = (cwd: string): SnapshotCtx => ({
	cwd,
	runId: "test-run",
	stageIndex: 0,
	state: { originalInput: "", output: undefined, named: {} },
});

const collectCtx = (cwd: string, snapshot: GitHeadSnapshot | undefined): CollectCtx<GitHeadSnapshot | undefined> => ({
	...snapshotCtx(cwd),
	branch: [],
	branchOffset: undefined,
	snapshot,
	skill: "commit",
});

/**
 * Run the full outcome (collector → parser) end-to-end, returning the
 * commit data the parser produced. Mirrors what `produceAndValidateOutput`
 * does in the runner.
 */
const runOutcome = async (cwd: string, snapshot: GitHeadSnapshot | undefined) => {
	const ctx = collectCtx(cwd, snapshot);
	const collected = await gitCommitOutcome.collector.collect(ctx);
	if (collected.kind === "fatal") return collected;
	const parseCtx: ParseCtx<GitHeadSnapshot | undefined> = { ...ctx, artifacts: collected.artifacts };
	return gitCommitOutcome.parser!.parse(parseCtx);
};

describe.runIf(hasGit)("gitHeadSnapshot", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-snap-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns the current HEAD SHA in a real repo", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		expect(snap?.baselineSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("returns undefined when cwd is not a git repo (no throw)", async () => {
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		expect(snap).toBeUndefined();
	});

	it("returns undefined when cwd does not exist (no throw)", async () => {
		const snap = await gitHeadSnapshot(snapshotCtx(join(tmpDir, "does-not-exist")));
		expect(snap).toBeUndefined();
	});
});

describe.runIf(hasGit)("gitCommitOutcome end-to-end", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-ext-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits a real commit payload when HEAD moved between snapshot and collect", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		expect(snap?.baselineSha).toMatch(/^[0-9a-f]{40}$/);

		writeFileSync(join(tmpDir, "a.txt"), "hello\n");
		execSync("git add a.txt", { cwd: tmpDir });
		execSync('git commit -q -m "add a"', { cwd: tmpDir });

		const result = await runOutcome(tmpDir, snap);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.kind).toBe("git-commit");
		const data = result.payload.data;
		expect(data.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(data.prevSha).toBe(snap?.baselineSha);
		expect(data.subject).toBe("add a");
		expect(data.filesChanged).toBe(1);
		expect(data.noOp).toBeUndefined();
	});

	it("emits noOp payload when HEAD did not move", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		const result = await runOutcome(tmpDir, snap);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data.noOp).toBe(true);
		expect(result.payload.data.prevSha).toBe(snap?.baselineSha);
	});

	it("emits noOp payload when snapshot is undefined (snapshot failure upstream)", async () => {
		const result = await runOutcome(tmpDir, undefined);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data.noOp).toBe(true);
	});

	it("goes FATAL when git worked at snapshot time but fails after the stage", async () => {
		// Synthesize a snapshot with a fake baseline; collect runs in a non-repo
		// cwd — the environment broke mid-stage. Pre-fix this fabricated a
		// noOp payload and `gate` routed on invented data.
		const result = await runOutcome(tmpDir, { baselineSha: "deadbeef" });
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toContain("git rev-parse HEAD failed after the stage");
	});
});

describe.runIf(hasGit)("gitCommitCollector emits one meta-complete artifact on non-fatal paths", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-res-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits role:'commit' opaque handle whose meta carries the COMPLETE fact (parser stays pure)", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		writeFileSync(join(tmpDir, "a.txt"), "hello\n");
		execSync("git add a.txt", { cwd: tmpDir });
		execSync('git commit -q -m "add a"', { cwd: tmpDir });

		const collected = await gitCommitCollector.collect(collectCtx(tmpDir, snap));
		expect(collected.kind).toBe("ok");
		if (collected.kind !== "ok") return;
		expect(collected.artifacts).toHaveLength(1);
		expect(collected.artifacts[0]?.role).toBe("commit");
		expect(collected.artifacts[0]?.handle.kind).toBe("opaque");
		// Subject + filesChanged interrogated at COLLECT time — the parser
		// never shells git.
		const meta = collected.artifacts[0]?.meta as Record<string, unknown>;
		expect(meta.subject).toBe("add a");
		expect(meta.filesChanged).toBe(1);
		expect(meta.noOp).toBe(false);
	});

	it("emits a baselineMissing no-op artifact when the snapshot found no repo", async () => {
		const collected = await gitCommitCollector.collect(collectCtx(tmpDir, undefined));
		expect(collected.kind).toBe("ok");
		if (collected.kind !== "ok") return;
		expect(collected.artifacts).toHaveLength(1);
		const meta = collected.artifacts[0]?.meta as Record<string, unknown>;
		expect(meta.baselineMissing).toBe(true);
		expect(meta.noOp).toBe(true);
	});
});

describe("gitCommitParser is pure and validates its meta contract", () => {
	const parseWith = (artifacts: ParseCtx<GitHeadSnapshot | undefined>["artifacts"]) =>
		gitCommitParser.parse({ ...collectCtx("/nonexistent", undefined), artifacts });

	it("goes fatal when handed an artifact with a foreign meta shape", async () => {
		const result = await parseWith([{ handle: { kind: "opaque", id: "x" }, role: "commit", meta: { sha: 42 } }]);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toContain("gitCommitParser requires the meta gitCommitCollector emits");
	});

	it("goes fatal when handed no artifact at all", async () => {
		const result = await parseWith([]);
		expect(result.kind).toBe("fatal");
	});

	it("projects a complete meta into GitCommitData without any I/O", async () => {
		const result = await parseWith([
			{
				handle: { kind: "opaque", id: "feed" },
				role: "commit",
				meta: {
					baselineSha: "dead",
					headSha: "feed",
					baselineMissing: false,
					noOp: false,
					subject: "add a",
					filesChanged: 3,
				},
			},
		]);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data).toEqual({ sha: "feed", prevSha: "dead", subject: "add a", filesChanged: 3 });
	});
});

// Suppress unused-import lint when this file runs without git on PATH.
void existsSync;
