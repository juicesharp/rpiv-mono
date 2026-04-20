import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	ToolDefinition,
	ToolInfo,
} from "@mariozechner/pi-coding-agent";
import { vi } from "vitest";

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
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
		exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
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
		...overrides,
	} as unknown as MockUI;
}

export function createMockSessionManager(branch: SessionEntry[] = []) {
	return {
		getBranch: vi.fn(() => branch),
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
