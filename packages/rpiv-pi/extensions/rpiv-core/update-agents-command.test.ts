import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agents.js", () => ({
	SYNC_OP: {
		READ_SRC: "read-src",
		READ_DEST: "read-dest",
		COPY: "copy",
		REMOVE: "remove",
		MANIFEST_WRITE: "manifest-write",
		MKDIR: "mkdir",
	},
	syncBundledAgents: vi.fn(),
	cleanupPerCwdAgents: vi.fn(),
}));

vi.mock("./models-config.js", () => ({
	invalidateModelsConfigCache: vi.fn(),
}));

import { cleanupPerCwdAgents, SYNC_OP, syncBundledAgents } from "./agents.js";
import { invalidateModelsConfigCache } from "./models-config.js";
import { registerUpdateAgentsCommand } from "./update-agents-command.js";

const emptyCleanup = () => ({ cleanedUp: [], skipped: [], errors: [] });

beforeEach(() => {
	vi.mocked(syncBundledAgents).mockReset();
	vi.mocked(cleanupPerCwdAgents).mockReset();
	vi.mocked(invalidateModelsConfigCache).mockReset();
	vi.mocked(cleanupPerCwdAgents).mockReturnValue(emptyCleanup());
});

const empty = (overrides: Partial<ReturnType<typeof syncBundledAgents>> = {}) => ({
	added: [],
	updated: [],
	unchanged: [],
	removed: [],
	pendingUpdate: [],
	pendingRemove: [],
	errors: [],
	...overrides,
});

describe("/rpiv-update-agents", () => {
	it("registers the command", () => {
		const { pi, captured } = createMockPi();
		registerUpdateAgentsCommand(pi);
		expect(captured.commands.has("rpiv-update-agents")).toBe(true);
	});

	it("UP_TO_DATE when no changes, no errors", async () => {
		vi.mocked(syncBundledAgents).mockReturnValue(empty());
		const { pi, captured } = createMockPi();
		registerUpdateAgentsCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-update-agents")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("up-to-date"), "info");
	});

	it("synced report when added+updated+removed > 0", async () => {
		vi.mocked(syncBundledAgents).mockReturnValue(empty({ added: ["a.md"], updated: ["b.md"], removed: ["c.md"] }));
		const { pi, captured } = createMockPi();
		registerUpdateAgentsCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-update-agents")?.handler("", ctx as never);
		const report = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(report).toContain("1 added");
		expect(report).toContain("1 updated");
		expect(report).toContain("1 removed");
	});

	it("errors-only report uses 'warning' severity", async () => {
		vi.mocked(syncBundledAgents).mockReturnValue(
			empty({ errors: [{ op: SYNC_OP.COPY, message: "EACCES", file: "a.md" }] }),
		);
		const { pi, captured } = createMockPi();
		registerUpdateAgentsCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-update-agents")?.handler("", ctx as never);
		const [, severity] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(severity).toBe("warning");
	});

	it("resets the models.json cache before syncing so mid-session edits are re-read", async () => {
		vi.mocked(syncBundledAgents).mockReturnValue(empty());
		const { pi, captured } = createMockPi();
		registerUpdateAgentsCommand(pi);
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("rpiv-update-agents")?.handler("", ctx as never);
		expect(invalidateModelsConfigCache).toHaveBeenCalledTimes(1);
		// Reset must precede sync — sync re-reads config and injects frontmatter.
		expect(vi.mocked(invalidateModelsConfigCache).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(syncBundledAgents).mock.invocationCallOrder[0],
		);
	});

	it("stays silent when !hasUI", async () => {
		vi.mocked(syncBundledAgents).mockReturnValue(empty({ added: ["x.md"] }));
		const { pi, captured } = createMockPi();
		registerUpdateAgentsCommand(pi);
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("rpiv-update-agents")?.handler("", ctx as never);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
