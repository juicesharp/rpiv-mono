import { join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pi-installer.js", () => ({ spawnPiInstall: vi.fn() }));
vi.mock("./package-checks.js", () => ({ findMissingSiblings: vi.fn() }));
vi.mock("./prune-legacy-siblings.js", () => ({
	findLegacySiblings: vi.fn(),
	pruneLegacySiblings: vi.fn(),
}));

import { findMissingSiblings } from "./package-checks.js";
import { spawnPiInstall } from "./pi-installer.js";
import { findLegacySiblings, pruneLegacySiblings } from "./prune-legacy-siblings.js";
import { registerSetupCommand } from "./setup-command.js";

beforeEach(() => {
	vi.mocked(spawnPiInstall).mockReset();
	vi.mocked(findMissingSiblings).mockReset();
	vi.mocked(findLegacySiblings).mockReset();
	vi.mocked(findLegacySiblings).mockReturnValue([]);
	vi.mocked(pruneLegacySiblings).mockReset();
	vi.mocked(pruneLegacySiblings).mockReturnValue({ pruned: [] });
});

describe("/rpiv-setup — command shape", () => {
	it("registers under 'rpiv-setup'", () => {
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		expect(captured.commands.has("rpiv-setup")).toBe(true);
	});
});

describe("/rpiv-setup — !hasUI", () => {
	it("notifies error and exits without inspecting siblings or settings", async () => {
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(findMissingSiblings).not.toHaveBeenCalled();
		expect(findLegacySiblings).not.toHaveBeenCalled();
		expect(pruneLegacySiblings).not.toHaveBeenCalled();
		expect(spawnPiInstall).not.toHaveBeenCalled();
	});
});

describe("/rpiv-setup — nothing to do", () => {
	it("notifies all-installed and skips confirmation when no missing siblings AND no legacy entries", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		vi.mocked(findLegacySiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already installed"), "info");
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(pruneLegacySiblings).not.toHaveBeenCalled();
	});
});

describe("/rpiv-setup — pre-confirm read-only contract", () => {
	it("does NOT call pruneLegacySiblings before user confirmation", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		vi.mocked(findLegacySiblings).mockReturnValue(["npm:pi-subagents"]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			expect(pruneLegacySiblings).not.toHaveBeenCalled();
			return false;
		});
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("includes legacy entries in the confirmation body so the user sees what will be removed", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		vi.mocked(findLegacySiblings).mockReturnValue(["npm:pi-subagents"]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const confirmCall = (ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(confirmCall[1]).toContain("Remove from");
		expect(confirmCall[1]).toContain("npm:pi-subagents");
	});

	it("shows the PI_CODING_AGENT_DIR settings path in the confirmation body", async () => {
		process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".config", "pi", "agent");
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		vi.mocked(findLegacySiblings).mockReturnValue(["npm:pi-subagents"]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const confirmCall = (ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(confirmCall[1]).toContain(join(process.env.HOME!, ".config", "pi", "agent", "settings.json"));
	});

	it("includes pending installs in the confirmation body", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:@x/a", matches: /./, provides: "A" }]);
		vi.mocked(findLegacySiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		const confirmCall = (ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(confirmCall[1]).toContain("Install via `pi install`:");
		expect(confirmCall[1]).toContain("npm:@x/a");
	});
});

describe("/rpiv-setup — user cancels", () => {
	it("notifies cancelled and skips both prune and install", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:@x/y", matches: /./, provides: "p" }]);
		vi.mocked(findLegacySiblings).mockReturnValue(["npm:pi-subagents"]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
		expect(pruneLegacySiblings).not.toHaveBeenCalled();
		expect(spawnPiInstall).not.toHaveBeenCalled();
	});
});

describe("/rpiv-setup — post-confirm prune execution", () => {
	it("runs pruneLegacySiblings after confirm and emits notify when entries removed", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		vi.mocked(findLegacySiblings).mockReturnValue(["npm:pi-subagents"]);
		vi.mocked(pruneLegacySiblings).mockReturnValue({ pruned: ["npm:pi-subagents"] });
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(pruneLegacySiblings).toHaveBeenCalledTimes(1);
		const pruneNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].startsWith("Removed legacy subagent library"),
		);
		expect(pruneNotify).toBeDefined();
		expect(pruneNotify?.[0]).toContain("npm:pi-subagents");
	});

	it("skips pruneLegacySiblings when no legacy entries were detected pre-confirm", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([{ pkg: "npm:@x/y", matches: /./, provides: "p" }]);
		vi.mocked(findLegacySiblings).mockReturnValue([]);
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(pruneLegacySiblings).not.toHaveBeenCalled();
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

describe("/rpiv-setup — prune-only flow (no missing siblings)", () => {
	it("skips installMissing when only legacy entries exist", async () => {
		vi.mocked(findMissingSiblings).mockReturnValue([]);
		vi.mocked(findLegacySiblings).mockReturnValue(["npm:pi-subagents"]);
		vi.mocked(pruneLegacySiblings).mockReturnValue({ pruned: ["npm:pi-subagents"] });
		const { pi, captured } = createMockPi();
		registerSetupCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-setup")?.handler("", ctx as never);
		expect(pruneLegacySiblings).toHaveBeenCalledTimes(1);
		expect(spawnPiInstall).not.toHaveBeenCalled();
	});
});
