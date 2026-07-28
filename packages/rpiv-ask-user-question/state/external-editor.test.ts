import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editWithExternalEditor } from "./external-editor.js";

let fixtureDir: string;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "rpiv-external-editor-test-"));
	stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	stdout.mockRestore();
	rmSync(fixtureDir, { recursive: true, force: true });
});

describe("editWithExternalEditor", () => {
	it("round-trips the temp file and restores the TUI after the editor exits", async () => {
		const editor = join(fixtureDir, "editor.mjs");
		writeFileSync(
			editor,
			'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "edited answer\\n");',
		);
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };

		const result = await editWithExternalEditor(tui, `${process.execPath} ${editor}`, "draft");

		expect(result).toBe("edited answer");
		expect(tui.stop).toHaveBeenCalledOnce();
		expect(tui.start).toHaveBeenCalledOnce();
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});

	it("restores the TUI and rejects when the editor exits unsuccessfully", async () => {
		const editor = join(fixtureDir, "failing-editor.mjs");
		writeFileSync(editor, "process.exit(7);");
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };

		await expect(editWithExternalEditor(tui, `${process.execPath} ${editor}`, "draft")).rejects.toThrow(
			"exit code 7",
		);
		expect(tui.start).toHaveBeenCalledOnce();
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});
});
