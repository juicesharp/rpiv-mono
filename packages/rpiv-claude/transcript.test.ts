import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchEntry } from "@juicesharp/rpiv-workflow";
import { describe, expect, it } from "vitest";
import {
	claudeConfigDir,
	locateSessionFile,
	projectDirName,
	readSessionBranch,
	stampStop,
	userEntry,
} from "./transcript.js";

describe("stampStop", () => {
	it("stamps the last assistant entry at or after the turn start", () => {
		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "assistant", content: [] } },
			userEntry("go"),
			{ type: "message", message: { role: "assistant", content: [] } },
		];
		stampStop(branch, "stop", 1);
		expect(branch[2]!.message!.stopReason).toBe("stop");
		expect(branch[0]!.message!.stopReason).toBeUndefined();
	});

	it("never stamps an earlier turn's reply", () => {
		const branch: BranchEntry[] = [{ type: "message", message: { role: "assistant", content: [] } }, userEntry("go")];
		stampStop(branch, "error", 1);
		expect(branch).toHaveLength(3);
		expect(branch[0]!.message!.stopReason).toBeUndefined();
	});
});

describe("session files", () => {
	function store() {
		const config = mkdtempSync(join(tmpdir(), "claude-config-"));
		const mk = (dir: string, id: string, body = "") => {
			mkdirSync(join(config, "projects", dir), { recursive: true });
			writeFileSync(join(config, "projects", dir, `${id}.jsonl`), body);
			return join(config, "projects", dir, `${id}.jsonl`);
		};
		return { config, mk };
	}

	it("encodes a cwd the way Claude Code names project directories", () => {
		expect(projectDirName("/tmp/a.b/c_d")).toBe("-tmp-a-b-c-d");
	});

	it("prefers the stage's own project directory when an id exists in several", () => {
		const { config, mk } = store();
		mk("-aaa-launcher", "same-id");
		const own = mk(projectDirName("/work/proj"), "same-id");
		expect(locateSessionFile("same-id", config, "/work/proj")).toBe(own);
	});

	it("falls back to any project directory, and to undefined", () => {
		const { config, mk } = store();
		const other = mk("-elsewhere", "id-1");
		expect(locateSessionFile("id-1", config, "/work/proj")).toBe(other);
		expect(locateSessionFile("missing", config)).toBeUndefined();
		expect(locateSessionFile("", config)).toBeUndefined();
		expect(locateSessionFile("x", join(config, "nope"))).toBeUndefined();
	});

	it("reads main-thread messages and skips sidechains, metadata and bad lines", () => {
		const { mk } = store();
		const rows = [
			JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
			JSON.stringify({
				type: "assistant",
				isSidechain: true,
				message: { content: [{ type: "text", text: "sub" }] },
			}),
			JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "r" }] } }),
			JSON.stringify({ type: "queue-operation" }),
			"{not json",
			"",
		];
		const branch = readSessionBranch(mk("-p", "s", rows.join("\n")))!;
		expect(branch.map((e) => [e.message?.role, e.message?.content?.[0]?.type])).toEqual([
			["user", "text"],
			["assistant", "text"],
			["user", "tool_result"],
		]);
	});

	it("returns undefined for an unreadable file", () => {
		expect(readSessionBranch("/nonexistent/file.jsonl")).toBeUndefined();
	});

	it("honours CLAUDE_CONFIG_DIR", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg");
		expect(claudeConfigDir({})).toMatch(/\.claude$/);
	});
});
