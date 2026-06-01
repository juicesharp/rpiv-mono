import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
		cleanupPerCwdAgents: vi.fn(() => ({
			cleanedUp: [],
			skipped: [],
			errors: [],
		})),
	};
});

import type { SyncResult } from "./agents.js";
import { cleanupPerCwdAgents, SYNC_OP, syncBundledAgents } from "./agents.js";
import { clearGitContextCache, getGitContext, resetInjectedMarker, takeGitContextIfChanged } from "./git-context.js";
import { clearInjectionState } from "./guidance.js";
import { findMissingSiblings } from "./package-checks.js";
import { __resetSessionHooksAnnounced, registerSessionHooks } from "./session-hooks.js";

// The exact phrase pi-core's ExtensionRunner throws from an invalidated proxy.
const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. " +
	"Do not use a captured pi or command ctx after ctx.newSession().";

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
	__resetSessionHooksAnnounced();
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("registerSessionHooks — event wiring", () => {
	it("registers 6 events", () => {
		const { pi, captured } = createMockPi();
		registerSessionHooks(pi);
		for (const ev of [
			"session_start",
			"session_compact",
			"session_shutdown",
			"tool_call",
			"before_agent_start",
			"agent_end",
		]) {
			expect(captured.events.has(ev)).toBe(true);
		}
	});
});

