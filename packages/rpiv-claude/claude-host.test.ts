import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchEntry, WorkflowSessionContext } from "@juicesharp/rpiv-workflow";
import { describe, expect, it, vi } from "vitest";
import { type ClaudeHostDeps, ClaudeWorkflowHost, childEnv, claudeModel } from "./claude-host.js";

type Call = { prompt: string; options: Record<string, any> };

/** A fake SDK: each `query` call yields the scripted messages for that turn. */
function fakeSdk(turns: Array<(call: Call) => unknown[] | Promise<never>>) {
	const calls: Call[] = [];
	const query = vi.fn((params: { prompt: string; options: Record<string, any> }) => {
		const call = { prompt: params.prompt, options: params.options };
		calls.push(call);
		const script = turns[calls.length - 1] ?? (() => []);
		return (async function* () {
			const msgs = await script(call);
			for (const m of msgs) yield m;
		})();
	});
	const forkSession = vi.fn(async (_id: string) => ({ sessionId: "forked-id" }));
	return { deps: { query, forkSession } as unknown as ClaudeHostDeps, calls, forkSession };
}

const init = (id: string) => ({ type: "system", subtype: "init", session_id: id });
const say = (id: string, text: string, parent: string | null = null) => ({
	type: "assistant",
	session_id: id,
	parent_tool_use_id: parent,
	message: { content: [{ type: "text", text }] },
});
const result = (id: string, subtype = "success", stop_reason: string | null = "end_turn") => ({
	type: "result",
	subtype,
	session_id: id,
	stop_reason,
});

function host(deps: ClaudeHostDeps, extra: Partial<ConstructorParameters<typeof ClaudeWorkflowHost>[0]> = {}) {
	const notes: string[] = [];
	const h = new ClaudeWorkflowHost(
		{
			cwd: "/proj",
			pluginDir: "/plugin",
			catalog: { plugin: new Set(["plan"]), local: new Set(["note"]) },
			permissionMode: "auto",
			maxConcurrency: 2,
			notify: (m) => notes.push(m),
			locate: (id) => `/sessions/${id}.jsonl`,
			...extra,
		},
		deps,
	);
	return { h, notes };
}

async function run(
	h: ClaudeWorkflowHost,
	opts: Record<string, unknown> = {},
	body?: (c: WorkflowSessionContext) => Promise<void>,
) {
	let branch: BranchEntry[] = [];
	let child!: WorkflowSessionContext;
	await h.spawnChild({
		prompt: "/skill:plan do it",
		...opts,
		withSession: async (c) => {
			child = c;
			await c.waitForIdle();
			await body?.(c);
			branch = c.sessionManager.getBranch() as BranchEntry[];
		},
	});
	return { branch, child };
}

const lastAssistant = (b: BranchEntry[]) => [...b].reverse().find((e) => e.message?.role === "assistant")!.message!;

describe("ClaudeWorkflowHost — fresh stage", () => {
	it("sends the translated prompt with plugin, cwd and an env stripped of the launcher's session", async () => {
		const prev = process.env.CLAUDE_CODE_SESSION_ID;
		process.env.CLAUDE_CODE_SESSION_ID = "launcher-session";
		try {
			const sdk = fakeSdk([() => [init("s1"), say("s1", "ok"), result("s1")]]);
			await run(host(sdk.deps).h);
			const { prompt, options } = sdk.calls[0]!;
			expect(prompt).toBe("/rpiv:plan do it");
			expect(options.cwd).toBe("/proj");
			expect(options.plugins).toEqual([{ type: "local", path: "/plugin" }]);
			expect(options.permissionMode).toBe("auto");
			expect(options.resume).toBeUndefined();
			expect(options.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
			expect(options.env.PATH).toBe(process.env.PATH);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
			else process.env.CLAUDE_CODE_SESSION_ID = prev;
		}
	});

	it("records main-thread assistant text, ignores subagent frames, and stamps the result's stop", async () => {
		const sdk = fakeSdk([() => [init("s1"), say("s1", "sub", "toolu_1"), say("s1", "main"), result("s1")]]);
		const { branch, child } = await run(host(sdk.deps).h);
		expect(branch.map((e) => e.message?.role)).toEqual(["user", "assistant"]);
		expect(lastAssistant(branch)).toMatchObject({ stopReason: "stop", content: [{ text: "main" }] });
		expect(child.sessionManager.getSessionId()).toBe("s1");
		expect(child.sessionManager.getSessionFile()).toBe("/sessions/s1.jsonl");
	});

	it("resumes the same session on a re-prompt", async () => {
		const sdk = fakeSdk([() => [init("s1"), say("s1", "one"), result("s1")], () => [say("s1", "two"), result("s1")]]);
		const { branch } = await run(host(sdk.deps).h, {}, async (c) => {
			await c.sendUserMessage("/skill:note fix it");
			await c.waitForIdle();
		});
		expect(sdk.calls[1]!.options.resume).toBe("s1");
		expect(sdk.calls[1]!.prompt).toBe("/note fix it");
		expect(branch.filter((e) => e.message?.role === "assistant")).toHaveLength(2);
	});

	it.each([
		["error_max_turns", null, "length"],
		["error_during_execution", null, "error"],
		["success", "max_tokens", "length"],
	])("maps a %s result (stop_reason %s) to %s", async (subtype, stop, expected) => {
		const sdk = fakeSdk([() => [init("s1"), say("s1", "x"), result("s1", subtype, stop)]]);
		const { branch } = await run(host(sdk.deps).h);
		expect(lastAssistant(branch).stopReason).toBe(expected);
	});

	it("records a turn with no assistant reply as an empty stopped assistant entry", async () => {
		const sdk = fakeSdk([() => [init("s1"), result("s1", "error_during_execution")]]);
		const { branch } = await run(host(sdk.deps).h);
		expect(lastAssistant(branch)).toEqual({ role: "assistant", content: [], stopReason: "error" });
	});

	it("turns an SDK failure into an error stop and a notification, never a throw", async () => {
		const sdk = fakeSdk([() => Promise.reject(new Error("boom"))]);
		const { h, notes } = host(sdk.deps);
		const { branch } = await run(h);
		expect(lastAssistant(branch).stopReason).toBe("error");
		expect(notes.join()).toContain("boom");
	});

	it("records an abort as aborted without notifying", async () => {
		const ac = new AbortController();
		const sdk = fakeSdk([
			() => {
				ac.abort();
				return Promise.reject(new Error("aborted"));
			},
		]);
		const { h, notes } = host(sdk.deps);
		const { branch } = await run(h, { signal: ac.signal });
		expect(lastAssistant(branch).stopReason).toBe("aborted");
		expect(notes).toEqual([]);
	});

	it("does not call the SDK when the run is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const sdk = fakeSdk([]);
		const { branch } = await run(host(sdk.deps, { signal: ac.signal }).h);
		expect(sdk.calls).toHaveLength(0);
		expect(lastAssistant(branch).stopReason).toBe("aborted");
	});

	it("applies the stage's model selection", async () => {
		const sdk = fakeSdk([() => [result("s1")]]);
		await run(host(sdk.deps).h, { model: { model: "anthropic/claude-opus-5-5", thinking: "xhigh" } });
		expect(sdk.calls[0]!.options).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
	});

	it("gives concurrent children independent sessions", async () => {
		let n = 0;
		const sdk = fakeSdk(
			[0, 1].map(() => () => {
				const id = `s${++n}`;
				return [init(id), say(id, id), result(id)];
			}),
		);
		const { h } = host(sdk.deps);
		const [a, b] = await Promise.all([run(h), run(h)]);
		expect(new Set([a.child.sessionManager.getSessionId(), b.child.sessionManager.getSessionId()])).toEqual(
			new Set(["s1", "s2"]),
		);
	});
});

