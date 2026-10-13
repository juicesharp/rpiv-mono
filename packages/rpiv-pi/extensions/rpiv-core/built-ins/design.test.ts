import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fs as fsHandle, type ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designOutcome, designParser, designStructure } from "./design.js";
import { designSliceOf } from "./slices.js";

const DESIGN = (sliceN: string) =>
	[
		"---",
		"status: ready",
		`slice_n: ${sliceN}`,
		'topic: "LV-2 — The push-cadence face"',
		"---",
		"",
		"# Design — Slice 3",
		"",
	].join("\n");

describe("designStructure", () => {
	it("matches when the basename token equals slice_n", () => {
		expect(designStructure(".rpiv/artifacts/designs/2026_slice-3_lv-2-the-face.md", { slice_n: 3 })).toEqual({
			filename_slice: "matches",
		});
	});

	// The observed drift: a title that looks like an id (`LV-2`) kebab-cased in
	// place of the `_slice-3_` segment, while `slice_n: 3` was right.
	it("names the expected path when the token is absent", () => {
		const { filename_slice } = designStructure(".rpiv/artifacts/designs/2026_lv-2-the-face.md", { slice_n: 3 });
		expect(filename_slice).toMatch(/carries no 'slice-<N>' token/);
		expect(filename_slice).toContain("_slice-3_");
	});

	it("reports a token that disagrees with slice_n", () => {
		const { filename_slice } = designStructure(".rpiv/artifacts/designs/2026_slice-2_x.md", { slice_n: 3 });
		expect(filename_slice).toMatch(/says slice-2 but frontmatter slice_n is 3/);
	});

	it("reports a missing or non-integer slice_n before judging the filename", () => {
		expect(designStructure("a_slice-3_x.md", {}).filename_slice).toMatch(/slice_n is missing/);
		expect(designStructure("a_slice-3_x.md", { slice_n: "3" }).filename_slice).toMatch(/slice_n is "3"/);
	});
});

describe("designParser", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-design-"));
		mkdirSync(join(cwd, ".rpiv", "artifacts", "designs"), { recursive: true });
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const parse = (rel: string, content: string) => {
		writeFileSync(join(cwd, rel), content);
		return designParser.parse({
			cwd,
			skill: "design-slice",
			artifacts: [{ handle: fsHandle(rel), role: "primary" }],
		} as unknown as ParseContext<undefined>);
	};

	it("merges the derived agreement beside the frontmatter", async () => {
		const result = await parse(".rpiv/artifacts/designs/2026_slice-3_lv-2.md", DESIGN("3"));
		if (result.kind !== "ok") throw new Error(result.message);
		expect(result.payload.data).toMatchObject({ status: "ready", slice_n: 3, filename_slice: "matches" });
	});

	it("lets the derived value win over an authored filename_slice", async () => {
		const result = await parse(
			".rpiv/artifacts/designs/2026_lv-2.md",
			DESIGN("3").replace("status: ready", "status: ready\nfilename_slice: matches"),
		);
		if (result.kind !== "ok") throw new Error(result.message);
		expect(result.payload.data.filename_slice).toMatch(/carries no 'slice-<N>' token/);
	});

	it("keeps the frontmatter parser's fatal when the announced file is missing", async () => {
		const result = await designParser.parse({
			cwd,
			skill: "design-slice",
			artifacts: [{ handle: fsHandle(".rpiv/artifacts/designs/absent.md"), role: "primary" }],
		} as unknown as ParseContext<undefined>);
		expect(result.kind).toBe("fatal");
	});
});

describe("designOutcome", () => {
	it("publishes on the designs channel with the structural parser", () => {
		expect(designOutcome.name).toBe("designs");
		expect(designOutcome.parser).toBe(designParser);
	});
});

describe("designSliceOf", () => {
	it("prefers frontmatter slice_n over the filename token", () => {
		expect(designSliceOf({ slice_n: 3 }, "x_slice-2.md")).toBe(3);
		expect(designSliceOf({ slice_n: "3" }, "x.md")).toBe(3);
	});

	it("falls back to the filename token when data carries no slice_n", () => {
		expect(designSliceOf(undefined, "x_slice-2.md")).toBe(2);
		expect(designSliceOf({ slice_n: 0 }, "x_slice-2.md")).toBe(2);
	});

	it("is undefined when neither carrier names a slice", () => {
		expect(designSliceOf({}, "mystery.md")).toBeUndefined();
	});
});
