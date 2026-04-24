import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pi-installer.js", () => ({ spawnPiInstall: vi.fn() }));
vi.mock("./package-checks.js", () => ({ findMissingSiblings: vi.fn() }));
vi.mock("./ensure-subagent-config.js", () => ({ ensureSubagentConfig: vi.fn() }));
vi.mock("./prune-legacy-siblings.js", () => ({ pruneLegacySiblings: vi.fn() }));
vi.mock("./ensure-builtins-disabled.js", () => ({ ensureBuiltinsDisabled: vi.fn() }));

import { ensureBuiltinsDisabled } from "./ensure-builtins-disabled.js";
import { ensureSubagentConfig } from "./ensure-subagent-config.js";
import { findMissingSiblings } from "./package-checks.js";
import { spawnPiInstall } from "./pi-installer.js";
import { pruneLegacySiblings } from "./prune-legacy-siblings.js";
import { registerSetupCommand } from "./setup-command.js";

beforeEach(() => {
	vi.mocked(spawnPiInstall).mockReset();
	vi.mocked(findMissingSiblings).mockReset();
	vi.mocked(ensureSubagentConfig).mockReset();
	vi.mocked(ensureSubagentConfig).mockReturnValue({ created: false, merged: [] });
	vi.mocked(pruneLegacySiblings).mockReset();
	vi.mocked(pruneLegacySiblings).mockReturnValue({ pruned: [] });
	vi.mocked(ensureBuiltinsDisabled).mockReset();
	vi.mocked(ensureBuiltinsDisabled).mockReturnValue({ disabled: false });
});

describe("/rpiv-setup — command shape", () => {
	it("registers under 'rpiv-setup'", () => {
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		expect(captured.commands.has("rpiv-setup")).toBe(true);
	});
});

describe("/rpiv-setup — !hasUI", () => {
	it("notifies error and exits", async () => {
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(spawnPiInstall).not.toHaveBeenCalled();
	});
});

describe("/rpiv-setup — all installed", () => {
	it("notifies all-installed info and exits", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already installed"), "info");
	});
});

describe("/rpiv-setup — user cancels", () => {
	it("notifies cancelled info and skips installs", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:@x/y", matches: /./, provides: "p" }]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
		expect(spawnPiInstall).not.toHaveBeenCalled();
	});
});

describe("/rpiv-setup — mixed success/failure report", () => {
	it("reports succeeded + failed with 300-char stderr snippets", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([
			{ pkg: "npm:@x/a", matches: /./, provides: "A" },
			{ pkg: "npm:@x/b", matches: /./, provides: "B" },
		]);
		vi.mocked(spawnPiInstall)
			.mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" })
			.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "x".repeat(500) });
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const reportCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1);
		const report: string = reportCall![0];
		expect(report).toContain("npm:@x/a");
		expect(report).toContain("npm:@x/b");
		// stderr snippet capped at 300 chars
		expect((report.match(/x+/g) ?? []).every((m) => m.length <= 300)).toBe(true);
		expect(reportCall![1]).toBe("warning");
	});

	it("uses stdout fallback when stderr empty", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:@x/a", matches: /./, provides: "A" }]);
		vi.mocked(spawnPiInstall).mockResolvedValueOnce({ code: 1, stdout: "stdout-error", stderr: "" });
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const report = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
		expect(report).toContain("stdout-error");
	});

	it("all-failed report omits Restart line", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:@x/a", matches: /./, provides: "A" }]);
		vi.mocked(spawnPiInstall).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "err" });
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const report = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
		expect(report).not.toContain("Restart");
	});
});

describe("/rpiv-setup — subagent config seeding", () => {
	it("seeds config + emits notify after at least one successful install", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:pi-subagents", matches: /./, provides: "P" }]);
		vi.mocked(spawnPiInstall).mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" });
		vi.mocked(ensureSubagentConfig).mockReturnValue({
			created: true,
			merged: ["parallel.concurrency", "maxSubagentDepth"],
		});
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ensureSubagentConfig).toHaveBeenCalledTimes(1);
		const seedCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].startsWith("Seeded subagent config keys:"),
		);
		expect(seedCall).toBeDefined();
		expect(seedCall?.[1]).toBe("info");
	});

	it("empty merged set emits no seed notify", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:pi-subagents", matches: /./, provides: "P" }]);
		vi.mocked(spawnPiInstall).mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" });
		vi.mocked(ensureSubagentConfig).mockReturnValue({ created: false, merged: [] });
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ensureSubagentConfig).toHaveBeenCalledTimes(1);
		const seedCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].startsWith("Seeded subagent config keys:"),
		);
		expect(seedCall).toBeUndefined();
	});

	it("skips seed when all installs fail", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:pi-subagents", matches: /./, provides: "P" }]);
		vi.mocked(spawnPiInstall).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "err" });
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ensureSubagentConfig).not.toHaveBeenCalled();
	});

	it("skips seed when user cancels", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:pi-subagents", matches: /./, provides: "P" }]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ensureSubagentConfig).not.toHaveBeenCalled();
	});

	it("skips seed when no siblings missing", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ensureSubagentConfig).not.toHaveBeenCalled();
	});
});

describe("/rpiv-setup — legacy sibling pruning", () => {
	it("emits pruned notify when legacy entry removed", async () => {
		vi.mocked(pruneLegacySiblings).mockReturnValue({ pruned: ["npm:@tintinweb/pi-subagents"] });
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const pruneCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].startsWith("Removed legacy subagent library"),
		);
		expect(pruneCall).toBeDefined();
		expect(pruneCall?.[0]).toContain("npm:@tintinweb/pi-subagents");
		expect(pruneCall?.[1]).toBe("info");
	});

	it("no notify when nothing pruned", async () => {
		vi.mocked(pruneLegacySiblings).mockReturnValue({ pruned: [] });
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const pruneCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].startsWith("Removed legacy subagent library"),
		);
		expect(pruneCall).toBeUndefined();
	});

	it("prune runs in the all-installed path (before early-return)", async () => {
		vi.mocked(pruneLegacySiblings).mockReturnValue({ pruned: ["npm:@tintinweb/pi-subagents"] });
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(pruneLegacySiblings).toHaveBeenCalledTimes(1);
	});

	it("prune does NOT run on !hasUI guard", async () => {
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(pruneLegacySiblings).not.toHaveBeenCalled();
	});
});

describe("/rpiv-setup — pi-subagents builtins disabling", () => {
	it("emits builtins-disabled notify when helper writes the flag", async () => {
		vi.mocked(ensureBuiltinsDisabled).mockReturnValue({ disabled: true });
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const call = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].startsWith("Disabled pi-subagents built-in agents"),
		);
		expect(call).toBeDefined();
		expect(call?.[1]).toBe("info");
	});

	it("no notify when helper skips (already set or fail-soft no-op)", async () => {
		vi.mocked(ensureBuiltinsDisabled).mockReturnValue({ disabled: false });
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const call = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].startsWith("Disabled pi-subagents built-in agents"),
		);
		expect(call).toBeUndefined();
	});

	it("runs in the all-installed path (before early-return)", async () => {
		vi.mocked(ensureBuiltinsDisabled).mockReturnValue({ disabled: true });
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ensureBuiltinsDisabled).toHaveBeenCalledTimes(1);
	});

	it("does NOT run on !hasUI guard", async () => {
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ensureBuiltinsDisabled).not.toHaveBeenCalled();
	});
});
