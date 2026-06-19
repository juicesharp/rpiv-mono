import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type {
	ExecutionLane,
	ModelSelection,
	WorkflowHostContext,
	WorkflowSessionContext,
} from "@juicesharp/rpiv-workflow";
import { vi } from "vitest";

/**
 * The mock command ctx satisfies BOTH Pi's `ExtensionCommandContext` (so tests
 * reading `model`/`modelRegistry`/etc. keep working) AND rpiv-workflow's
 * post-detachment host port (`spawnChild`/`maxConcurrency`), so consumers can
 * cast `mockCtx as WorkflowHostContext` with a plain assertion. The shape is
 * synthesized via `as unknown as` — the type is the contract, not the literal.
 */
type MockWorkflowCtx = ExtensionCommandContext & WorkflowHostContext;

/** Options the runtime hands `spawnChild` — mirrors the rpiv-workflow host port. */
interface MockSpawnChildOptions<T = void> {
	prompt: string;
	lane: ExecutionLane;
	model?: ModelSelection;
	signal?: AbortSignal;
	reattach?: { sessionFile: string };
	fork?: { sessionFile: string };
	withSession: (child: WorkflowSessionContext) => Promise<T>;
}

/** A captured `registerShortcut` registration (KeyId → handler). */
export interface CapturedShortcut {
	description?: string;
	handler: (ctx: unknown) => Promise<void> | void;
}

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	/** Keyboard shortcuts registered via `pi.registerShortcut(keyId, opts)`. */
	shortcuts: Map<string, CapturedShortcut>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
	allTools: ToolInfo[];
}

export interface MockPi {
	pi: ExtensionAPI;
	captured: CapturedPi;
}

export interface CreateMockPiOptions extends Partial<ExtensionAPI> {
	/**
	 * Skill names to surface from `getCommands()` as `RegisteredCommand`s with
	 * `source: "skill"` (matching the shape Pi emits from
	 * `agent-session.js:1699` — `name` prefixed with `"skill:"`, `source`
	 * `"skill"`). Lets tests of programmatic `/skill:<name>` dispatch (the
	 * `rpiv-workflow` runner gates dispatch on this registry to prevent
	 * raw-text leakage to the LLM) register the skills their workflow uses
	 * without hand-rolling RegisteredCommand objects.
	 *
	 * Overridden completely by a `getCommands` override in the same call —
	 * `getCommands` takes precedence when both are present.
	 */
	skills?: readonly string[];
}

export function createMockPi(options: CreateMockPiOptions = {}): MockPi {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
	};

	const { skills, ...overrides } = options;
	const skillCommands: RegisteredCommand[] = (skills ?? []).map(
		(name) =>
			({
				name: `skill:${name}`,
				source: "skill",
				sourceInfo: { path: `/mock/skills/${name}/SKILL.md`, baseDir: `/mock/skills/${name}` },
			}) as unknown as RegisteredCommand,
	);

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, cmd);
		}),
		registerShortcut: vi.fn((shortcut: string, opts: CapturedShortcut) => {
			captured.shortcuts.set(shortcut, opts);
		}),
		registerFlag: vi.fn((name: string, value: unknown) => {
			captured.flags.set(name, value);
		}),
		getFlag: vi.fn((name: string) => captured.flags.get(name)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const list = captured.events.get(event) ?? [];
			list.push(handler);
			captured.events.set(event, list);
		}),
		sendMessage: vi.fn(async () => {}),
		sendUserMessage: vi.fn((_content: unknown, _options?: unknown) => {
			// Sync fire-and-forget in production; mock captures nothing extra.
			// Tests assert on sentMessages via the chain or directly on this spy.
		}),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium" as unknown as string),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const list = captured.eventsEmitted.get(channel) ?? [];
				list.push(data);
				captured.eventsEmitted.set(channel, list);
			}),
			on: vi.fn(() => () => {}),
		},
		// Default skill registry: just the user-passed `skills` list. Tests
		// that need a custom getCommands can still pass one via overrides
		// (it'll replace this default via the spread below).
		getCommands: vi.fn(() => skillCommands),
		...overrides,
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

export interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWorkingMessage: ReturnType<typeof vi.fn>;
	setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
	onTerminalInput: ReturnType<typeof vi.fn>;
	pasteToEditor: ReturnType<typeof vi.fn>;
}

export function createMockUI(overrides: Partial<ExtensionUIContext> = {}): MockUI {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		pasteToEditor: vi.fn(),
		...overrides,
	} as unknown as MockUI;
}

export function createMockSessionManager(branch: SessionEntry[] = []) {
	return {
		getBranch: vi.fn(() => branch),
		getEntries: vi.fn(() => branch),
		getLeafId: vi.fn(() => (branch.length ? branch[branch.length - 1].id : null)),
		getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
		getSessionId: vi.fn(() => "test-session"),
	};
}

export function createMockModelRegistry(models: Model<Api>[] = []) {
	return {
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => [...models]),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
	};
}

export interface MockCtxOptions {
	hasUI?: boolean;
	cwd?: string;
	model?: Model<Api>;
	branch?: SessionEntry[];
	models?: Model<Api>[];
	ui?: Partial<ExtensionUIContext>;
	/** Background-lane concurrency cap the ctx advertises. Defaults to 1 (sequential). */
	maxConcurrency?: number;
}

export function createMockCtx(opts: MockCtxOptions = {}): ExtensionContext {
	return {
		hasUI: opts.hasUI ?? false,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		model: opts.model,
		ui: createMockUI(opts.ui),
		sessionManager: createMockSessionManager(opts.branch ?? []),
		modelRegistry: createMockModelRegistry(opts.models ?? []),
		isIdle: vi.fn(() => true),
	} as unknown as ExtensionContext;
}

/**
 * Minimal command ctx mock for unit tests that mock the runner (or otherwise
 * never spawn a child for real). Adds `waitForIdle`, `maxConcurrency`, and a
 * `spawnChild` `vi.fn` that synthesizes a guaranteed-in-session child ctx
 * (carrying `sendUserMessage`) and runs `withSession` on it — the PARENT ctx
 * STAYS VALID (no swap). Tests can still assert spawn accounting via
 * `expect(ctx.spawnChild).not.toHaveBeenCalled()`.
 *
 * For tests that DO drive a scripted sequence of child sessions, use
 * `createMockSessionChain` — it scripts a queue of responses, one per spawned
 * child.
 */
export function createMockCommandCtx(opts: MockCtxOptions = {}): MockWorkflowCtx {
	const base = createMockCtx(opts);
	const spawnChild = vi.fn(async <T>(options: MockSpawnChildOptions<T>): Promise<T> => {
		const child = {
			...createMockCtx(opts),
			waitForIdle: vi.fn(async () => {}),
			maxConcurrency: opts.maxConcurrency ?? 1,
			sendUserMessage: vi.fn(async () => {}),
			spawnChild: vi.fn(),
		} as unknown as WorkflowSessionContext;
		return options.withSession(child);
	});
	return {
		...base,
		waitForIdle: vi.fn(async () => {}),
		maxConcurrency: opts.maxConcurrency ?? 1,
		spawnChild,
	} as unknown as MockWorkflowCtx;
}

// ---------------------------------------------------------------------------
// Session chain fixture — for tests that drive runWorkflow/runStage/runImplementPhases
// across multiple spawnChild() calls. The outer ctx and every child share a
// single scripted queue; pop order is the order in which the production code
// spawns children. The parent ctx STAYS VALID — children never swap it out.
// ---------------------------------------------------------------------------