describe("session_start hook — migration", () => {
	it("does NOT create .rpiv/artifacts/ on fresh project (no migration source) — issue #31", async () => {
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("session_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await handler?.({ reason: "startup" } as never, ctx as never);
		expect(existsSync(join(projectDir, ".rpiv", "artifacts"))).toBe(false);
	});

	it("migrates thoughts/shared/ to .rpiv/artifacts/ with content preservation", async () => {
		const oldResearch = join(projectDir, "thoughts", "shared", "research");
		mkdirSync(oldResearch, { recursive: true });
		writeFileSync(join(oldResearch, "test.md"), "# Test Research");

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("session_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await handler?.({ reason: "startup" } as never, ctx as never);

		// Content preserved
		expect(existsSync(join(projectDir, ".rpiv", "artifacts", "research", "test.md"))).toBe(true);
		// Old dir removed
		expect(existsSync(join(projectDir, "thoughts", "shared"))).toBe(false);
		// thoughts/ root removed (was empty after shared/ deleted)
		expect(existsSync(join(projectDir, "thoughts"))).toBe(false);
	});

	it("preserves thoughts/ root when non-shared content exists", async () => {
		const oldResearch = join(projectDir, "thoughts", "shared", "research");
		mkdirSync(oldResearch, { recursive: true });
		writeFileSync(join(oldResearch, "test.md"), "content");
		const meDir = join(projectDir, "thoughts", "me");
		mkdirSync(meDir, { recursive: true });
		writeFileSync(join(meDir, "notes.md"), "personal");

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("session_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await handler?.({ reason: "startup" } as never, ctx as never);

		expect(existsSync(join(projectDir, ".rpiv", "artifacts", "research", "test.md"))).toBe(true);
		expect(existsSync(join(projectDir, "thoughts", "shared"))).toBe(false);
		expect(existsSync(join(projectDir, "thoughts", "me", "notes.md"))).toBe(true);
		expect(existsSync(join(projectDir, "thoughts"))).toBe(true);
	});

	it("does NOT create .rpiv/artifacts/ when thoughts/shared/ exists but is empty", async () => {
		// Edge case: thoughts/shared/ pre-exists (created by tool, partial migration, etc.) but holds no entries.
		// Migration must not leak an empty .rpiv/artifacts/ tree, and must not delete the empty source.
		mkdirSync(join(projectDir, "thoughts", "shared"), { recursive: true });

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("session_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await handler?.({ reason: "startup" } as never, ctx as never);

		expect(existsSync(join(projectDir, ".rpiv", "artifacts"))).toBe(false);
		expect(existsSync(join(projectDir, "thoughts", "shared"))).toBe(true);
	});

	it("preserves loose files at thoughts/shared/ root (copies them, not just subdirectories)", async () => {
		// Regression: prior implementation filtered to directories only, dropping loose .md files
		// at the shared/ root on rmSync. Now cpSync copies both files and directories.
		const oldShared = join(projectDir, "thoughts", "shared");
		mkdirSync(oldShared, { recursive: true });
		writeFileSync(join(oldShared, "loose.md"), "loose content");
		const oldResearch = join(oldShared, "research");
		mkdirSync(oldResearch, { recursive: true });
		writeFileSync(join(oldResearch, "nested.md"), "nested content");

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("session_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await handler?.({ reason: "startup" } as never, ctx as never);

		expect(existsSync(join(projectDir, ".rpiv", "artifacts", "loose.md"))).toBe(true);
		expect(existsSync(join(projectDir, ".rpiv", "artifacts", "research", "nested.md"))).toBe(true);
		expect(existsSync(join(projectDir, "thoughts"))).toBe(false);
	});

	it("no-ops when thoughts/shared/ does not exist (fresh project)", async () => {
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const handler = captured.events.get("session_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await handler?.({ reason: "startup" } as never, ctx as never);

		// No migration source → no .rpiv/artifacts/ tree, no thoughts/ tree
		expect(existsSync(join(projectDir, ".rpiv", "artifacts"))).toBe(false);
		expect(existsSync(join(projectDir, "thoughts"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("never crashes session_start even when migration step fails", async () => {
		// ESM module namespaces are not configurable under this Vitest config
		// (see agents.test.ts Q7), so induce the failure at the filesystem layer:
		// chmod 0o000 on thoughts/shared makes the inner readdirSync throw EACCES,
		// hitting the migration's catch block.
		const sharedDir = join(projectDir, "thoughts", "shared");
		const oldResearch = join(sharedDir, "research");
		mkdirSync(oldResearch, { recursive: true });
		writeFileSync(join(oldResearch, "test.md"), "content");

		const originalMode = statSync(sharedDir).mode & 0o777;
		chmodSync(sharedDir, 0o000);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
			registerSessionHooks(pi);
			const handler = captured.events.get("session_start")?.[0];
			const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
			// Must not throw — migration is best-effort
			await expect(handler?.({ reason: "startup" } as never, ctx as never)).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("migration"));
		} finally {
			chmodSync(sharedDir, originalMode);
			warnSpy.mockRestore();
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
		expect((warnCall?.[0] as string).startsWith("\n")).toBe(true);
		expect(warnCall?.[0]).toContain("rpiv-pi: 2 sibling extensions missing");
		expect(warnCall?.[0]).toContain("@juicesharp/rpiv-advisor");
		expect(warnCall?.[0]).toContain("@juicesharp/rpiv-args");
		expect(warnCall?.[0]).toContain("Run /rpiv-setup to install them.");
		expect(warnCall?.[0]).toContain("╭");
		expect(warnCall?.[0]).toContain("╯");
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

	it("I3: emits a 'Synced bundled agent(s)' info combining updated + removed", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce({
			...emptySync,
			updated: ["a.md", "b.md"],
			removed: ["c.md"],
		});
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		const healCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && /Synced bundled/.test(c[0]),
		);
		expect(healCall).toBeDefined();
		expect(healCall?.[0]).toContain("2 updated");
		expect(healCall?.[0]).toContain("1 removed");
		expect(healCall?.[1]).toBe("info");
	});

	it("notifyCleanup: emits 'Cleaned up' info when cleanedUp > 0", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce(emptySync);
		vi.mocked(cleanupPerCwdAgents).mockReturnValueOnce({
			cleanedUp: ["/tmp/old-project/.pi/agents"],
			skipped: [],
			errors: [],
		});
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		const cleanCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && /Cleaned up \d+ per-project agent/.test(c[0]),
		);
		expect(cleanCall).toBeDefined();
		expect(cleanCall?.[1]).toBe("info");
	});

	it("notifyCleanup: emits 'Preserved ...' info with reason summary when skipped > 0", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce(emptySync);
		vi.mocked(cleanupPerCwdAgents).mockReturnValueOnce({
			cleanedUp: [],
			skipped: [{ dir: "/tmp/old-project/.pi/agents", reason: "diverged" }],
			errors: [],
		});
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		const skipCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && /Preserved \d+ per-project agent/.test(c[0]),
		);
		expect(skipCall).toBeDefined();
		expect(skipCall?.[0]).toContain("1 with user edits");
		expect(skipCall?.[1]).toBe("info");
	});

	it("notifyCleanup: emits warning when cleanup errors > 0", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce(emptySync);
		vi.mocked(cleanupPerCwdAgents).mockReturnValueOnce({
			cleanedUp: [],
			skipped: [],
			errors: [{ op: SYNC_OP.REMOVE, message: "EACCES" }],
		});
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		const warnCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => c[1] === "warning" && typeof c[0] === "string" && /Agent cleanup reported/.test(c[0]),
		);
		expect(warnCall).toBeDefined();
		expect(warnCall?.[0]).toContain("1 error");
	});

	it("I3: emits a 'sync errors' warning when result.errors > 0", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce({
			...emptySync,
			errors: [{ op: SYNC_OP.MANIFEST_WRITE, message: "EACCES" }],
		});
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);
		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);
		const errCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1] === "warning");
		expect(errCall).toBeDefined();
		expect(errCall?.[0]).toContain("1 error");
	});
});

