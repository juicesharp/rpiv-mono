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
 * sourcing, the deferring-relay UI binding, the no-global-setModel model resolution, the
 * fresh-vs-reattach create/open + prompt split, abort/dispose, and distinct
 * concurrent session files.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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
	// Present so a FakeSession structurally satisfies the registry's LaneSession
	// (the viewer's transcript source) — the host registers `session` verbatim.
	sessionManager: { getBranch: ReturnType<typeof vi.fn>; getCwd: ReturnType<typeof vi.fn> };
	getToolDefinition: ReturnType<typeof vi.fn>;
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
		sessionManager: { getBranch: vi.fn(() => []), getCwd: vi.fn(() => "/work") },
		getToolDefinition: vi.fn(() => undefined),
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

import { __resetRunLaneRegistry, getLane, type LaneSession, recordRun, retireRun } from "./run-lane-registry.js";
import {
	AMBIENT_OBSERVER_MANIFEST_FLAG,
	CHILD_AMBIENT_EXTENSION_DENYLIST,
	FanoutDepthExceededError,
	isAmbientChildExtension,
	MAX_FANOUT_DEPTH,
	readPiManifestFlag,
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
	uiNotify: ReturnType<typeof vi.fn>;
	find: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	const setStatus = vi.fn();
	const uiCustom = vi.fn(async () => ({ answers: [], cancelled: false }));
	// The launcher uiContext (every child binds it via the relay) — its
	// notify is what the relay toasts through on a deferred questionnaire.
	const uiNotify = vi.fn();
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
		uiContext: { custom: uiCustom, notify: uiNotify } as unknown as SdkWorkflowHostDeps["uiContext"],
		cwd: "/work",
		runId: "run-abc",
		childSessionsDir: "/run/sessions",
		maxConcurrency: 4,
		...overrides,
	} as SdkWorkflowHostDeps;

	return { deps, notify, setStatus, uiCustom, uiNotify, find };
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
	__resetRunLaneRegistry();
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
				withSession: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");

		expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
	});
});

describe("spawnChild — UI binding (deferring relay)", () => {
	it("binds the DEFERRING relay (its custom enqueues, does not hit the real ctx) and the child inherits hasUI from the live ctx", async () => {
		// Record the run so the relay's custom can enqueue into a live lane (Slice 7/FR5).
		recordRun("run-abc", "ship");
		const { deps, uiCustom, uiNotify } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		let childHasUI: boolean | undefined;
		await host.spawnChild({
			prompt: "p",
			withSession: async (child) => {
				childHasUI = child.hasUI;
			},
		});

		expect(childHasUI).toBe(true); // inherits live.hasUI (true in makeDeps)
		const boundArg = sessions[0].bindExtensions.mock.calls[0][0] as { uiContext?: ExtensionUIContext };
		// A relay, NOT the raw uiContext — it forwards everything but `custom`.
		expect(boundArg.uiContext).toBeDefined();
		expect(boundArg.uiContext).not.toBe(deps.uiContext);

		// Its `custom` DEFERS: calling it enqueues the questionnaire into the lane and
		// returns a pending promise — it must NOT reach the real ctx.ui.custom.
		const factory = (() => ({})) as never;
		void boundArg.uiContext?.custom(factory, undefined as never);
		expect(getLane("run-abc")?.pendingInput).toHaveLength(1);
		expect(getLane("run-abc")?.pendingInput[0].factory).toBe(factory);
		expect(uiCustom).not.toHaveBeenCalled();
		// Deferring is silent at root: the enqueue notifies the registry (the always-on
		// dock surfaces ⚑), so the relay fires NO redundant chat toast.
		expect(uiNotify).not.toHaveBeenCalled();
	});

	it("still binds the relay but reports hasUI:false under a headless launcher (live.hasUI:false) so UI tools degrade", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost({ ...deps, live: { ...deps.live, hasUI: false } });

		let childHasUI: boolean | undefined;
		await host.spawnChild({
			prompt: "p",
			withSession: async (child) => {
				childHasUI = child.hasUI;
			},
		});

		// The relay is bound unconditionally, but hasUI follows the live ctx — a headless
		// launcher yields hasUI:false, so ask_user_question degrades instead of parking
		// on a dock nobody can answer.
		const boundArg = sessions[0].bindExtensions.mock.calls[0][0] as { uiContext?: ExtensionUIContext };
		expect(boundArg.uiContext).toBeDefined();
		expect(childHasUI).toBe(false);
	});
});

