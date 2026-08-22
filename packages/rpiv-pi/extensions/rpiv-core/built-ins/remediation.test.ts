import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectContext, ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitTreeDigest, remediationOutcome } from "./remediation.js";

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

	it("degrades to changed: true on a missing signal (non-repo cwd) — never stop on no signal", () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "rpiv-remediation-norepo-"));
		try {
			expect(gitTreeDigest(nonRepo)).toBeUndefined();
			expect(changedOf(collect(undefined, nonRepo))).toBe(true);
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
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