describe("session_start hook — banner notify-once latch", () => {
	// Pi fires session_start for every session including programmatic spawns
	// (workflow stages, batch ops). Filesystem work (agent sync, cleanup)
	// runs every fire; the banner notifications latch on the first
	// announcement and stay quiet for the rest of the module lifetime.
	// Replaces the older cross-package coupling to rpiv-workflow's
	// child-session Symbol.

	it("first session_start fires the cleanup/agent-sync/missing-siblings notifies", async () => {
		vi.mocked(syncBundledAgents).mockReturnValueOnce({
			...emptySync,
			added: ["a.md"],
		});
		vi.mocked(cleanupPerCwdAgents).mockReturnValueOnce({ cleanedUp: ["/tmp/old"], skipped: [], errors: [] });
		vi.mocked(findMissingSiblings).mockReturnValueOnce([]);

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });

		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalled();
	});

	it("subsequent session_starts (workflow stage spawns) re-run filesystem work but do NOT re-notify", async () => {
		vi.mocked(syncBundledAgents).mockReturnValue({ ...emptySync, added: ["a.md"] });
		vi.mocked(cleanupPerCwdAgents).mockReturnValue({ cleanedUp: ["/tmp/old"], skipped: [], errors: [] });
		vi.mocked(findMissingSiblings).mockReturnValue([]);

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

		const handler = captured.events.get("session_start")?.[0];
		await handler?.({ reason: "startup" } as never, ctx as never);
		const firstPassNotifyCount = notify.mock.calls.length;
		await handler?.({ reason: "startup" } as never, ctx as never);
		await handler?.({ reason: "startup" } as never, ctx as never);

		// Filesystem work runs every fire (3 session_starts → 3 calls each).
		expect(vi.mocked(syncBundledAgents)).toHaveBeenCalledTimes(3);
		expect(vi.mocked(cleanupPerCwdAgents)).toHaveBeenCalledTimes(3);
		// First pass emits its notifies; passes 2-3 add ZERO new notifies.
		expect(firstPassNotifyCount).toBeGreaterThan(0);
		expect(notify.mock.calls.length).toBe(firstPassNotifyCount);
	});

	it("`__resetSessionHooksAnnounced()` re-arms the latch (covers /reload)", async () => {
		vi.mocked(syncBundledAgents).mockReturnValue({ ...emptySync, added: ["a.md"] });
		vi.mocked(cleanupPerCwdAgents).mockReturnValue({ cleanedUp: [], skipped: [], errors: [] });
		vi.mocked(findMissingSiblings).mockReturnValue([]);

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });

		const handler = captured.events.get("session_start")?.[0];
		await handler?.({ reason: "startup" } as never, ctx as never);
		await handler?.({ reason: "startup" } as never, ctx as never);
		__resetSessionHooksAnnounced();
		await handler?.({ reason: "startup" } as never, ctx as never);

		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// G0 — Integration: real syncBundledAgents through registerSessionHooks
// ─────────────────────────────────────────────────────────────────────────────

