import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED_VCS_STATUS_ENTRIES, hasJj, seedJjStatusWorkspace } from "@juicesharp/rpiv-test-utils/vcs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vcs from "./vcs.mjs";
import { detect, jjSummaryToStatus, read, readOk, readRaw, statusEntries, statusText } from "./vcs.mjs";

// `vcs.d.mts` is hand-written and `tsconfig.base.json` only includes `*.ts`, so
// the `.mjs` implementation is never type-checked. This list is the only check
// that catches an export added to the `.mjs` without a matching declaration.
const DECLARED_EXPORTS = ["detect", "jjSummaryToStatus", "read", "readOk", "readRaw", "statusEntries", "statusText"];

describe("vcs.mjs", () => {
	it("exports exactly the surface vcs.d.mts declares", () => {
		expect(Object.keys(vcs).sort()).toEqual([...DECLARED_EXPORTS].sort());
	});

	it("maps every jj summary letter into the XY grammar", () => {
		expect(jjSummaryToStatus("M a.ts\nA b.ts\nD c.ts\nR {old.ts => new.ts}\nR dir/{x.ts => y.ts}")).toBe(
			[" M a.ts", "?? b.ts", " D c.ts", " R new.ts", " R dir/y.ts"].join("\n"),
		);
	});

	it("degrades to an empty status and a none backend outside any repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-vcs-none-"));
		try {
			expect(detect(dir).backend).toBe("none");
			expect(statusText(dir, "none")).toBe("");
			expect(statusEntries(dir, "none")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a leading status space in the raw read but trims the plain read", () => {
		const emit = ["-e", "process.stdout.write(' M a.ts\\n')"];
		expect(readRaw("node", emit)).toBe(" M a.ts\n");
		expect(read("node", emit)).toBe("M a.ts");
	});

	it("reports a failed read as not-ok, distinct from an empty one", () => {
		expect(readOk("node", ["-e", "process.exit(1)"])).toEqual({ ok: false, out: "" });
		expect(readOk("node", ["-e", "process.stdout.write('')"])).toEqual({ ok: true, out: "" });
	});

	describe.runIf(hasJj())("jj workspace", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "rpiv-vcs-jj-"));
			seedJjStatusWorkspace(dir);
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		it("detects jj and reports the workspace root", () => {
			const { backend, root } = detect(dir);
			expect(backend).toBe("jj");
			expect(root).not.toBe("");
		});

		it("normalises the working copy into the shared expected entries", () => {
			expect(statusEntries(dir, "jj").sort((a, b) => a.path.localeCompare(b.path))).toEqual(
				[...EXPECTED_VCS_STATUS_ENTRIES].sort((a, b) => a.path.localeCompare(b.path)),
			);
		});

		it("keeps jj's rename on the new side of the braces", () => {
			expect(statusText(dir, "jj")).toContain(" R new.ts");
		});
	});
});
