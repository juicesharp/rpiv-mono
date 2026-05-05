import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockCtx, createMockPi, stubGitExec } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./package-checks.js", () => ({ findMissingSiblings: vi.fn(() => []) }));
vi.mock("./agents.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./agents.js")>();
	return {
		...actual,
		syncBundledAgents: vi.fn(() => ({
			added: [],
			updated: [],
			unchanged: [],
			removed: [],
			pendingUpdate: [],
			pendingRemove: [],
			errors: [],
		})),
	};
});

import type { SyncResult } from "./agents.js";
import { syncBundledAgents } from "./agents.js";
import { clearGitContextCache, getGitContext, resetInjectedMarker, takeGitContextIfChanged } from "./git-context.js";
import { clearInjectionState } from "./guidance.js";
import { findMissingSiblings } from "./package-checks.js";
import { registerSessionHooks } from "./session-hooks.js";

const emptySync: SyncResult = {
	added: [],
	updated: [],
	unchanged: [],
	removed: [],
	pendingUpdate: [],
	pendingRemove: [],
	errors: [],
};

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "rpiv-session-"));
	clearInjectionState();
	clearGitContextCache();
	resetInjectedMarker();
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("registerSessionHooks — event wiring", () => {
	it("registers 5 events", () => {
		const { pi, captured } = createMockPi();
		registerSessionHooks(pi);
		for (const ev of ["session_start", "session_compact", "session_shutdown", "tool_call", "before_agent_start"]) {
			expect(captured.events.has(ev)).toBe(true);
		}
	});
});

describe("session_start hook", () => {
	it("scaffolds thoughts dirs under ctx.cwd", async () => {
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("session_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await handler?.({ reason: "startup" } as never, ctx as never);
		for (const d of [
			"thoughts/shared/research",
			"thoughts/shared/designs",
			"thoughts/shared/plans",
			"thoughts/shared/handoffs",
			"thoughts/shared/reviews",
		]) {
			expect(existsSync(join(projectDir, d))).toBe(true);
		}
	});
});

describe("session_start hook — notifications", () => {
	it("emits 'Copied N agents' info when added > 0", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce({ ...emptySync, added: ["a.md", "b.md"] });
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Copied 2 rpiv-pi agent/), "info");
	});

	it("emits a single drift line combining pendingUpdate + pendingRemove", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce({
			...emptySync,
			pendingUpdate: ["a.md"],
			pendingRemove: ["b.md", "c.md"],
		});
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		const driftCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].includes("outdated"),
		);
		expect(driftCall).toBeDefined();
		expect(driftCall?.[0]).toContain("1 outdated");
		expect(driftCall?.[0]).toContain("2 removed from bundle");
		expect(driftCall?.[1]).toBe("info");
	});

	it("warns about missing siblings with npm: prefix stripped", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce(emptySync);
		vi.mocked(findMissingSiblings).mockReturnValueOnce([
			{ pkg: "npm:@juicesharp/rpiv-advisor", matches: /./, provides: "x" },
			{ pkg: "npm:@juicesharp/rpiv-args", matches: /./, provides: "y" },
		] as never);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		const warnCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1] === "warning");
		expect(warnCall).toBeDefined();
		expect(warnCall?.[0]).toContain("rpiv-pi requires 2 sibling");
		expect(warnCall?.[0]).toContain("@juicesharp/rpiv-advisor");
		expect(warnCall?.[0]).toContain("@juicesharp/rpiv-args");
		expect(warnCall?.[0]).not.toContain("npm:");
	});

	it("skips notifications when !hasUI", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce({ ...emptySync, added: ["a.md"] });
		vi.mocked(findMissingSiblings).mockReturnValueOnce([
			{ pkg: "npm:@juicesharp/rpiv-todo", matches: /./, provides: "t" },
		] as never);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: false });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("session_compact hook", () => {
	it("re-injects guidance + git-context after compaction (clears caches first)", async () => {
		const exec = stubGitExec({ branch: "main", commit: "abc", user: "alice" });
		const { pi, captured } = createMockPi({ exec: exec as never });
		registerSessionHooks(pi);
		// Prime the git-context cache first via session_start so compact's clear has work to do.
		await captured.events.get("session_start")?.[0](
			{ reason: "startup" } as never,
			createMockCtx({ cwd: projectDir, hasUI: false }) as never,
		);
		const sendBefore = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length;
		await captured.events.get("session_compact")?.[0]({} as never, createMockCtx({ cwd: projectDir }) as never);
		// After compact, the next pi.sendMessage call (from injectGitContext) should fire because
		// resetInjectedMarker + clearGitContextCache make takeGitContextIfChanged re-emit.
		const sendAfter = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length;
		expect(sendAfter).toBeGreaterThan(sendBefore);
	});
});

describe("session_shutdown hook", () => {
	it("clears git-context cache and allows takeGitContextIfChanged to re-emit", async () => {
		const exec = stubGitExec({ branch: "main", commit: "abc", user: "alice" });
		const { pi, captured } = createMockPi({ exec: exec as never });
		registerSessionHooks(pi);
		await takeGitContextIfChanged(pi);
		const callsBefore = exec.mock.calls.length;
		await captured.events.get("session_shutdown")?.[0]({} as never, createMockCtx() as never);
		const reemit = await takeGitContextIfChanged(pi);
		expect(reemit).not.toBeNull();
		expect(exec.mock.calls.length).toBeGreaterThan(callsBefore);
	});
});

describe("tool_call hook", () => {
	it("clears git-context cache on mutating bash command", async () => {
		const exec = stubGitExec({ branch: "main", commit: "a", user: "u" });
		const { pi, captured } = createMockPi({ exec: exec as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("tool_call")?.[0];
		const ctx = createMockCtx({ cwd: projectDir });
		await getGitContext(pi);
		const before = exec.mock.calls.length;
		await handler?.({ toolName: "bash", input: { command: "git commit -m x" } } as never, ctx as never);
		await getGitContext(pi);
		expect(exec.mock.calls.length).toBeGreaterThan(before);
	});
});

describe("before_agent_start hook", () => {
	it("returns {message} on changed git sig", async () => {
		const { pi, captured } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		registerSessionHooks(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir });
		const r = await handler?.({} as never, ctx as never);
		expect(r).toHaveProperty("message");
	});

	it("returns undefined on dedup (signature unchanged)", async () => {
		const { pi, captured } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		registerSessionHooks(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir });
		await handler?.({} as never, ctx as never);
		const second = await handler?.({} as never, ctx as never);
		expect(second).toBeUndefined();
	});
});