describe("G0: session_start → real syncBundledAgents → notifyAgentSyncDrift", () => {
	// Restore the suite-level mock between tests to prevent the real implementation
	// from leaking into adjacent unit tests that depend on the mocked default.
	afterEach(() => {
		vi.mocked(syncBundledAgents).mockReset();
		vi.mocked(syncBundledAgents).mockImplementation(() => emptySync);
	});

	it("on a fresh tmp cwd, copies bundled agents and emits a single 'Copied N agents' info", async () => {
		const real = await vi.importActual<typeof import("./agents.js")>("./agents.js");
		vi.mocked(syncBundledAgents).mockImplementationOnce((apply) => real.syncBundledAgents(apply));

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx as never);

		const agentsDir = join(homedir(), ".pi", "agent", "agents");
		expect(existsSync(agentsDir)).toBe(true);
		expect(existsSync(join(agentsDir, ".rpiv-managed.json"))).toBe(true);
		expect(existsSync(join(agentsDir, ".rpiv-managed.v2"))).toBe(true);

		const addedCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c) => typeof c[0] === "string" && /Copied \d+ rpiv-pi agent/.test(c[0]),
		);
		expect(addedCalls.length).toBe(1);

		const driftCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c) => typeof c[0] === "string" && (c[0].includes("outdated") || c[0].includes("Synced bundled")),
		);
		expect(driftCalls.length).toBe(0);
	});

	it("on a second cold-start, reports unchanged (no Copied / no Synced / no drift)", async () => {
		const real = await vi.importActual<typeof import("./agents.js")>("./agents.js");
		vi.mocked(syncBundledAgents).mockImplementation((apply) => real.syncBundledAgents(apply));

		const { pi, captured } = createMockPi({ exec: stubGitExec({}) as never });
		registerSessionHooks(pi);
		const ctx1 = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx1 as never);

		const ctx2 = createMockCtx({ cwd: projectDir, hasUI: true });
		await captured.events.get("session_start")?.[0]({ reason: "startup" } as never, ctx2 as never);

		const noisyCalls = (ctx2.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c) => typeof c[0] === "string" && /Copied|Synced bundled|outdated|removed from bundle/.test(c[0]),
		);
		expect(noisyCalls.length).toBe(0);
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

	it("swallows a stale-ctx error (compacting session is being replaced)", async () => {
		const { pi, captured } = createMockPi();
		registerSessionHooks(pi);
		const handler = captured.events.get("session_compact")?.[0];
		// pi-core invalidates the runner mid-compaction; ctx.cwd then throws.
		const staleCtx = {
			get cwd(): string {
				throw new Error(STALE_CTX_MESSAGE);
			},
		};
		await expect(handler?.({} as never, staleCtx as never)).resolves.toBeUndefined();
	});

	it("propagates a non-stale error from guidance/git injection", async () => {
		const { pi, captured } = createMockPi();
		registerSessionHooks(pi);
		const handler = captured.events.get("session_compact")?.[0];
		const boomCtx = {
			get cwd(): string {
				throw new Error("boom: real bug in guidance injection");
			},
		};
		await expect(handler?.({} as never, boomCtx as never)).rejects.toThrow("boom");
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
		const r = await handler?.({ prompt: "" } as never, ctx as never);
		expect(r).toHaveProperty("message");
	});

	it("returns undefined on dedup (signature unchanged)", async () => {
		const { pi, captured } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		registerSessionHooks(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir });
		await handler?.({ prompt: "" } as never, ctx as never);
		const second = await handler?.({ prompt: "" } as never, ctx as never);
		expect(second).toBeUndefined();
	});

	it("sets status to 'rpiv: <name>' when prompt contains an owned rpiv-pi skill block", async () => {
		const { pi, captured } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		registerSessionHooks(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir });
		const skillPrompt = `<skill name="discover" location="/some/path">\nbody\n</skill>`;
		await handler?.({ prompt: skillPrompt } as never, ctx as never);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("rpiv-skill", "rpiv: discover");
	});

	it("does not set status for a skill block whose name is not bundled with rpiv-pi", async () => {
		// Foreign / user-supplied skills must not be branded as rpiv: — only names that
		// match a directory under packages/rpiv-pi/skills/ get the rpiv-skill status.
		const { pi, captured } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		registerSessionHooks(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir });
		const skillPrompt = `<skill name="not-an-rpiv-skill" location="/home/u/.pi/skills/not-an-rpiv-skill">\nbody\n</skill>`;
		await handler?.({ prompt: skillPrompt } as never, ctx as never);
		const setStatusCalls = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c) => c[0] === "rpiv-skill",
		);
		expect(setStatusCalls).toHaveLength(0);
	});

	it("does not set status when prompt has no skill block", async () => {
		const { pi, captured } = createMockPi({
			exec: stubGitExec({ branch: "main", commit: "abc", user: "alice" }) as never,
		});
		registerSessionHooks(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ cwd: projectDir });
		await handler?.({ prompt: "just a normal chat message" } as never, ctx as never);
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
	});
});

describe("agent_end hook", () => {
	it("clears the rpiv-skill status", async () => {
		const { pi, captured } = createMockPi();
		registerSessionHooks(pi);
		const handler = captured.events.get("agent_end")?.[0];
		const ctx = createMockCtx();
		await handler?.({ messages: [] } as never, ctx as never);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("rpiv-skill", undefined);
	});
});
