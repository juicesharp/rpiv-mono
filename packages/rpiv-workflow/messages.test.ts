/**
 * Tests for `LEGACY_OVERLAY_NOTICE`'s embedded migration shell.
 *
 * The notice ships a 4-step `bash` migration snippet inside its message
 * string; users will copy-paste it as-is. This test extracts the snippet
 * via the regex `/Move it: \`([^`]+)\`/`, runs it against a synthetic
 * legacy tree, and asserts the produced layout. Failures here mean the
 * notice shape has drifted (regex no longer matches) or the shell no
 * longer produces a tree the loader accepts.
 *
 * POSIX-only — the embedded pipeline uses `bash` features (`mkdir -p`,
 * glob expansion, `rm -rf`) that aren't portable to PowerShell.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflows } from "./load/index.js";
import { LEGACY_OVERLAY_NOTICE, LEGACY_RUNS_NOTICE } from "./load/legacy.js";
import {
	ERR_RESUME_LOOP_MISMATCH,
	FAIL_LOOP_CAP_HALT,
	MSG_LOOP_CAP_ADVANCE,
	MSG_LOOP_ZERO_UNITS,
	MSG_RESUME_LOOP_MISMATCH,
} from "./messages.js";

/** Extract the single backtick-delimited shell after `Move it:` from a notice. */
const extractShell = (notice: string): string => {
	const match = notice.match(/Move (?:it|them): `([^`]+)`/);
	expect(match, "notice shape drift: no `Move it/them: \\`<shell>\\`` segment found").not.toBeNull();
	return match![1];
};

// Reused fixture body — a minimal valid pack-file workflow. Uses an absolute
// path to the package's `api.ts` (mirroring load.test.ts:87-90) because jiti
// resolves imports from the loaded file's location, and the loaded file lives
// in os.tmpdir() where bare specifiers like "@juicesharp/rpiv-workflow" have
// no node_modules chain back to the workspace.
const importApi = `import { defineWorkflow, acts } from "${join(__dirname, "api.ts")}";`;
const legacyConfigBody =
	`${importApi}\n` +
	`export default defineWorkflow({ name: "from-legacy-config", start: "x", stages: { x: acts() }, edges: { x: "stop" } });\n`;
const legacyPackBody = (name: string): string =>
	`${importApi}\n` +
	`export default defineWorkflow({ name: "${name}", start: "x", stages: { x: acts() }, edges: { x: "stop" } });\n`;

describe.skipIf(process.platform === "win32")("LEGACY_OVERLAY_NOTICE — embedded migration shell", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-legacy-migrate-"));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("regex extracts the shell snippet from the notice", () => {
		const notice = LEGACY_OVERLAY_NOTICE(workDir);
		const match = notice.match(/Move it: `([^`]+)`/);
		expect(match, "LEGACY_OVERLAY_NOTICE shape drift: no `Move it: \\`<shell>\\`` segment found").not.toBeNull();
		expect(match![1]).toBeTruthy();
	});

	it("embedded shell migrates a legacy tree end-to-end", async () => {
		// Materialise a fake legacy tree: dashed dir + config + two pack files
		// (so the glob `workflows/*.ts` exercises >1 file).
		const legacyRoot = join(workDir, ".rpiv-workflow");
		const legacyPacksDir = join(legacyRoot, "workflows");
		mkdirSync(legacyPacksDir, { recursive: true });
		writeFileSync(join(legacyRoot, "workflows.config.ts"), legacyConfigBody, "utf-8");
		writeFileSync(join(legacyPacksDir, "foo.ts"), legacyPackBody("foo"), "utf-8");
		writeFileSync(join(legacyPacksDir, "bar.ts"), legacyPackBody("bar"), "utf-8");

		// Extract and run the shell exactly as the user would copy-paste it.
		const notice = LEGACY_OVERLAY_NOTICE(workDir);
		const match = notice.match(/Move it: `([^`]+)`/);
		expect(match, "LEGACY_OVERLAY_NOTICE shape drift: regex did not match").not.toBeNull();
		const shell = match![1];

		// Rely on Node's default `/bin/sh` — the shell snippet only uses POSIX
		// constructs (`mkdir -p`, `&&`, glob, `rm -rf`). Avoiding an explicit
		// `/bin/bash` keeps the test portable on minimal POSIX hosts and matches
		// the sibling pattern in `outcomes/collectors/workspace-diff.test.ts`.
		execSync(shell, { cwd: workDir, stdio: "ignore" });

		// Post-migration layout: new tree present, legacy tree gone.
		expect(existsSync(join(workDir, ".rpiv", "workflows", "config.ts"))).toBe(true);
		expect(existsSync(join(workDir, ".rpiv", "workflows", "packs", "foo.ts"))).toBe(true);
		expect(existsSync(join(workDir, ".rpiv", "workflows", "packs", "bar.ts"))).toBe(true);
		expect(existsSync(legacyRoot)).toBe(false);

		// Re-run loader: the migrated tree must load cleanly with no legacy
		// notice re-emitted (the `existsSync(.rpiv-workflow)` gate flips false).
		const loaded = await loadWorkflows(workDir);
		expect(loaded.workflows.find((w) => w.name === "from-legacy-config")).toBeDefined();
		expect(loaded.workflows.find((w) => w.name === "foo")).toBeDefined();
		expect(loaded.workflows.find((w) => w.name === "bar")).toBeDefined();
		expect(loaded.issues.some((i) => i.kind === "load" && /\.rpiv-workflow/.test(i.message))).toBe(false);
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
	});

	it("embedded shell removes the legacy dir on a config-only (empty-packs) layout", () => {
		// A project that only ever wrote `.rpiv-workflow/workflows.config.ts` —
		// NO `workflows/` packs subdir. The old `&&`-chained command halted on the
		// packs `mv` (glob never matched) and `rm -rf` never ran, so the warning
		// re-fired forever. The hardened `;`-sequenced command must still clear it.
		const legacyRoot = join(workDir, ".rpiv-workflow");
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(join(legacyRoot, "workflows.config.ts"), legacyConfigBody, "utf-8");

		execSync(extractShell(LEGACY_OVERLAY_NOTICE(workDir)), { cwd: workDir, stdio: "ignore" });

		// Config moved, packs dir created (empty), legacy dir gone — so the
		// `existsSync(.rpiv-workflow)` gate flips false and the warning stops.
		expect(existsSync(join(workDir, ".rpiv", "workflows", "config.ts"))).toBe(true);
		expect(existsSync(legacyRoot)).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("LEGACY_RUNS_NOTICE — embedded migration shell", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-legacy-runs-"));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("embedded shell relocates orphaned top-level run JSONLs into runs/", () => {
		// Run files written before the `runs/` relocation sit directly under
		// `.rpiv/workflows/`. The migration shell must sweep them one level down.
		const workflowsDir = join(workDir, ".rpiv", "workflows");
		mkdirSync(workflowsDir, { recursive: true });
		writeFileSync(join(workflowsDir, "2026-05-01_10-00-00-abcd.jsonl"), "{}\n", "utf-8");
		writeFileSync(join(workflowsDir, "2026-05-02_11-00-00-ef01.jsonl"), "{}\n", "utf-8");

		execSync(extractShell(LEGACY_RUNS_NOTICE(workDir)), { cwd: workDir, stdio: "ignore" });

		expect(existsSync(join(workflowsDir, "runs", "2026-05-01_10-00-00-abcd.jsonl"))).toBe(true);
		expect(existsSync(join(workflowsDir, "runs", "2026-05-02_11-00-00-ef01.jsonl"))).toBe(true);
		expect(existsSync(join(workflowsDir, "2026-05-01_10-00-00-abcd.jsonl"))).toBe(false);
	});
});

describe("unified loop message templates", () => {
	it("MSG_LOOP_ZERO_UNITS warns the loop published nothing", () => {
		expect(MSG_LOOP_ZERO_UNITS("blueprint")).toBe(
			"rpiv: blueprint iterate loop produced zero units — nothing published, advancing",
		);
	});

	it("FAIL_LOOP_CAP_HALT renders the terminal cap wording on both channels", () => {
		expect(FAIL_LOOP_CAP_HALT(5, 5)).toEqual({
			toast: "rpiv: loop cap exceeded (5/5) — stopping workflow to prevent an unbounded loop",
			error: "Loop cap exceeded: 5 units (max 5)",
		});
	});

	it("MSG_LOOP_CAP_ADVANCE renders the soft-stop wording", () => {
		expect(MSG_LOOP_CAP_ADVANCE("breakdown", 8)).toBe(
			"rpiv: breakdown loop reached its cap (8) — projecting the configured result and advancing",
		);
	});

	it("ERR/MSG_RESUME_LOOP_MISMATCH render the drift-refusal wording", () => {
		expect(ERR_RESUME_LOOP_MISMATCH("implement")).toContain(
			'cannot resume — loop stage "implement" recomputed a different unit',
		);
		expect(MSG_RESUME_LOOP_MISMATCH("implement")).toBe(
			'rpiv: loop "implement" changed on resume — cannot safely continue',
		);
	});
});