describe("ClaudeWorkflowHost — reattach and fork", () => {
	function sessionFile(): string {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-claude-"));
		const file = join(dir, "orig-id.jsonl");
		const rows = [
			{ type: "user", message: { role: "user", content: "first" } },
			{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		];
		writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
		return file;
	}

	it("reattach loads the transcript, sends nothing, and resumes on the next turn", async () => {
		const sdk = fakeSdk([() => [say("orig-id", "again"), result("orig-id")]]);
		const file = sessionFile();
		const { branch, child } = await run(host(sdk.deps).h, { reattach: { sessionFile: file } }, async (c) => {
			expect(sdk.calls).toHaveLength(0);
			expect(c.sessionManager.getBranch()).toHaveLength(2);
			await c.sendUserMessage("continue");
			await c.waitForIdle();
		});
		expect(sdk.calls[0]!.options.resume).toBe("orig-id");
		expect(child.sessionManager.getSessionFile()).toBe(file);
		expect(branch).toHaveLength(4);
	});

	it("fork copies the predecessor into a new session and keeps its transcript as the prefix", async () => {
		const sdk = fakeSdk([() => [say("forked-id", "cont"), result("forked-id")]]);
		const file = sessionFile();
		const { child } = await run(host(sdk.deps).h, { fork: { sessionFile: file } }, async (c) => {
			expect(c.sessionManager.getBranch()).toHaveLength(2);
			await c.sendUserMessage("next");
			await c.waitForIdle();
		});
		expect(sdk.forkSession).toHaveBeenCalledWith("orig-id", { dir: "/proj" });
		expect(sdk.calls[0]!.options.resume).toBe("forked-id");
		expect(child.sessionManager.getSessionId()).toBe("forked-id");
		expect(child.sessionManager.getSessionFile()).toBe("/sessions/forked-id.jsonl");
		expect(child.sessionManager.getSessionFile()).not.toBe(file);
	});

	it("an unlocatable fork reports no file rather than its predecessor's", async () => {
		const sdk = fakeSdk([]);
		const { child } = await run(host(sdk.deps, { locate: () => undefined }).h, {
			fork: { sessionFile: sessionFile() },
		});
		expect(child.sessionManager.getSessionFile()).toBeUndefined();
	});
});

describe("claudeModel", () => {
	it("drops an anthropic/ prefix and passes bare ids and aliases through", () => {
		expect(claudeModel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
		expect(claudeModel("opus")).toBe("opus");
	});

	it("refuses another provider's model", () => {
		expect(() => claudeModel("zai/glm-5.1")).toThrow("not an Anthropic model");
	});

	it("a refused model fails the stage, not the process", async () => {
		const sdk = fakeSdk([]);
		const { branch } = await run(host(sdk.deps).h, { model: { model: "zai/glm-5.1" } });
		expect(sdk.calls).toHaveLength(0);
		expect(lastAssistant(branch).stopReason).toBe("error");
	});
});

describe("childEnv", () => {
	it("strips both session-identity variables and tags the client", () => {
		const env = childEnv({ CLAUDE_CODE_SESSION_ID: "a", CLAUDE_CODE_REMOTE_SESSION_ID: "b", HOME: "/h" });
		expect(env).toEqual({ HOME: "/h", CLAUDE_AGENT_SDK_CLIENT_APP: "rpiv-claude" });
	});
});
