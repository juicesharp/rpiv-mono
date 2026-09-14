import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

describe("editWithExternalEditor", () => {
	it.each([false, true])("waits for editor exit before restoring the TUI (ignores SIGTERM=%s)", async (ignoreTerm) => {
		const editor = join(fixtureDir, "shutdown-editor.mjs");
		const ready = join(fixtureDir, "ready.json");
		const signalled = join(fixtureDir, "signalled");
		const release = join(fixtureDir, "release");
		const saved = join(fixtureDir, "saved");
		writeFileSync(
			editor,
			`
			import { existsSync, writeFileSync } from 'node:fs';
			const file = process.argv[2];
			process.on('SIGTERM', () => {
				writeFileSync(${JSON.stringify(signalled)}, 'yes');
				if (${ignoreTerm}) return;
				setInterval(() => {
					if (!existsSync(${JSON.stringify(release)})) return;
					writeFileSync(file, 'saved during shutdown');
					writeFileSync(${JSON.stringify(saved)}, 'yes');
					process.exit(0);
				}, 10);
			});
			setInterval(() => {}, 1000);
			writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, file }));
		`,
		);
		const controller = new AbortController();
		let pid = 0;
		const tui = {
			stop: vi.fn(),
			start: vi.fn(() => {
				expect(processExists(pid)).toBe(false);
			}),
			requestRender: vi.fn(),
		};
		let settled = false;
		const pending = editWithExternalEditor(tui, `${process.execPath} ${editor}`, "draft", controller.signal);
		const outcome = pending.then(
			() => {
				settled = true;
				return undefined;
			},
			(error) => {
				settled = true;
				return error;
			},
		);
		try {
			await expect.poll(() => existsSync(ready), { timeout: 5000, interval: 10 }).toBe(true);
			const info: { pid: number; file: string } = JSON.parse(readFileSync(ready, "utf8"));
			pid = info.pid;
			controller.abort();
			await expect.poll(() => existsSync(signalled), { timeout: 5000, interval: 10 }).toBe(true);
			expect(settled).toBe(false);
			expect(tui.start).not.toHaveBeenCalled();
			expect(existsSync(info.file)).toBe(true);
			if (!ignoreTerm) writeFileSync(release, "exit now");
			expect(await outcome).toMatchObject({ name: "AbortError" });
			expect(tui.start).toHaveBeenCalledOnce();
			expect(tui.requestRender).toHaveBeenCalledWith(true);
			expect(processExists(pid)).toBe(false);
			expect(existsSync(info.file)).toBe(false);
			expect(existsSync(saved)).toBe(!ignoreTerm);
		} finally {
			if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
			controller.abort();
			await outcome;
		}
	});

	it("restores the TUI after a spawn failure", async () => {
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
		await expect(editWithExternalEditor(tui, join(fixtureDir, "no-such-editor"), "draft")).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(tui.start).toHaveBeenCalledOnce();
	});

	it("does not stop the TUI or launch an editor for an already-aborted request", async () => {
		const controller = new AbortController();
		controller.abort();
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
		await expect(editWithExternalEditor(tui, "unused", "draft", controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(tui.stop).not.toHaveBeenCalled();
		expect(tui.start).not.toHaveBeenCalled();
	});

	it("aborts the editor process and restores the TUI", async () => {
		const editor = join(fixtureDir, "waiting-editor.mjs");
		writeFileSync(editor, "setInterval(() => {}, 1000);");
		const controller = new AbortController();
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
		const pending = editWithExternalEditor(tui, `${process.execPath} ${editor}`, "draft", controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejected;
		expect(tui.start).toHaveBeenCalledOnce();
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});

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
