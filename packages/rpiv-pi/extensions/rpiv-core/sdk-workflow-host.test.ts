/**
 * sdk-workflow-host tests — the relocated executor-port tripwire +
 * the behavioral contract of the detached host.
 *
 * The satisfaction assertion (`SdkWorkflowHost ⊨ WorkflowHostContext`) lives
 * HERE, not in rpiv-workflow: rpiv-workflow must not import rpiv-pi, so if the
 * executor port drifts, rpiv-pi's `check` fails on the `_executorOk` line.
 *
 * Behavior is verified against a partial mock of `@earendil-works/pi-coding-agent`
 * that stubs `createAgentSession` + `SessionManager` (everything else stays
 * real). The stub session records every call so we can assert the service
 * sourcing, the lane→UI binding, the no-global-setModel model resolution, the
 * fresh-vs-reattach create/open + prompt split, abort/dispose, and distinct
 * concurrent session files.
 */

import type { WorkflowHostContext } from "@juicesharp/rpiv-workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// SDK mock — stub only createAgentSession + SessionManager; spread the rest.
// ---------------------------------------------------------------------------

interface FakeSession {
	sessionId: string;
	sessionFile: string | undefined;
	isStreaming: boolean;
	messages: unknown[];
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	bindExtensions: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	hasExtensionHandlers: ReturnType<typeof vi.fn>;
	extensionRunner: { emit: ReturnType<typeof vi.fn> };
}

const sessions: FakeSession[] = [];
let nextSessionSeq = 0;
// Toggle for the (B) teardown tests: whether a child's runner reports a
// `session_shutdown` handler. Reset to true each test in beforeEach.
let shutdownHandlersPresent = true;

function makeFakeSession(): FakeSession {
	const seq = nextSessionSeq++;
	const s: FakeSession = {
		sessionId: `sid-${seq}`,
		sessionFile: `/run/sessions/sid-${seq}.jsonl`,
		isStreaming: false,
		messages: [],
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		sendUserMessage: vi.fn(async () => {}),
		bindExtensions: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(() => {}),
		hasExtensionHandlers: vi.fn((_event: string) => shutdownHandlersPresent),
		extensionRunner: { emit: vi.fn(async () => ({})) },
	};
	sessions.push(s);
	return s;
}

const createAgentSessionMock = vi.fn(async (_opts: unknown) => ({ session: makeFakeSession() }));
const sessionManagerCreate = vi.fn((_cwd: string, _dir?: string) => ({ kind: "created" }));
const sessionManagerOpen = vi.fn((_file: string, _dir?: string) => ({ kind: "opened" }));

// Captures every DefaultResourceLoader the host builds for a child, so (A) tests
// can inspect the `extensionsOverride` wired into it. `reload()` is a no-op stub
// — no disk discovery in unit tests.
interface CapturedLoader {
	opts: Record<string, unknown>;
}
const resourceLoaders: CapturedLoader[] = [];
const resourceLoaderReload = vi.fn(async () => {});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		createAgentSession: (opts: unknown) => createAgentSessionMock(opts),
		SessionManager: {
			create: (cwd: string, dir?: string) => sessionManagerCreate(cwd, dir),
			open: (file: string, dir?: string) => sessionManagerOpen(file, dir),
		},
		getAgentDir: () => "/agent",
		SettingsManager: { create: () => ({ kind: "settings" }) },
		DefaultResourceLoader: class {
			opts: Record<string, unknown>;
			reload = resourceLoaderReload;
			constructor(opts: Record<string, unknown>) {
				this.opts = opts;
				resourceLoaders.push(this as unknown as CapturedLoader);
			}
		},
	};
});

import {
	CHILD_AMBIENT_EXTENSION_DENYLIST,
	isAmbientChildExtension,
	SdkWorkflowHost,
	type SdkWorkflowHostDeps,
	withoutAmbientExtensions,
} from "./sdk-workflow-host.js";

// ---------------------------------------------------------------------------
// Compile-time executor-port tripwire. If the port drifts, this won't
// compile and rpiv-pi's `check` goes red here (not in rpiv-workflow).
// ---------------------------------------------------------------------------

