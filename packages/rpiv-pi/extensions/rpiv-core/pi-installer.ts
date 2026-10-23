/**
 * Windows-safe wrapper around `pi install <pkg>`.
 *
 * Pi's own `pi.exec` calls `child_process.spawn(cmd, args, { shell: false })`,
 * which cannot launch `.cmd`/`.bat` shims on Windows — npm installs `pi` as
 * `pi.cmd`, so on Windows the spawn ENOENTs silently and the caller sees only
 * `exit 1`. We side-step it here by invoking via `cmd.exe /c` on Windows.
 */

import { spawn } from "node:child_process";
import { EXIT_TIMEOUT, SIGKILL_GRACE_MS } from "./constants.ts";

export interface PiInstallResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function spawnPiInstall(pkg: string, timeoutMs: number): Promise<PiInstallResult> {
	return new Promise((resolve) => {
		const isWindows = process.platform === "win32";
		const [cmd, args, spawnOpts] = isWindows
			? (["cmd.exe", ["/c", "pi", "install", pkg], { windowsHide: true }] as const)
			: (["pi", ["install", pkg], {}] as const);

		let settled = false;
		let stdout = "";
		let stderr = "";

		const proc = spawn(cmd, args, { ...spawnOpts, stdio: ["ignore", "pipe", "pipe"] });
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});

		const settle = (result: PiInstallResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, SIGKILL_GRACE_MS);
			settle({ code: EXIT_TIMEOUT, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` });
		}, timeoutMs);

		proc.on("error", (err) => {
			settle({ code: 1, stdout, stderr: stderr + (stderr ? "\n" : "") + err.message });
		});
		proc.on("close", (code) => {
			settle({ code: code ?? 1, stdout, stderr });
		});
	});
}