/** One scripted response in a session chain — one spawned child session. */
export interface MockSessionStep {
	/**
	 * Branch entries the child's sessionManager.getBranch() will return inside
	 * withSession. Each element should be a BranchEntry-shaped object (e.g.
	 * built with `mockAssistantMessage`).
	 */
	branch?: unknown[];
	/**
	 * If true, this child's `spawnChild` REJECTS without invoking withSession —
	 * the dispatcher treats a rejection as an unfilled slot (the detached
	 * replacement for the old `{ cancelled: true }` return, which had no
	 * live-session swap to dismiss). Mutually exclusive with `branch`.
	 */
	cancelled?: boolean;
	/**
	 * The on-disk session file this child's `getSessionFile()` reports. Used by
	 * `sessionPolicy: "continue"` tests: a stage's recorded `SessionRef.file` must
	 * point at a REAL file so `locateSessionFile` resolves it and the next
	 * continue stage forks it. Write the file yourself (a one-line JSONL header is
	 * enough). Default: the shared `/tmp/test-session.jsonl` stub.
	 */
	sessionFile?: string;
}

export interface MockSessionChainOptions extends MockCtxOptions {
	/** Scripted responses, in the order spawnChild will consume them. */
	steps: MockSessionStep[];
	/** Optional mock pi — if provided, the chain exposes it for "continue" path assertions. */
	pi?: ExtensionAPI;
	/**
	 * Pre-populated branch entries for the outer ctx. Used in "continue" path
	 * tests where the outer ctx's branch must reflect entries from prior stages
	 * AND the current stage (the runner slices with branchOffset to separate them).
	 */
	outerBranch?: unknown[];
}

export interface MockSessionChain {
	/** The outer command ctx passed into runWorkflow(). */
	ctx: MockWorkflowCtx;
	/** Every `sendUserMessage(...)` call across all child ctxs AND pi, in order. */
	sentMessages: string[];
	/** Every `ui.notify(msg, level)` call across outer + freshCtxs, in order. */
	notifications: Array<{ msg: string; level: string }>;
	/**
	 * Every `ui.setStatus(key, value)` call across outer + freshCtxs, in order.
	 * `value === undefined` represents a clear; anything else is a set.
	 */
	statusUpdates: Array<{ key: string; value: string | undefined }>;
	/** The mock pi instance (if provided via options). */
	pi?: ExtensionAPI;
	/** How many scripted steps remain unconsumed. */
	remaining: () => number;
	/** Shared vi.fn() backing every `ui.notify` — for direct `.mock.calls` assertions. */
	notifyFn: ReturnType<typeof vi.fn>;
	/** Shared vi.fn() backing every `ui.setStatus` — for direct `.mock.calls` assertions. */
	setStatusFn: ReturnType<typeof vi.fn>;
	/**
	 * Shared `vi.fn()` backing every child ctx's `sendUserMessage`. Tests that
	 * need a stage to influence the shared branch (e.g. push an assistant entry
	 * on send) override this — every spawned child session routes its
	 * `sendUserMessage` through it.
	 */
	sendUserMessageFn: ReturnType<typeof vi.fn>;
}

/**
 * Build a chained session-mock for tests that exercise `runWorkflow` (or any
 * code that calls `spawnChild({ withSession })`). Every call to `spawnChild` —
 * whether on the outer ctx or on a child handed to a prior `withSession`
 * callback — dequeues one step from `opts.steps`. If the test scripts fewer
 * steps than the code under test consumes, the next call throws a clear "no
 * more scripted steps" error pointing back at the fixture.
 *
 * The outer ctx's `spawnChild` is its own `vi.fn` (so tests can assert
 * `expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(1)`). The PARENT ctx
 * STAYS VALID across every spawn — children never swap it out. Each spawned
 * child gets its own `spawnChild` spy too, but they all share the same script
 * queue.
 */
