import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

const TERMINATION_GRACE_MS = 1000;

function runEditor(command: string, file: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	// Keep the command grammar identical to Pi's built-in external-editor flow.
	const [editor, ...args] = command.split(" ");
	if (!editor) return Promise.reject(new Error("External editor command is empty"));

	return new Promise((resolve, reject) => {
		// Do not use spawn's signal option: its AbortError precedes process exit.
		const child = spawn(editor, [...args, file], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		let failure: Error | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			// Bound the graceful shutdown period, but never hand the terminal back
			// until close confirms termination. Only this directly owned child is killed.
			escalation = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
			escalation.unref();
			child.kill("SIGTERM");
		};
		// Node emits close after error even for spawn failures. Record the error,
		// but retain terminal/file ownership until that final lifecycle event.
		child.on("error", (error) => {
			failure = error;
		});
		child.once("close", (code, exitSignal) => {
			if (escalation) clearTimeout(escalation);
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) reject(signal.reason);
			else if (failure) reject(failure);
			else if (code === 0) resolve();
			else {
				const reason = exitSignal ? `signal ${exitSignal}` : `exit code ${code ?? "unknown"}`;
				reject(new Error(`External editor exited with ${reason}`));
			}
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

/**
 * Edit a custom answer with Pi's configured external-editor command. The TUI lifecycle
 * and one-trailing-newline normalization intentionally match Pi's main editor flow.
 */
export async function editWithExternalEditor(
	tui: ExternalEditorTui,
	command: string,
	value: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const tempDir = mkdtempSync(join(tmpdir(), "rpiv-ask-user-question-"));
	const tempFile = join(tempDir, "answer.md");
	let tuiStopped = false;

	try {
		writeFileSync(tempFile, value, "utf8");
		tui.stop();
		tuiStopped = true;
		process.stdout.write(`Launching external editor: ${command}\nPi will resume when the editor exits.\n`);
		await runEditor(command, tempFile, signal);
		signal?.throwIfAborted();
		return readFileSync(tempFile, "utf8").replace(/\r?\n$/, "");
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort; never leave the TUI stopped because it failed.
		}
		if (tuiStopped) {
			tui.start();
			tui.requestRender(true);
		}
	}
}
