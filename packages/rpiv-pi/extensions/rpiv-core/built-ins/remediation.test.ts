import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasJj, seedJjStatusWorkspace } from "@juicesharp/rpiv-test-utils/vcs";
import type { CollectContext, ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitTreeDigest, remediationOutcome } from "./remediation.ts";

// The outcome's whole job: report deterministically whether the repair arm
// mutated the tree between snapshot and collect — `changed: false` ONLY on a
// provably identical tree, `changed: true` on any mutation OR missing signal.
describe("remediationOutcome", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-remediation-"));
		execFileSync("git", ["init", "-q"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "test"], { cwd: tmpDir, stdio: "ignore" });
		writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;\n");
		execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmpDir, stdio: "ignore" });
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const collect = (snapshot: string | undefined, cwd = tmpDir) =>
		remediationOutcome.collector.collect({ cwd, snapshot, skill: "remediate" } as CollectContext<
			string | undefined
		>) as { kind: "ok"; artifacts: readonly { meta?: unknown }[] };

	const changedOf = (result: { artifacts: readonly { meta?: unknown }[] }) =>
		(result.artifacts[0]?.meta as { changed?: boolean } | undefined)?.changed;

	it("reports changed: false when the tree is byte-identical between snapshot and collect", () => {
		expect(changedOf(collect(gitTreeDigest(tmpDir)))).toBe(false);
	});

	it("reports changed: true when a tracked file was edited in the window", () => {
		const before = gitTreeDigest(tmpDir);
		writeFileSync(join(tmpDir, "a.ts"), "export const a = 2;\n");
		expect(changedOf(collect(before))).toBe(true);
	});

	it("reports changed: true when a new untracked file appeared in the window", () => {
		const before = gitTreeDigest(tmpDir);
		writeFileSync(join(tmpDir, "b.ts"), "export const b = 1;\n");
		expect(changedOf(collect(before))).toBe(true);
	});

	it("reports changed: true when an EXISTING untracked file's bytes mutated in the window — the porcelain line is byte-identical, only content differs (the pre-widening digest was blind here)", () => {
		// Created BEFORE the snapshot so the `?? untracked.ts` porcelain line is
		// byte-identical on both sides: status and diff cannot see this
		// mutation — only the untracked-content component can.
		writeFileSync(join(tmpDir, "untracked.ts"), "export const u = 1;\n");
		const before = gitTreeDigest(tmpDir);
		writeFileSync(join(tmpDir, "untracked.ts"), "export const u = 2;\n");
		expect(changedOf(collect(before))).toBe(true);
	});

	it("reports changed: false on a no-edit hop with untracked files present", () => {
		writeFileSync(join(tmpDir, "untracked.ts"), "export const u = 1;\n");
		const before = gitTreeDigest(tmpDir);
		expect(changedOf(collect(before))).toBe(false);
	});

	it("reports changed: false when only untracked .rpiv/ bookkeeping churned in the window", () => {
		// Pre-existing trail content (a prior validate lap's report) so the
		// collapsed `?? .rpiv/` porcelain line is byte-identical on both sides —
		// a run always carries .rpiv/ by the time validate-fix fires.
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "validation"), { recursive: true });
		writeFileSync(join(tmpDir, ".rpiv", "artifacts", "validation", "2026-09-03_10-46-57.md"), "# report\n");
		const before = gitTreeDigest(tmpDir);
		// Fresh validate report + scratch created between snapshot and collect.
		writeFileSync(join(tmpDir, ".rpiv", "artifacts", "validation", "2026-09-03_18-04-28.md"), "# report\n");
		mkdirSync(join(tmpDir, ".rpiv", "tmp"), { recursive: true });
		writeFileSync(join(tmpDir, ".rpiv", "tmp", "scratch.txt"), "scratch\n");
		expect(changedOf(collect(before))).toBe(false);
	});

	it("ignores a TRACKED .rpiv/ file's content change (the diff-text component)", () => {
		// `-f`: a developer machine may carry a global `.rpiv/` ignore entry, and
		// the digest must not depend on it. The status component sees the same
		// path, so this pins the change-text component specifically.
		mkdirSync(join(tmpDir, ".rpiv", "artifacts"), { recursive: true });
		writeFileSync(join(tmpDir, ".rpiv", "artifacts", "report.md"), "# one\n");
		execFileSync("git", ["add", "-f", ".rpiv/artifacts/report.md"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-q", "-m", "track report"], { cwd: tmpDir, stdio: "ignore" });
		const before = gitTreeDigest(tmpDir);
		writeFileSync(join(tmpDir, ".rpiv", "artifacts", "report.md"), "# two\n");
		expect(gitTreeDigest(tmpDir)).toBe(before);
	});

	it("reports changed: false when a gitignored path appears in the window (--exclude-standard drops it)", () => {
		// The .gitignore is committed BEFORE the snapshot so the ignore file's
		// own tracked state cannot flip the digest — this fixture tests
		// exclusion, not porcelain noise from the ignore file's appearance.
		writeFileSync(join(tmpDir, ".gitignore"), "ignored.ts\n");
		execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-q", "-m", "ignore-file"], { cwd: tmpDir, stdio: "ignore" });
		const before = gitTreeDigest(tmpDir);
		writeFileSync(join(tmpDir, "ignored.ts"), "export const ig = 1;\n");
		expect(changedOf(collect(before))).toBe(false);
	});

	it("degrades to changed: true on a missing signal (non-repo cwd) — never stop on no signal", () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "rpiv-remediation-norepo-"));
		try {
			expect(gitTreeDigest(nonRepo)).toBeUndefined();
			expect(changedOf(collect(undefined, nonRepo))).toBe(true);
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
	});

	// Under jj the digest reads through the same seam (`jj diff --summary` +
	// `jj diff --git` + `??`-class content), so a jj run reports the same
	// did-anything-change signal a git run does.
	describe.runIf(hasJj())("jj workspace", () => {
		let jjDir: string;
		beforeEach(() => {
			jjDir = mkdtempSync(join(tmpdir(), "rpiv-remediation-jj-"));
			seedJjStatusWorkspace(jjDir);
		});
		afterEach(() => {
			rmSync(jjDir, { recursive: true, force: true });
		});

		it("returns a digest for a seeded jj tree, and the SAME digest twice", () => {
			const first = gitTreeDigest(jjDir);
			expect(first).toBeDefined();
			expect(gitTreeDigest(jjDir)).toBe(first);
		});

		it("changes the digest when a seeded file is edited", () => {
			const before = gitTreeDigest(jjDir);
			writeFileSync(join(jjDir, "modified.ts"), "three\n");
			expect(gitTreeDigest(jjDir)).not.toBe(before);
		});
	});

	it("parser projects the collected meta onto the remediation channel", () => {
		const parse = (meta: unknown) =>
			remediationOutcome.parser?.parse({ artifacts: [{ meta }] } as unknown as ParseContext<string | undefined>);
		expect(parse({ changed: false })).toEqual({
			kind: "ok",
			payload: { kind: "remediation", data: { changed: false } },
		});
		expect(parse({ changed: true })).toEqual({
			kind: "ok",
			payload: { kind: "remediation", data: { changed: true } },
		});
	});
});