type Satisfies<Concrete, Port> = Concrete extends Port ? true : false;
const _executorOk: Satisfies<SdkWorkflowHost, WorkflowHostContext> = true;
void _executorOk;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<SdkWorkflowHostDeps> = {}): {
	deps: SdkWorkflowHostDeps;
	notify: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	uiCustom: ReturnType<typeof vi.fn>;
	find: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	const setStatus = vi.fn();
	const uiCustom = vi.fn(async () => ({ answers: [], cancelled: false }));
	const find = vi.fn((provider: string, modelId: string) => ({ provider, id: modelId, _fake: true }));

	const deps = {
		live: {
			hasUI: true,
			ui: { notify, setStatus },
			sessionManager: {
				getBranch: () => [],
				getSessionId: () => "live-session",
				getSessionFile: () => "/live/session.jsonl",
			},
		},
		modelRegistry: { find } as unknown as SdkWorkflowHostDeps["modelRegistry"],
		uiContext: { custom: uiCustom } as unknown as SdkWorkflowHostDeps["uiContext"],
		cwd: "/work",
		runId: "run-abc",
		childSessionsDir: "/run/sessions",
		maxConcurrency: 4,
		...overrides,
	} as SdkWorkflowHostDeps;

	return { deps, notify, setStatus, uiCustom, find };
}

beforeEach(() => {
	sessions.length = 0;
	nextSessionSeq = 0;
	shutdownHandlersPresent = true;
	resourceLoaders.length = 0;
	createAgentSessionMock.mockClear();
	sessionManagerCreate.mockClear();
	sessionManagerOpen.mockClear();
	resourceLoaderReload.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

it("SdkWorkflowHost satisfies the executor port (compile-time assert above)", () => {
	expect(_executorOk).toBe(true);
});

describe("spawnChild — fresh child", () => {
	it("borrows only modelRegistry (authStorage defaulted), supplies a filtered resourceLoader, creates a run-scoped session", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({
			prompt: "/skill:blueprint x",
			lane: "background",
			withSession: async () => "ok",
		});

		expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
		const passed = createAgentSessionMock.mock.calls[0][0] as Record<string, unknown>;
		expect(passed.modelRegistry).toBe(deps.modelRegistry);
		expect(passed).not.toHaveProperty("authStorage");
		// (A) resourceLoader is now SUPPLIED (filtered + reloaded), not omitted.
		expect(passed.resourceLoader).toBeDefined();
		expect(resourceLoaders).toHaveLength(1);
		expect(resourceLoaderReload).toHaveBeenCalledTimes(1);
		expect(typeof resourceLoaders[0].opts.extensionsOverride).toBe("function");
		expect(passed.cwd).toBe("/work");
		expect(sessionManagerCreate).toHaveBeenCalledWith("/work", "/run/sessions");
		expect(sessionManagerOpen).not.toHaveBeenCalled();
	});

	it("sends the initial prompt exactly once and returns the withSession result", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		const result = await host.spawnChild({
			prompt: "/skill:blueprint x",
			lane: "background",
			withSession: async (child) => {
				expect(child.cwd).toBe("/work");
				return 42;
			},
		});

		expect(result).toBe(42);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].prompt).toHaveBeenCalledTimes(1);
		expect(sessions[0].prompt).toHaveBeenCalledWith("/skill:blueprint x");
	});

	it("disposes the child session in finally even when withSession throws", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await expect(
			host.spawnChild({
				prompt: "p",
				lane: "background",
				withSession: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");

		expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
	});
});

describe("spawnChild — lane → UI binding", () => {
	it("foreground binds the real uiContext and the child reports hasUI:true", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		let childHasUI: boolean | undefined;
		await host.spawnChild({
			prompt: "p",
			lane: "foreground",
			withSession: async (child) => {
				childHasUI = child.hasUI;
			},
		});

		expect(sessions[0].bindExtensions).toHaveBeenCalledWith({ uiContext: deps.uiContext });
		expect(childHasUI).toBe(true);
	});

	it("background binds NO uiContext (⇒ noOpUIContext) and the child reports hasUI:false", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		let childHasUI: boolean | undefined;
		await host.spawnChild({
			prompt: "p",
			lane: "background",
			withSession: async (child) => {
				childHasUI = child.hasUI;
			},
		});

		expect(sessions[0].bindExtensions).toHaveBeenCalledWith({ uiContext: undefined });
		expect(childHasUI).toBe(false);
	});
});

