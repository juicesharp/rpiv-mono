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
import { vi } from "vitest";

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
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

export function createMockPi(overrides: Partial<ExtensionAPI> = {}): MockPi {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
	};

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, cmd);
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
}

export function createMockCtx(opts: MockCtxOptions = {}): ExtensionContext {
	return {
		hasUI: opts.hasUI ?? false,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		model: opts.model,
		ui: createMockUI(opts.ui),
		sessionManager: createMockSessionManager(opts.branch ?? []),
		modelRegistry: createMockModelRegistry(opts.models ?? []),
	} as unknown as ExtensionContext;
}

/**
 * Minimal `ExtensionCommandContext` mock for unit tests that mock the runner
 * (or otherwise never exercise `newSession` for real). Adds `waitForIdle` and
 * a no-op `newSession` to satisfy the type — both are `vi.fn` so tests can
 * still assert `expect(ctx.newSession).not.toHaveBeenCalled()`.
 *
 * For tests that DO drive `newSession({ withSession })` recursively, use
 * `createMockSessionChain` — it scripts a queue of responses and gives every
 * freshCtx its own spy.
 */
export function createMockCommandCtx(opts: MockCtxOptions = {}): ExtensionCommandContext {
	const base = createMockCtx(opts);
	return {
		...base,
		waitForIdle: vi.fn(async () => {}),
		newSession: vi.fn(async () => ({ cancelled: false })),
	} as unknown as ExtensionCommandContext;
}

// ---------------------------------------------------------------------------
// Session chain fixture — for tests that drive runWorkflow/runStage/runImplementPhases
// across multiple newSession() calls. The outer ctx and every freshCtx share
// a single scripted queue; pop order is the order in which the production
// code calls newSession (recursively, on the freshCtx returned from each
// withSession callback).
// ---------------------------------------------------------------------------

/** One scripted response in a session chain. */
export interface MockSessionStep {
	/**
	 * Branch entries the freshCtx's sessionManager.getBranch() will return
	 * inside withSession. Each element should be a BranchEntry-shaped object
	 * (e.g. built with `mockAssistantMessage`).
	 */
	branch?: unknown[];
	/**
	 * If true, newSession resolves `{ cancelled: true }` without invoking
	 * withSession. Mutually exclusive with `branch`.
	 */
	cancelled?: boolean;
}

export interface MockSessionChainOptions extends MockCtxOptions {
	/** Scripted responses, in the order newSession will consume them. */
	steps: MockSessionStep[];
}

export interface MockSessionChain {
	/** The outer ExtensionCommandContext passed into runWorkflow(). */
	ctx: ExtensionCommandContext;
	/** Every `sendUserMessage(...)` call across all freshCtxs, in order. */
	sentMessages: string[];
	/** Every `ui.notify(msg, level)` call across outer + freshCtxs, in order. */
	notifications: Array<{ msg: string; level: string }>;
	/**
	 * Every `ui.setStatus(key, value)` call across outer + freshCtxs, in order.
	 * `value === undefined` represents a clear; anything else is a set.
	 */
	statusUpdates: Array<{ key: string; value: string | undefined }>;
	/** How many scripted steps remain unconsumed. */
	remaining: () => number;
	/** Shared vi.fn() backing every `ui.notify` — for direct `.mock.calls` assertions. */
	notifyFn: ReturnType<typeof vi.fn>;
	/** Shared vi.fn() backing every `ui.setStatus` — for direct `.mock.calls` assertions. */
	setStatusFn: ReturnType<typeof vi.fn>;
}

/**
 * Build a chained session-mock for tests that exercise `runWorkflow` (or any
 * code that calls `newSession({ withSession })` recursively). Every call to
 * `newSession` — whether on the outer ctx or on a freshCtx handed to a prior
 * `withSession` callback — dequeues one step from `opts.steps`. If the test
 * scripts fewer steps than the code under test consumes, the next call throws
 * a clear "no more scripted steps" error pointing back at the fixture.
 *
 * The outer ctx's `newSession` is its own `vi.fn` (so tests can assert
 * `expect(chain.ctx.newSession).toHaveBeenCalledTimes(1)` to verify that the
 * chain advances on freshCtx, not on the outer ctx). Every freshCtx gets its
 * own newSession spy too, but they all share the same script queue.
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

	const buildCtx = (kind: "outer" | "replaced", branch: unknown[]): ExtensionCommandContext => {
		const base = createMockCtx({
			...opts,
			ui: {
				...(opts.ui ?? {}),
				notify: notifyFn as unknown as ExtensionUIContext["notify"],
				setStatus: setStatusFn as unknown as ExtensionUIContext["setStatus"],
			},
		});

		const newSessionSpy = vi.fn(async (options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
			const step = queue.shift();
			if (!step) {
				throw new Error(
					"createMockSessionChain: newSession called but no more scripted steps remain (chain consumed too many).",
				);
			}
			if (step.cancelled) return { cancelled: true };
			const freshCtx = buildCtx("replaced", step.branch ?? []);
			if (options?.withSession) {
				await options.withSession(freshCtx);
			}
			return { cancelled: false };
		});

		const ctx = {
			...base,
			waitForIdle: vi.fn(async () => {}),
			newSession: newSessionSpy,
		} as Record<string, unknown>;

		if (kind === "replaced") {
			ctx.sendUserMessage = sendUserMessageFn;
			ctx.sendMessage = vi.fn(async () => {});
			ctx.sessionManager = {
				...((base as { sessionManager?: object }).sessionManager ?? {}),
				getBranch: vi.fn(() => branch),
			};
		}

		return ctx as unknown as ExtensionCommandContext;
	};

	return {
		ctx: buildCtx("outer", []),
		sentMessages,
		notifications,
		statusUpdates,
		remaining: () => queue.length,
		notifyFn,
		setStatusFn,
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
