import { createMockPi, stubGitExec } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearGitContextCache,
	getGitContext,
	refreshGitContextForInjection,
	resetInjectedMarker,
	takeGitContextIfChanged,
} from "./git-context.js";

beforeEach(() => {
	clearGitContextCache();
	resetInjectedMarker();
});

describe("getGitContext", () => {
	it("parses branch + commit + user from three exec calls", async () => {
		const { pi } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc1234", user: "alice" }) as never,
		});
		const ctx = await getGitContext(pi);
		expect(ctx).toEqual({ branch: "main", commit: "abc1234", user: "alice" });
	});

	it("remaps literal HEAD to 'detached'", async () => {
		const { pi } = createMockPi({
			exec: stubGitExec({ branch: "HEAD", commit: "abc", user: "alice" }) as never,
		});
		const ctx = await getGitContext(pi);
		expect(ctx?.branch).toBe("detached");
	});

	it("returns null when both branch and commit are empty (not a repo)", async () => {
		const { pi } = createMockPi({ exec: stubGitExec({}) as never });
		expect(await getGitContext(pi)).toBeNull();
	});

	it("falls back to process.env.USER when git config user.name errors", async () => {
		const { pi } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", userError: new Error("no config") }) as never,
		});
		process.env.USER = "env-alice";
		const ctx = await getGitContext(pi);
		expect(ctx?.user).toBe("env-alice");
	});

	it("falls back to 'unknown' when neither git nor env has user", async () => {
		const origUser = process.env.USER;
		delete process.env.USER;
		try {
			const { pi } = createMockPi({
				exec: stubGitExec({ branch: "main", commit: "abc", userError: new Error("x") }) as never,
			});
			const ctx = await getGitContext(pi);
			expect(ctx?.user).toBe("unknown");
		} finally {
			if (origUser) process.env.USER = origUser;
		}
	});

	it("memoises: subsequent calls do not re-exec", async () => {
		const exec = stubGitExec({ branch: "main", commit: "abc", user: "alice" });
		const { pi } = createMockPi({ exec: exec as never });
		await getGitContext(pi);
		await getGitContext(pi);
		expect(exec).toHaveBeenCalledTimes(3); // 3 initial exec calls, no second-round
	});

	it("clearGitContextCache forces re-read", async () => {
		const exec = stubGitExec({ branch: "main", commit: "abc", user: "alice" });
		const { pi } = createMockPi({ exec: exec as never });
		await getGitContext(pi);
		clearGitContextCache();
		await getGitContext(pi);
		expect(exec).toHaveBeenCalledTimes(6);
	});
});

describe("takeGitContextIfChanged", () => {
	it("returns the context-line on first call", async () => {
		const { pi } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		const r = await takeGitContextIfChanged(pi);
		expect(r).toContain("- Branch: main");
		expect(r).toContain("- Commit: abc");
		expect(r).toContain("- User: alice");
	});

	it("returns null on second call when signature unchanged", async () => {
		const { pi } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		await takeGitContextIfChanged(pi);
		expect(await takeGitContextIfChanged(pi)).toBeNull();
	});

	it("force-refreshes after another session consumed the signature", async () => {
		const exec = stubGitExec({ branch: "main", commit: "abc", user: "alice" });
		const { pi } = createMockPi({ exec: exec as never });
		await takeGitContextIfChanged(pi);
		expect(await takeGitContextIfChanged(pi)).toBeNull();
		expect(await refreshGitContextForInjection(pi)).toContain("- Commit: abc");
		expect(exec).toHaveBeenCalledTimes(6);
	});

	it("re-emits after clearGitContextCache + resetInjectedMarker + signature change", async () => {
		const { pi } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		await takeGitContextIfChanged(pi);
		clearGitContextCache();
		resetInjectedMarker();
		const { pi: pi2 } = createMockPi({
			exec: stubGitExec({ branch: "feature", commit: "def", user: "alice" }) as never,
		});
		expect(await takeGitContextIfChanged(pi2)).not.toBeNull();
	});

	it("returns null when not in a git repo", async () => {
		const { pi } = createMockPi({ exec: stubGitExec({}) as never });
		expect(await takeGitContextIfChanged(pi)).toBeNull();
	});
});
