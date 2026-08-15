import { type MockInstance, vi } from "vitest";

/**
 * Spy on `process.stdout.write` and pin `process.stdout.isTTY` for one test:
 * the boolean form installs a value descriptor, the function form installs a
 * getter (covers tests where the TTY lookup itself throws). `restore()` undoes
 * both mutations — re-installing the saved own-property descriptor, or deleting
 * `isTTY` entirely when it had none.
 */
export function mockStdout(isTTY: boolean | (() => boolean)): {
	stdoutWrite: MockInstance<typeof process.stdout.write>;
	restore: () => void;
} {
	const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(
		process.stdout,
		"isTTY",
		typeof isTTY === "function" ? { get: isTTY, configurable: true } : { value: isTTY, configurable: true },
	);
	return {
		stdoutWrite,
		restore: () => {
			stdoutWrite.mockRestore();
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		},
	};
}
