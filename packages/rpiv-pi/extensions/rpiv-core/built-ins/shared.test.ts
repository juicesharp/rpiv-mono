/**
 * shared.test.ts — verdict envelope scores across the structure and scope
 * writers (writeStructureVerdict / writeScopeVerdict), moved verbatim from
 * built-in-workflows.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeScopeVerdict } from "./scope-checks.js";
import { writeStructureVerdict } from "./shared.js";

describe("verdict envelope scores (writeStructureVerdict / writeScopeVerdict)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-verdict-envelope-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});
	const fsHandle = { kind: "fs", path: ".rpiv/artifacts/plans/p.md" } as const;
	const fsArtifact = { handle: { kind: "fs", path: ".rpiv/artifacts/plans/p.md" } } as const;
	const structurePath = (who: string) => join(tmpDir, ".rpiv/artifacts/verdicts", `${who}__p.json`);
	const scopePath = () => join(tmpDir, ".rpiv/artifacts/verdicts", "implement-scope-check__p.json");

	it("writeStructureVerdict tiers: pass ⇒ 100/none, blocking ⇒ 0/high, all-advisory ⇒ null/low (data + persisted JSON)", () => {
		const pass = writeStructureVerdict("structure-check", fsHandle, [], tmpDir);
		expect(pass.data).toMatchObject({ dimension: "structure", pass: true, score: 100, severity: "none" });
		const blocking = writeStructureVerdict("structure-check", fsHandle, [{ detail: "d", where: "w" }], tmpDir);
		expect(blocking.data).toMatchObject({ pass: false, score: 0, severity: "high" });
		const advisory = writeStructureVerdict(
			"structure-check",
			fsHandle,
			[{ detail: "d", where: "w", advisory: true }],
			tmpDir,
		);
		expect(advisory.data).toMatchObject({ pass: false, score: null, severity: "low" });
		// The persisted JSON carries the same honest tiers.
		expect(JSON.parse(readFileSync(structurePath("structure-check"), "utf-8"))).toMatchObject({
			pass: false,
			score: null,
			severity: "low",
		});
	});

	it("writeStructureVerdict plain-findings persisted JSON is byte-identical to the pre-widening shape", () => {
		writeStructureVerdict("structure-check", fsHandle, [{ detail: "stale cite", where: "plans/p.md:12" }], tmpDir);
		expect(readFileSync(structurePath("structure-check"), "utf-8")).toBe(
			JSON.stringify(
				{
					dimension: "structure",
					pass: false,
					score: 0,
					severity: "high",
					artifact: ".rpiv/artifacts/plans/p.md",
					findings: [{ detail: "stale cite", where: "plans/p.md:12" }],
					feedback: "stale cite",
				},
				null,
				2,
			),
		);
	});

	it("writeScopeVerdict tiers: pass ⇒ 100/none, untracked-only ⇒ 0/medium, excess ⇒ 0/high, advisory-only ⇒ null/low", () => {
		const pass = writeScopeVerdict(fsArtifact, [], "pass", tmpDir);
		expect(pass.data).toMatchObject({ dimension: "scope", pass: true, score: 100, severity: "none" });
		const untracked = writeScopeVerdict(fsArtifact, [{ detail: "d", where: "w" }], "untracked-only", tmpDir);
		expect(untracked.data).toMatchObject({ pass: false, score: 0, severity: "medium" });
		const excess = writeScopeVerdict(fsArtifact, [{ detail: "d", where: "w" }], "excess", tmpDir);
		expect(excess.data).toMatchObject({ pass: false, score: 0, severity: "high" });
		const advisory = writeScopeVerdict(fsArtifact, [{ detail: "d", where: "w", advisory: true }], "excess", tmpDir);
		expect(advisory.data).toMatchObject({ pass: false, score: null, severity: "low" });
		expect(JSON.parse(readFileSync(scopePath(), "utf-8"))).toMatchObject({
			pass: false,
			score: null,
			severity: "low",
		});
	});

	it("writeScopeVerdict plain-findings persisted JSON is byte-identical (no advisory key, no declaredBy)", () => {
		writeScopeVerdict(fsArtifact, [{ detail: "stray write", where: "packages/a/stray.ts" }], "excess", tmpDir);
		expect(readFileSync(scopePath(), "utf-8")).toBe(
			JSON.stringify(
				{
					dimension: "scope",
					pass: false,
					verdict: "excess",
					score: 0,
					severity: "high",
					artifact: ".rpiv/artifacts/plans/p.md",
					findings: [{ detail: "stray write", where: "packages/a/stray.ts" }],
					feedback: "stray write",
				},
				null,
				2,
			),
		);
	});

	it("advisory-only and a validate-report acceptance compose on one envelope (disjoint key sets)", () => {
		const out = writeScopeVerdict(fsArtifact, [{ detail: "d", where: "w", advisory: true }], "excess", tmpDir, {
			declaredBy: "validate-report",
			accepted: ["packages/a/x.ts"],
		});
		expect(out.data).toMatchObject({
			score: null,
			severity: "low",
			declaredBy: "validate-report",
			accepted: ["packages/a/x.ts"],
		});
	});
});

// ---------------------------------------------------------------------------
// build scope-quarantine — the deterministic remedy arm for an untracked-only
// scope verdict: MOVE (never delete) run-created untracked excess under
// .rpiv/tmp/scope-quarantine/ and publish a manifest, then re-enter the floor.
// ---------------------------------------------------------------------------
