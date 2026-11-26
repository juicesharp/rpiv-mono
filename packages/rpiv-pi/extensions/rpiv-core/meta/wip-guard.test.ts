import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasJj, seedJjStatusWorkspace } from "@juicesharp/rpiv-test-utils/vcs";
import type { Output, RunView, ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGoalKeepingWip, wipIntact, wipNotice } from "./wip-guard.ts";

interface RecordedWip {
	paths: string[];
	patch?: string;
	untrackedDir?: string;
	copied?: string[];
	backend?: string;
	snapshotRev?: string;
}

const captureIn = (cwd: string): Output => {
	const ctx = { cwd, input: undefined, state: { originalInput: "fix the thing in the app please", named: {} } };
	return captureGoalKeepingWip(ctx as unknown as ScriptContext) as Output;
};

const readRecord = (cwd: string, out: Output): RecordedWip => {
	const wip = out.artifacts.find((a) => a.role === "wip");
	const rel = wip?.handle.kind === "fs" ? wip.handle.path : "";
	return JSON.parse(readFileSync(join(cwd, rel), "utf-8")) as RecordedWip;
};

// Under jj the backup cannot be a patch: any jj invocation snapshots the working
// copy and can absorb a run-start patch. The record is a per-file COPY of every
// dirty path, `patch` stays undefined, and the restore recipe is a `cp -R`.
// `jj` is not on every machine, so the block skips when the binary is absent.
describe.runIf(hasJj())("wip-guard under jj", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-wip-guard-jj-"));
		seedJjStatusWorkspace(cwd);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const jjIn = (...args: string[]) =>
		execFileSync("jj", ["--no-pager", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] });
	const start = () => {
		const out = captureIn(cwd);
		return { out, state: { named: { goal: [out] } } as unknown as RunView };
	};
	const check = (state: RunView) => wipIntact.run({ cwd, input: undefined, state, unit: "implement", round: 1 });

	it("backs the pre-existing work up as copies only — no patch in the record", () => {
		const { out } = start();
		expect(out.artifacts.some((a) => a.role === "wip" && a.handle.kind === "fs")).toBe(true);
		const record = readRecord(cwd, out);
		// The seam already removes the run's own `.rpiv/` bookkeeping from the
		// dirty universe, so the recorded path set is exactly the user's four.
		expect(record.paths.sort()).toEqual(["added.ts", "deleted.ts", "modified.ts", "new.ts"]);
		expect(record.patch).toBeUndefined();
		expect(record.backend).toBe("jj");
		expect(record.snapshotRev).toMatch(/^[0-9a-f]{12,}$/);
		// deleted.ts is gone, so it cannot be copied — the recorded path set is
		// the restore contract there.
		expect(record.untrackedDir).toBeDefined();
		expect([...(record.copied ?? [])].sort()).toEqual(["added.ts", "modified.ts", "new.ts"]);
		for (const p of ["modified.ts", "added.ts", "new.ts"]) {
			expect(existsSync(join(cwd, record.untrackedDir ?? "", p))).toBe(true);
		}
		expect(existsSync(join(cwd, record.untrackedDir ?? "", "deleted.ts"))).toBe(false);
	});

	it("a deleted pre-existing path is a FATAL row whose restore recipe is a cp -R, never a git apply", async () => {
		const { state } = start();
		expect(await check(state)).toEqual([]);
		rmSync(join(cwd, "added.ts"));
		const failures = await check(state);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ fatal: true });
		expect(failures[0]?.evidence).toContain("cp -R");
		expect(failures[0]?.evidence).not.toContain("git apply");
	});

	it("accepts a recorded path the run COMMITTED instead of reverting it", async () => {
		const { state } = start();
		// The sanctioned recipe: describe the whole working copy, then open a fresh
		// `@`. `@`'s diff is now empty, so a dirty-set-only guard would fatal on
		// every recorded path.
		jjIn("describe", "-m", "run work");
		jjIn("new");
		expect(await check(state)).toEqual([]);
	});

	it("reports an explicit no-recipe message when neither restore arm covers the path", async () => {
		// A record carrying only `paths`: jj never writes a patch, and a path that
		// was already deleted at run start has no copy to fall back on.
		const rel = ".rpiv/artifacts/goal/wip-t.json";
		mkdirSync(join(cwd, ".rpiv/artifacts/goal"), { recursive: true });
		writeFileSync(join(cwd, rel), JSON.stringify({ paths: ["ghost.ts"], backend: "jj" }));
		const state = { named: { goal: [{ artifacts: [{ handle: { kind: "fs", path: rel }, role: "wip" }] }] } };
		const failures = await check(state as unknown as RunView);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.evidence).toBe(
			"restore with: no automatic restore — ghost.ts was already deleted at run start; re-delete it if this run recreated it",
		);
	});

	it("ignores a legacy record's bookkeeping paths instead of fataling on them", async () => {
		// A pre-seam record listed the run's own `.rpiv/` artifacts; they can never
		// be dirty again, so they must not read as reverted work.
		const rel = ".rpiv/artifacts/goal/wip-old.json";
		mkdirSync(join(cwd, ".rpiv/artifacts/goal"), { recursive: true });
		writeFileSync(join(cwd, rel), JSON.stringify({ paths: [".rpiv/artifacts/goal/goal-t.md", "modified.ts"] }));
		const state = { named: { goal: [{ artifacts: [{ handle: { kind: "fs", path: rel }, role: "wip" }] }] } };
		expect(await check(state as unknown as RunView)).toEqual([]);
	});

	it("keeps the cp recipe for a legacy record that predates the copied list", async () => {
		// A record written before `copied` existed has `untrackedDir` but no
		// per-path list; the copy directory still covers every recorded path.
		const rel = ".rpiv/artifacts/goal/wip-legacy.json";
		const dir = ".rpiv/artifacts/goal/wip-legacy-untracked";
		mkdirSync(join(cwd, dir), { recursive: true });
		writeFileSync(join(cwd, rel), JSON.stringify({ paths: ["ghost.ts"], untrackedDir: dir }));
		const state = { named: { goal: [{ artifacts: [{ handle: { kind: "fs", path: rel }, role: "wip" }] }] } };
		const failures = await check(state as unknown as RunView);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.evidence).toContain("cp -R");
	});

	it("the grader notice bans the destructive jj verbs and lists the pre-existing paths", () => {
		const notice = wipNotice(start().state, cwd);
		expect(notice).toMatch(/NEVER run git checkout/);
		for (const verb of ["jj abandon", "jj restore", "jj op restore", "modified.ts", "added.ts"]) {
			expect(notice).toContain(verb);
		}
	});
});

// The git arm's counterpart: the record carries the run-start HEAD and copies
// only the untracked paths, so no binary patch is written.
describe("wip-guard under git", () => {
	it("records the run-start commit and copies only the untracked paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-wip-guard-git-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd });
			writeFileSync(join(cwd, "untracked.ts"), "u\n");
			const out = captureIn(cwd);
			const record = readRecord(cwd, out);
			expect(record.backend).toBe("git");
			expect(record.patch).toBeUndefined();
			expect(record.copied).toEqual(["untracked.ts"]);
			// An empty repo has no HEAD, so the run-start commit degrades to "".
			expect(record.snapshotRev).toBe("");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
