import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi, writeGuidanceTree } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { clearInjectionState, handleToolCallGuidance, injectRootGuidance, resolveGuidance } from "./guidance.js";

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "rpiv-guidance-"));
	clearInjectionState();
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("resolveGuidance — ladder", () => {
	it("AGENTS.md > CLAUDE.md > architecture.md at depth > 0", () => {
		writeGuidanceTree(projectDir, {
			"src/AGENTS.md": "agents-body",
			"src/CLAUDE.md": "claude-body",
			".rpiv/guidance/src/architecture.md": "arch-body",
		});
		const resolved = resolveGuidance(join(projectDir, "src", "foo.ts"), projectDir);
		const srcEntry = resolved.find((r) => r.relativePath.startsWith("src/"));
		expect(srcEntry?.kind).toBe("agents");
	});

	it("depth 0 skips AGENTS/CLAUDE but keeps root architecture.md", () => {
		writeGuidanceTree(projectDir, {
			"AGENTS.md": "root-agents",
			".rpiv/guidance/architecture.md": "root-arch",
		});
		const resolved = resolveGuidance(join(projectDir, "any", "file.ts"), projectDir);
		const rootEntry = resolved.find((r) => r.relativePath === ".rpiv/guidance/architecture.md");
		expect(rootEntry?.kind).toBe("architecture");
		expect(resolved.some((r) => r.relativePath === "AGENTS.md")).toBe(false);
	});

	it("returns root-first, specific-last order", () => {
		writeGuidanceTree(projectDir, {
			".rpiv/guidance/architecture.md": "root",
			"a/AGENTS.md": "a",
			"a/b/AGENTS.md": "ab",
		});
		const resolved = resolveGuidance(join(projectDir, "a", "b", "c.ts"), projectDir);
		expect(resolved.map((r) => r.content)).toEqual(["root", "a", "ab"]);
	});

	it("returns empty when file is outside projectDir", () => {
		expect(resolveGuidance("/totally/elsewhere/foo.ts", projectDir)).toEqual([]);
	});

	it("returns empty when nothing exists along the ladder", () => {
		expect(resolveGuidance(join(projectDir, "x.ts"), projectDir)).toEqual([]);
	});
});

describe("injectRootGuidance", () => {
	it("sends root architecture.md when present", () => {
		writeGuidanceTree(projectDir, { ".rpiv/guidance/architecture.md": "body" });
		const { pi } = createMockPi();
		injectRootGuidance(projectDir, pi);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const content = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content;
		expect(content).toContain("body");
		expect(content).toContain("reference material, NOT a task");
		expect(content).toContain("auto-loaded at session start");
	});

	it("is idempotent across calls within a session", () => {
		writeGuidanceTree(projectDir, { ".rpiv/guidance/architecture.md": "body" });
		const { pi } = createMockPi();
		injectRootGuidance(projectDir, pi);
		injectRootGuidance(projectDir, pi);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("re-injects after clearInjectionState", () => {
		writeGuidanceTree(projectDir, { ".rpiv/guidance/architecture.md": "body" });
		const { pi } = createMockPi();
		injectRootGuidance(projectDir, pi);
		clearInjectionState();
		injectRootGuidance(projectDir, pi);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("no-ops when root architecture.md is missing", () => {
		const { pi } = createMockPi();
		injectRootGuidance(projectDir, pi);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("handleToolCallGuidance", () => {
	it("skips non-read/edit/write tools", () => {
		const { pi } = createMockPi();
		handleToolCallGuidance({ toolName: "bash", input: {} }, { cwd: projectDir }, pi);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("dedupes per-file across multiple tool_calls", () => {
		writeGuidanceTree(projectDir, { "src/AGENTS.md": "a" });
		const { pi } = createMockPi();
		const ev = { toolName: "read", input: { file_path: join(projectDir, "src", "x.ts") } };
		handleToolCallGuidance(ev, { cwd: projectDir }, pi);
		handleToolCallGuidance(ev, { cwd: projectDir }, pi);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("supports both 'path' and 'file_path' input keys", () => {
		writeGuidanceTree(projectDir, { "src/AGENTS.md": "a" });
		const { pi } = createMockPi();
		handleToolCallGuidance(
			{ toolName: "edit", input: { path: join(projectDir, "src", "x.ts") } },
			{ cwd: projectDir },
			pi,
		);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("emits one sendMessage combining multiple newly-resolved files", () => {
		writeGuidanceTree(projectDir, {
			".rpiv/guidance/architecture.md": "root",
			"src/AGENTS.md": "src",
		});
		const { pi } = createMockPi();
		handleToolCallGuidance(
			{ toolName: "write", input: { file_path: join(projectDir, "src", "x.ts") } },
			{ cwd: projectDir },
			pi,
		);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const content = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content;
		expect(content).toContain("root");
		expect(content).toContain("src");
		expect(content).toContain("auto-loaded because write touched src/x.ts");
	});
});