describe("spawnChild — model resolution (no global pi.setModel)", () => {
	it("resolves the per-unit model key through the borrowed registry and passes the Model", async () => {
		const { deps, find } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({
			prompt: "p",
			lane: "background",
			model: { model: "anthropic/claude-opus-4-8", thinking: "high" },
			withSession: async () => undefined,
		});

		expect(find).toHaveBeenCalledWith("anthropic", "claude-opus-4-8");
		const passed = createAgentSessionMock.mock.calls[0][0] as Record<string, unknown>;
		expect(passed.model).toEqual({ provider: "anthropic", id: "claude-opus-4-8", _fake: true });
		expect(passed.thinkingLevel).toBe("high");
	});

	it("passes undefined model when no override is given", async () => {
		const { deps, find } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({ prompt: "p", lane: "background", withSession: async () => undefined });

		expect(find).not.toHaveBeenCalled();
		const passed = createAgentSessionMock.mock.calls[0][0] as Record<string, unknown>;
		expect(passed.model).toBeUndefined();
	});
});

describe("spawnChild — reattach", () => {
	it("opens the persisted session and does NOT replay prompt", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({
			prompt: "should-not-be-sent",
			lane: "background",
			reattach: { sessionFile: "/run/sessions/prior.jsonl" },
			withSession: async () => undefined,
		});

		expect(sessionManagerOpen).toHaveBeenCalledWith("/run/sessions/prior.jsonl", "/run/sessions");
		expect(sessionManagerCreate).not.toHaveBeenCalled();
		expect(sessions[0].prompt).not.toHaveBeenCalled();
	});
});

describe("spawnChild — abort", () => {
	it("calls session.abort() on the in-flight child when the signal fires", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);
		const ac = new AbortController();

		await host.spawnChild({
			prompt: "p",
			lane: "background",
			signal: ac.signal,
			withSession: async () => {
				ac.abort();
			},
		});

		expect(sessions[0].abort).toHaveBeenCalledTimes(1);
		// the listener is removed in finally — disposing leaves no dangling handler
		expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
	});
});

describe("concurrency + observer relay", () => {
	it("two concurrent background spawns write distinct session files", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		const [a, b] = await Promise.all([
			host.spawnChild({
				prompt: "a",
				lane: "background",
				withSession: async (c) => c.sessionManager.getSessionFile(),
			}),
			host.spawnChild({
				prompt: "b",
				lane: "background",
				withSession: async (c) => c.sessionManager.getSessionFile(),
			}),
		]);

		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a).not.toBe(b);
		expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
	});

	it("the host delegates sessionManager reads to the live observer (never swaps it)", () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);
		expect(host.sessionManager).toBe(deps.live.sessionManager);
		expect(host.cwd).toBe("/work");
		expect(host.hasUI).toBe(true);
		expect(host.maxConcurrency).toBe(4);
	});

	it("ui relays notify/setStatus to the live observer", () => {
		const { deps, notify, setStatus } = makeDeps();
		const host = new SdkWorkflowHost(deps);
		host.ui.notify("hello", "warning");
		host.ui.setStatus("k", "v");
		expect(notify).toHaveBeenCalledWith("hello", "warning");
		expect(setStatus).toHaveBeenCalledWith("k", "v");
	});
});

// ---------------------------------------------------------------------------
// (A) Children must NOT load launcher-only ambient observer extensions. This is
// the regression guard for the rpiv-warp stale-ctx crash: warp arms a 300ms
// idle timer on agent_end; loading it into a child and then disposing the child
// orphaned that timer, which fired against the invalidated runner reading
// ctx.cwd → uncaughtException.
// ---------------------------------------------------------------------------

