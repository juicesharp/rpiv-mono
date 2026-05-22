import { createMockCommandCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock runner to avoid needing full Pi session runtime
vi.mock("./runner.js", () => ({
	runWorkflow: vi.fn(async () => ({ stagesCompleted: 2, success: true })),
}));

// Mock loadConfig to avoid filesystem I/O
vi.mock("./loadConfig.js", () => ({
	loadConfig: vi.fn(() => ({
		dag: {
			edges: [],
			presets: {
				trivial: ["discover", "commit"],
				small: ["research", "commit"],
				mid: ["discover", "research", "blueprint", "implement", "validate", "code-review", "commit"],
				large: ["discover", "research", "design", "plan", "implement", "validate", "code-review", "commit"],
				review: ["code-review", "commit"],
			},
			nodes: {},
		},
		presetNames: new Set(["trivial", "small", "mid", "large", "review"]),
		defaultPreset: "mid",
		source: "built-in" as const,
	})),
}));

import { formatPresetList, parseArgs, registerWorkflowCommand } from "./command.js";
import type { LoadedConfigWithSource } from "./loadConfig.js";
import { loadConfig } from "./loadConfig.js";
import { runWorkflow } from "./runner.js";

beforeEach(() => {
	vi.mocked(runWorkflow).mockReset();
	vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 2, success: true });
});

describe("parseArgs", () => {
	const builtInConfig = {
		presetNames: new Set(["trivial", "small", "mid", "large", "review"]),
		defaultPreset: "mid",
	};

	it("parses preset + input", () => {
		expect(parseArgs("mid Add dark mode", builtInConfig)).toEqual({ preset: "mid", input: "Add dark mode" });
	});

	it("defaults to mid when no preset recognized", () => {
		expect(parseArgs("Add dark mode", builtInConfig)).toEqual({ preset: "mid", input: "Add dark mode" });
	});

	it("parses preset-only with no input", () => {
		expect(parseArgs("review", builtInConfig)).toEqual({ preset: "review", input: "" });
	});

	it("handles empty string", () => {
		expect(parseArgs("", builtInConfig)).toEqual({ preset: "mid", input: "" });
	});

	it("handles whitespace-only string", () => {
		expect(parseArgs("   ", builtInConfig)).toEqual({ preset: "mid", input: "" });
	});

	it("parses trivial preset", () => {
		expect(parseArgs("trivial Fix typo", builtInConfig)).toEqual({ preset: "trivial", input: "Fix typo" });
	});

	it("parses large preset with multi-word input", () => {
		expect(parseArgs("large Build a REST API with auth", builtInConfig)).toEqual({
			preset: "large",
			input: "Build a REST API with auth",
		});
	});

	it("accepts custom preset names from config", () => {
		const customConfig = {
			presetNames: new Set(["my-flow", "quick"]),
			defaultPreset: "my-flow",
		};
		expect(parseArgs("my-flow Add feature", customConfig)).toEqual({ preset: "my-flow", input: "Add feature" });
	});

	it("uses custom defaultPreset when no preset recognized", () => {
		const customConfig = {
			presetNames: new Set(["my-flow"]),
			defaultPreset: "my-flow",
		};
		expect(parseArgs("Add feature", customConfig)).toEqual({ preset: "my-flow", input: "Add feature" });
	});
});

describe("formatPresetList", () => {
	it("lists built-in presets with source indicator", () => {
		const config: LoadedConfigWithSource = {
			dag: { edges: [], presets: { mid: ["discover", "commit"], review: ["code-review", "commit"] }, nodes: {} },
			presetNames: new Set(["mid", "review"]),
			defaultPreset: "mid",
			source: "built-in",
		};
		const result = formatPresetList(config);
		expect(result).toContain("[built-in]");
		expect(result).toContain("mid (default)");
		expect(result).toContain("review");
	});

	it("lists project presets with source indicator", () => {
		const config: LoadedConfigWithSource = {
			dag: { edges: [], presets: { quick: ["research", "commit"] }, nodes: {} },
			presetNames: new Set(["quick"]),
			defaultPreset: "quick",
			source: "project",
		};
		const result = formatPresetList(config);
		expect(result).toContain("[project]");
		expect(result).toContain("quick (default)");
	});
});

describe("/rpiv — command shape", () => {
	it("registers under 'rpiv'", () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		expect(captured.commands.has("rpiv")).toBe(true);
	});
});

describe("/rpiv — !hasUI", () => {
	it("notifies error and exits without calling runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: false });
		await captured.commands.get("rpiv")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/rpiv — no input", () => {
	it("shows preset listing when no input provided", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("rpiv")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available presets"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/rpiv — valid invocation", () => {
	it("calls runWorkflow with parsed preset, input, and dag from config", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("rpiv")?.handler("mid Add dark mode", ctx);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.preset).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
		expect(opts?.dag).toBeDefined();
	});

	it("defaults to mid preset when first token is not a preset", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("rpiv")?.handler("Add dark mode", ctx);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.preset).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
	});

	it("passes preset-only with empty input (shows listing)", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("rpiv")?.handler("review", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available presets"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/rpiv — config warnings", () => {
	it("surfaces config warnings to the user", async () => {
		vi.mocked(loadConfig).mockReturnValueOnce({
			dag: { edges: [], presets: { mid: ["discover", "commit"] }, nodes: {} },
			presetNames: new Set(["mid"]),
			defaultPreset: "mid",
			source: "built-in",
			warnings: ["Test warning"],
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("rpiv")?.handler("mid Add feature", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Test warning", "warning");
	});
});