describe("spawnChild — model resolution (no global pi.setModel)", () => {
	it("resolves the per-unit model key through the borrowed registry and passes the Model", async () => {
		const { deps, find } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({
			prompt: "p",
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

		await host.spawnChild({ prompt: "p", withSession: async () => undefined });

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
				withSession: async (c) => c.sessionManager.getSessionFile(),
			}),
			host.spawnChild({
				prompt: "b",
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
		await host.spawnChild({ prompt: "p", withSession: async () => undefined });

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

		await host.spawnChild({ prompt: "p", withSession: async () => undefined });

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

		await host.spawnChild({ prompt: "p", withSession: async () => undefined });

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
			withSession: async (_child) => {
				sessions[0].extensionRunner.emit.mockRejectedValueOnce(new Error("handler blew up"));
			},
		});

		// the rejected shutdown emit is swallowed; dispose still runs.
		expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// (L0-06) Nested fan-out is depth-bounded. A child carries the full executor
// surface, so a skill in a child could recurse fanout → spawnChild forever; the
// guard caps it and rejects BEFORE a child session is created.
// ---------------------------------------------------------------------------

describe("spawnChild — nested fan-out depth guard", () => {
	it("allows nesting up to MAX_FANOUT_DEPTH", async () => {
		expect(MAX_FANOUT_DEPTH).toBe(2);
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		// depth 0 → 1 → 2 (== cap), all succeed
		const result = await host.spawnChild({
			prompt: "p",
			withSession: (c1) =>
				c1.spawnChild({
					prompt: "p",
					withSession: (c2) => c2.spawnChild({ prompt: "p", withSession: async () => "deep-ok" }),
				}),
		});

		expect(result).toBe("deep-ok");
		expect(createAgentSessionMock).toHaveBeenCalledTimes(3); // one per allowed level
	});

	it("rejects beyond MAX_FANOUT_DEPTH with a typed FanoutDepthExceededError, no over-deep child session", async () => {
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		// Capture the rejection ONCE (a second spawn would double the session count).
		const err = await host
			.spawnChild({
				prompt: "p",
				withSession: (c1) =>
					c1.spawnChild({
						prompt: "p",
						withSession: (c2) =>
							c2.spawnChild({
								prompt: "p",
								withSession: (c3) => c3.spawnChild({ prompt: "p", withSession: async () => "too-deep" }),
							}),
					}),
			})
			.then(
				() => undefined,
				(e) => e,
			);

		// Typed (not a bare Error) so a catcher distinguishes a host POLICY violation
		// from an unexpected worker bug; carries the offending depth + cap.
		expect(err).toBeInstanceOf(FanoutDepthExceededError);
		expect(err).toMatchObject({ depth: 3, max: MAX_FANOUT_DEPTH });
		expect((err as Error).message).toMatch(/nested fan-out depth/i);

		// depths 0,1,2 created sessions (3); depth 3 threw before createAgentSession.
		expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
	});
});

// ---------------------------------------------------------------------------
// (L0-04) Self-declared ambient-observer manifest marker. A sibling opts itself
// out of child loading via `pi.ambientObserver:true` in its package.json, read
// pre-factory from resolvedPath. The name denylist is a transitional backstop.
// ---------------------------------------------------------------------------

describe("ambient-observer manifest marker (L0-04)", () => {
	let tmp: string;
	afterEach(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it("readPiManifestFlag reads pi.<flag> from the nearest package.json (fail-soft otherwise)", () => {
		tmp = mkdtempSync(join(tmpdir(), "rpiv-marker-"));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", pi: { ambientObserver: true } }));
		expect(readPiManifestFlag(join(tmp, "nested", "index.ts"), AMBIENT_OBSERVER_MANIFEST_FLAG)).toBe(true);
		// A path with no resolvable manifest fails soft.
		expect(readPiManifestFlag("/nonexistent/deep/index.ts", AMBIENT_OBSERVER_MANIFEST_FLAG)).toBe(false);
		expect(readPiManifestFlag("", AMBIENT_OBSERVER_MANIFEST_FLAG)).toBe(false);
	});

	it("isAmbientChildExtension honors the marker regardless of package name", () => {
		tmp = mkdtempSync(join(tmpdir(), "rpiv-marker-"));
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "rpiv-totally-fine", pi: { ambientObserver: true } }),
		);
		const resolvedPath = join(tmp, "index.ts");
		// Marked → filtered, even though the name is NOT on the denylist.
		expect(isAmbientChildExtension({ path: resolvedPath, resolvedPath })).toBe(true);
	});

	it("falls back to the name denylist for a marker-less extension", () => {
		// Synthetic paths resolve no real package.json → marker false → denylist decides.
		expect(
			isAmbientChildExtension({
				path: "/repo/packages/rpiv-warp/index.ts",
				resolvedPath: "/repo/packages/rpiv-warp/index.ts",
			}),
		).toBe(true);
		expect(
			isAmbientChildExtension({
				path: "/repo/packages/rpiv-todo/index.ts",
				resolvedPath: "/repo/packages/rpiv-todo/index.ts",
			}),
		).toBe(false);
	});

	it("the real rpiv-warp package.json declares the ambientObserver marker", () => {
		const warpPkg = fileURLToPath(new URL("../../../rpiv-warp/package.json", import.meta.url));
		const pkg = JSON.parse(readFileSync(warpPkg, "utf8")) as { pi?: { ambientObserver?: boolean } };
		expect(pkg.pi?.ambientObserver).toBe(true);
		// And rpiv-pi's own package (the launcher) is NOT marked.
		const selfPkg = fileURLToPath(new URL("../../package.json", import.meta.url));
		const self = JSON.parse(readFileSync(selfPkg, "utf8")) as { pi?: { ambientObserver?: boolean } };
		expect(self.pi?.ambientObserver ?? false).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (Slice 2) Retain the run's currently-live child as the viewer's transcript
// source (FR1): set-on-spawn / clear-on-teardown, plus the fanout ownership
// guard (a sibling's teardown must not clobber a later-spawned sibling).
// ---------------------------------------------------------------------------

describe("spawnChild — lane current-session retention (Slice 2)", () => {
	it("points the lane at the live child during the stage and clears it on teardown", async () => {
		recordRun("run-abc", "ship");
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		let liveDuringStage: LaneSession | undefined;
		await host.spawnChild({
			prompt: "p",
			withSession: async () => {
				liveDuringStage = getLane("run-abc")?.currentSession;
			},
		});

		// The lane exposed a STREAMING VIEW over the live child — same session identity, now
		// carrying the getStreamingMessage accessor; after the finally it's cleared.
		expect(liveDuringStage?.sessionId).toBe(sessions[0].sessionId);
		expect(typeof liveDuringStage?.getStreamingMessage).toBe("function");
		expect(getLane("run-abc")?.currentSession).toBeUndefined();
	});

	it("a sibling's teardown does NOT clobber a later-spawned sibling's currentSession", async () => {
		recordRun("run-abc", "ship");
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		// Sequence two concurrent siblings deterministically: A is created first
		// (slot = A), then B (slot = B, the latest-spawned owner). A then tears down
		// while B is still live — its teardown must leave B's ownership intact.
		let aReached!: () => void;
		const aReachedP = new Promise<void>((r) => (aReached = r));
		let releaseA!: () => void;
		const aMayReturn = new Promise<void>((r) => (releaseA = r));
		let bReached!: () => void;
		const bReachedP = new Promise<void>((r) => (bReached = r));
		let releaseB!: () => void;
		const bMayReturn = new Promise<void>((r) => (releaseB = r));

		const aP = host.spawnChild({
			prompt: "a",
			withSession: async () => {
				aReached();
				await aMayReturn;
			},
		});
		await aReachedP; // A created → slot = sessions[0]

		const bP = host.spawnChild({
			prompt: "b",
			withSession: async () => {
				bReached();
				await bMayReturn;
			},
		});
		await bReachedP; // B created → slot = sessions[1] (latest-spawned wins)

		expect(getLane("run-abc")?.currentSession?.sessionId).toBe(sessions[1].sessionId);

		// A tears down while B is still live — the identity guard skips the clear.
		releaseA();
		await aP;
		expect(getLane("run-abc")?.currentSession?.sessionId).toBe(sessions[1].sessionId);

		// B (the owner) tears down → it clears the slot.
		releaseB();
		await bP;
		expect(getLane("run-abc")?.currentSession).toBeUndefined();
	});

	it("setCurrentSession before the run is recorded is a no-op (Phase 2 may land before Phase 3 records)", async () => {
		// deps.runId ("run-abc") is intentionally NOT recorded.
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await expect(host.spawnChild({ prompt: "p", withSession: async () => "ok" })).resolves.toBe("ok");

		// No lane was created as a side effect; setCurrentSession silently ignored it.
		expect(getLane("run-abc")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (Problem 2) The transcript snapshot must be captured WHILE the child session is
// alive — in the per-stage finally, before currentSession is dropped + the session
// disposed — so the runner's later onWorkflowEnd → retireRun (which sees no live
// session) keeps a viewable transcript instead of snapshotting undefined.
// ---------------------------------------------------------------------------

describe("spawnChild — final snapshot + session file (Problem 2)", () => {
	const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } }];

	it("captures finalBranch before teardown; a post-teardown retire preserves it", async () => {
		recordRun("run-abc", "ship");
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({
			prompt: "p",
			withSession: async () => {
				// The child's branch is non-empty by the time the stage finishes.
				sessions[0].sessionManager.getBranch.mockReturnValue(branch);
			},
		});

		// The finally cleared the live session but captured the snapshot first.
		const lane = getLane("run-abc");
		expect(lane?.currentSession).toBeUndefined();
		expect(lane?.finalBranch).toEqual(branch);
		expect(lane?.finalCwd).toBe("/work");

		// The runner's terminal onWorkflowEnd fires AFTER teardown, with no live session —
		// it must NOT clobber the captured snapshot (the original Problem 2 bug).
		retireRun("run-abc", "completed");
		expect(getLane("run-abc")?.finalBranch).toEqual(branch);
	});

	it("records lastSessionFile from the child's sessionFile (durable disk-fallback seed)", async () => {
		recordRun("run-abc", "ship");
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		await host.spawnChild({ prompt: "p", withSession: async () => undefined });

		expect(getLane("run-abc")?.lastSessionFile).toBe(sessions[0].sessionFile);
	});

	it("a sibling's teardown seeds lastSessionFile from the last-living owner, not an arbitrary sibling", async () => {
		recordRun("run-abc", "ship");
		const { deps } = makeDeps();
		const host = new SdkWorkflowHost(deps);

		// Same deterministic two-sibling sequencing as the currentSession guard test:
		// A created first (slot = A), then B (slot = B, the latest-spawned owner).
		let aReached!: () => void;
		const aReachedP = new Promise<void>((r) => (aReached = r));
		let releaseA!: () => void;
		const aMayReturn = new Promise<void>((r) => (releaseA = r));
		let bReached!: () => void;
		const bReachedP = new Promise<void>((r) => (bReached = r));
		let releaseB!: () => void;
		const bMayReturn = new Promise<void>((r) => (releaseB = r));

		const aP = host.spawnChild({
			prompt: "a",
			withSession: async () => {
				aReached();
				await aMayReturn;
			},
		});
		await aReachedP; // A created → slot = sessions[0]

		const bP = host.spawnChild({
			prompt: "b",
			withSession: async () => {
				bReached();
				await bMayReturn;
			},
		});
		await bReachedP; // B created → slot = sessions[1] (latest-spawned owner)

		// A tears down while B is still live — guard false, so A seeds NOTHING.
		// (Under the old spawn-time write this would already be sessions[1].)
		releaseA();
		await aP;
		expect(getLane("run-abc")?.lastSessionFile).toBeUndefined();

		// B (the slot owner) tears down → seeds lastSessionFile from its own file,
		// coherent with the finalBranch snapshot captured in the same guard block.
		releaseB();
		await bP;
		expect(getLane("run-abc")?.lastSessionFile).toBe(sessions[1].sessionFile);
	});
});