describe("child extension filtering (A)", () => {
	const ext = (path: string) => ({ path, resolvedPath: path });

	it("denylists rpiv-warp by path; tool/skill extensions pass", () => {
		expect(CHILD_AMBIENT_EXTENSION_DENYLIST).toContain("rpiv-warp");
		expect(isAmbientChildExtension(ext("/repo/packages/rpiv-warp/index.ts"))).toBe(true);
		expect(isAmbientChildExtension(ext("/x/node_modules/@juicesharp/rpiv-warp/index.ts"))).toBe(true);
		expect(isAmbientChildExtension(ext("/repo/packages/rpiv-ask-user-question/index.ts"))).toBe(false);
		expect(isAmbientChildExtension(ext("/repo/packages/rpiv-web-tools/index.ts"))).toBe(false);
	});

	it("withoutAmbientExtensions drops warp, keeps the rest, and preserves the shared runtime/errors", () => {
		const base = {
			extensions: [ext("/p/rpiv-warp/index.ts"), ext("/p/rpiv-web-tools/index.ts"), ext("/p/rpiv-todo/index.ts")],
			errors: [{ path: "x", error: "e" }],
			runtime: { sentinel: true },
		} as unknown as Parameters<typeof withoutAmbientExtensions>[0];

		const filtered = withoutAmbientExtensions(base);

		expect((filtered.extensions as Array<{ path: string }>).map((e) => e.path)).toEqual([
			"/p/rpiv-web-tools/index.ts",
			"/p/rpiv-todo/index.ts",
		]);
		// non-extension fields pass through by reference (shared runtime must NOT be cloned).
		expect(filtered.runtime).toBe(base.runtime);
		expect(filtered.errors).toBe(base.errors);
	});

	it("the loader spawnChild builds wires withoutAmbientExtensions as its extensionsOverride", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);
		await host.spawnChild({ prompt: "p", lane: "background", withSession: async () => undefined });

		const override = resourceLoaders[0].opts.extensionsOverride as (b: unknown) => {
			extensions: Array<{ path: string }>;
		};
		const out = override({
			extensions: [
				{ path: "rpiv-warp/i.ts", resolvedPath: "rpiv-warp/i.ts" },
				{ path: "rpiv-todo/i.ts", resolvedPath: "rpiv-todo/i.ts" },
			],
			errors: [],
			runtime: {},
		});
		expect(out.extensions.map((e) => e.path)).toEqual(["rpiv-todo/i.ts"]);
	});
});

// ---------------------------------------------------------------------------
// (B) Child teardown emits session_shutdown BEFORE dispose, so extension cleanup
// (timer cancellation, terminal restore) runs while the runner is still live.
// dispose() alone only invalidates the runner — it never fires session_shutdown.
// ---------------------------------------------------------------------------

describe("child teardown (B) — session_shutdown before dispose", () => {
	it("emits session_shutdown then disposes (cleanup precedes runner invalidation)", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({ prompt: "p", lane: "background", withSession: async () => undefined });

		const s = sessions[0];
		expect(s.hasExtensionHandlers).toHaveBeenCalledWith("session_shutdown");
		expect(s.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		expect(s.dispose).toHaveBeenCalledTimes(1);
		const emitOrder = s.extensionRunner.emit.mock.invocationCallOrder[0];
		const disposeOrder = s.dispose.mock.invocationCallOrder[0];
		expect(emitOrder).toBeLessThan(disposeOrder);
	});

	it("still emits shutdown then disposes when withSession throws", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await expect(
			host.spawnChild({
				prompt: "p",
				lane: "background",
				withSession: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");

		const s = sessions[0];
		expect(s.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		expect(s.dispose).toHaveBeenCalledTimes(1);
	});

	it("skips the emit when no session_shutdown handlers exist, but still disposes", async () => {
		shutdownHandlersPresent = false;
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({ prompt: "p", lane: "background", withSession: async () => undefined });

		const s = sessions[0];
		expect(s.hasExtensionHandlers).toHaveBeenCalledWith("session_shutdown");
		expect(s.extensionRunner.emit).not.toHaveBeenCalled();
		expect(s.dispose).toHaveBeenCalledTimes(1);
	});

	it("disposes even if a session_shutdown handler throws (best-effort teardown)", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({
			prompt: "p",
			lane: "background",
			withSession: async (_child) => {
				sessions[0].extensionRunner.emit.mockRejectedValueOnce(new Error("handler blew up"));
			},
		});

		// the rejected shutdown emit is swallowed; dispose still runs.
		expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
	});
});
