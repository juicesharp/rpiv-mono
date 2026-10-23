import { makeSpawnStub } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { spawnPiInstall } from "./pi-installer.ts";

beforeEach(() => {
	vi.mocked(spawn).mockReset();
});

describe("spawnPiInstall — success path", () => {
	it("resolves with exit 0 + buffered stdout/stderr", async () => {
		vi.mocked(spawn).mockImplementationOnce(
			() => makeSpawnStub({ stdout: "installed\n", stderr: "", exitCode: 0 }) as unknown as ReturnType<typeof spawn>,
		);
		const r = await spawnPiInstall("@x/y", 30_000);
		expect(r).toEqual({ code: 0, stdout: "installed\n", stderr: "" });
	});
});

describe("spawnPiInstall — non-zero exit", () => {
	it("returns exit code and accumulated stderr", async () => {
		vi.mocked(spawn).mockImplementationOnce(
			() => makeSpawnStub({ stdout: "", stderr: "fail\n", exitCode: 2 }) as unknown as ReturnType<typeof spawn>,
		);
		const r = await spawnPiInstall("@x/y", 30_000);
		expect(r.code).toBe(2);
		expect(r.stderr).toBe("fail\n");
	});

	it("fallback code=1 when close emits null", async () => {
		const stub = makeSpawnStub({ neverSettles: true });
		vi.mocked(spawn).mockImplementationOnce(() => stub as unknown as ReturnType<typeof spawn>);
		const promise = spawnPiInstall("@x/y", 30_000);
		stub.emit("close", null);
		const r = await promise;
		expect(r.code).toBe(1);
	});
});

describe("spawnPiInstall — error event before close", () => {
	it("settles with code=1 + error.message in stderr", async () => {
		vi.mocked(spawn).mockImplementationOnce(
			() => makeSpawnStub({ error: new Error("ENOENT pi") }) as unknown as ReturnType<typeof spawn>,
		);
		const r = await spawnPiInstall("@x/y", 30_000);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("ENOENT pi");
	});
});

describe("spawnPiInstall — timeout", () => {
	it("kills with SIGTERM at timeout and resolves with code 124", async () => {
		vi.useFakeTimers();
		const stub = makeSpawnStub({ neverSettles: true });
		const killSpy = vi.spyOn(stub, "kill");
		vi.mocked(spawn).mockImplementationOnce(() => stub as unknown as ReturnType<typeof spawn>);
		const promise = spawnPiInstall("@x/y", 30_000);
		await vi.advanceTimersByTimeAsync(30_000);
		vi.useRealTimers();
		const r = await promise;
		expect(killSpy).toHaveBeenCalledWith("SIGTERM");
		expect(r.code).toBe(124);
		expect(r.stderr).toContain("timed out");
	});
});

describe("spawnPiInstall — settle idempotence", () => {
	it("only resolves once even if close fires after timeout", async () => {
		vi.useFakeTimers();
		const stub = makeSpawnStub({ neverSettles: true });
		vi.mocked(spawn).mockImplementationOnce(() => stub as unknown as ReturnType<typeof spawn>);
		const promise = spawnPiInstall("@x/y", 30_000);
		await vi.advanceTimersByTimeAsync(30_000);
		stub.emit("close", 0); // late close — must not replace the timeout result
		vi.useRealTimers();
		const r = await promise;
		expect(r.code).toBe(124);
	});
});

describe("spawnPiInstall — Windows branch", () => {
	it("invokes via cmd.exe /c pi install on win32", async () => {
		const origPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			vi.mocked(spawn).mockImplementationOnce(
				() => makeSpawnStub({ exitCode: 0 }) as unknown as ReturnType<typeof spawn>,
			);
			await spawnPiInstall("@x/y", 30_000);
			const firstCall = vi.mocked(spawn).mock.calls[0];
			expect(firstCall[0]).toBe("cmd.exe");
			expect(firstCall[1]).toEqual(["/c", "pi", "install", "@x/y"]);
		} finally {
			Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
		}
	});
});