export function createMockSessionChain(opts: MockSessionChainOptions): MockSessionChain {
	const queue: MockSessionStep[] = [...opts.steps];
	const sentMessages: string[] = [];
	const notifications: Array<{ msg: string; level: string }> = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];

	const notifyFn = vi.fn((msg: unknown, level?: unknown) => {
		notifications.push({ msg: String(msg), level: String(level ?? "info") });
	});

	const setStatusFn = vi.fn((key: unknown, value: unknown) => {
		statusUpdates.push({
			key: String(key),
			value: value === undefined ? undefined : String(value),
		});
	});

	const sendUserMessageFn = vi.fn(async (content: unknown) => {
		sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
	});

	// Create or reuse mock pi — wire sendUserMessage to capture to sentMessages.
	const mockPi = opts.pi ?? createMockPi().pi;
	(mockPi.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: unknown) => {
		sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
	});

	const buildCtx = (kind: "outer" | "child", branch: unknown[], sessionFile?: string): MockWorkflowCtx => {
		const base = createMockCtx({
			...opts,
			// Override branch with the provided parameter — for "outer" kind this is
			// outerBranch (not opts.branch from MockCtxOptions).
			branch: branch as SessionEntry[],
			ui: {
				...(opts.ui ?? {}),
				notify: notifyFn as unknown as ExtensionUIContext["notify"],
				setStatus: setStatusFn as unknown as ExtensionUIContext["setStatus"],
			},
		});

		const spawnChildSpy = vi.fn(async <T>(options: MockSpawnChildOptions<T>): Promise<T> => {
			const step = queue.shift();
			if (!step) {
				throw new Error(
					"createMockSessionChain: spawnChild called but no more scripted steps remain (chain consumed too many).",
				);
			}
			// A scripted cancellation REJECTS — the dispatcher treats a rejection as
			// an unfilled slot (the detached replacement for the old `{cancelled}`
			// return, which had no live-session swap to dismiss).
			if (step.cancelled) {
				throw new Error("createMockSessionChain: scripted child cancellation (spawnChild rejected).");
			}
			// The HOST sends the initial prompt as part of spawnChild (the production
			// code no longer calls the child's sendUserMessage for it). Record it to
			// `sentMessages` so prompt-ordering assertions hold — EXCEPT in reattach
			// AND fork modes, where the host opens/forks the persisted session without
			// replaying `prompt` (the body sends the continuation via sendUserMessage).
			if (!options.reattach && !options.fork) sentMessages.push(options.prompt);
			// `reattach` opens a persisted session in place; `fork` copies a
			// predecessor's session into a new child. Both load a scripted prior
			// transcript and the mock body never replays `prompt`, so the child is
			// synthesized the same way; the step's branch carries the prior messages
			// (and, for fork, grows when the body sends the continuation via an
			// overridden `sendUserMessageFn`). `sessionFile` lets the recorded
			// `SessionRef.file` point at a real file so a later continue can fork it.
			const child = buildCtx("child", step.branch ?? [], step.sessionFile) as unknown as WorkflowSessionContext;
			return options.withSession(child);
		});

		const ctx = {
			...base,
			waitForIdle: vi.fn(async () => {}),
			maxConcurrency: opts.maxConcurrency ?? 1,
			spawnChild: spawnChildSpy,
		} as Record<string, unknown>;

		if (kind === "child") {
			ctx.sendUserMessage = sendUserMessageFn;
			ctx.sendMessage = vi.fn(async () => {});
			ctx.sessionManager = {
				...((base as { sessionManager?: object }).sessionManager ?? {}),
				getBranch: vi.fn(() => branch),
				// A continue stage forks the predecessor whose recorded `SessionRef.file`
				// this reports; override only when the step declares a real file.
				...(sessionFile !== undefined ? { getSessionFile: vi.fn(() => sessionFile) } : {}),
			};
		}

		return ctx as unknown as MockWorkflowCtx;
	};

	return {
		ctx: buildCtx("outer", opts.outerBranch ?? []),
		sentMessages,
		notifications,
		statusUpdates,
		pi: mockPi,
		remaining: () => queue.length,
		notifyFn,
		setStatusFn,
		sendUserMessageFn,
	};
}

/**
 * Convenience: build a branch entry that looks like an assistant message
 * containing a single text block. Cast to `unknown` to avoid leaking pi-ai's
 * internal discriminators into test files. The optional `stopReason` lets
 * tests simulate ESC-aborts (`"aborted"`) and LLM errors (`"error"`); when
 * omitted, the message represents a normal completion.
 */
export function mockAssistantMessage(
	text: string,
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted",
): unknown {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			...(stopReason !== undefined ? { stopReason } : {}),
		},
	};
}
