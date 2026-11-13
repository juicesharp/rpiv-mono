/**
 * Real-session proof that the context sync reaches the outgoing request
 * (issue #222), not just the extension's internal bookkeeping.
 *
 * A scripted faux model drives a real `AgentSession`: it creates tasks in one
 * session, the session is closed and re-opened from disk (what `/resume` and
 * `pi -c` do — `session_start` replays the branch), and a second run's
 * `context_with_system` output is inspected by a spy extension registered AFTER
 * rpiv-todo. Context hooks chain, so the spy sees exactly what the next handler
 * and Pi would send. Nothing is mocked at the Pi boundary: a hook that never
 * fires, or a chain that drops the injected block, fails the test.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import todo from "./index.ts";

/** Flatten a message's content into plain text for assertions. */
function textOf(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
		)
		.join("");
}

describe("context sync reaches the real outgoing request", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let sessionDir: string;
	let prevOffline: string | undefined;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
	let runtime: ModelRuntime;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "rpiv-todo-context-sync-"));
		agentDir = join(home, "agent");
		cwd = join(home, "cwd");
		sessionDir = join(home, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), "{}");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
		prevOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		runtime.registerNativeProvider(faux.provider);
	});

	afterEach(() => {
		if (prevOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prevOffline;
		rmSync(home, { recursive: true, force: true });
	});

	/**
	 * Open a session with a context spy registered after rpiv-todo, so it
	 * observes the chained result of the injection hook.
	 */
	async function openSession(sessionManager: SessionManager): Promise<{ session: AgentSession; contexts: string[] }> {
		const contexts: string[] = [];
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				{ name: "rpiv-todo", factory: (pi) => todo(pi) },
				{
					name: "context-spy",
					factory: (pi) => {
						pi.on("context_with_system", (event) => {
							contexts.push(textOf(event.messages.at(-1)));
						});
					},
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			resourceLoader,
			settingsManager,
			sessionManager,
			model: faux.getModel(),
		});
		await session.bindExtensions({});
		return { session, contexts };
	}

	async function closeSession(session: AgentSession): Promise<void> {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}

	const toolCall = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));

	it("leaves a complete resumed transcript alone (no redundant injection)", async () => {
		// Session 1: create two tasks through the real tool.
		const first = await openSession(SessionManager.create(cwd, sessionDir));
		faux.setResponses([
			toolCall("todo", { action: "create", tasks: [{ subject: "Task A" }, { subject: "Task B" }] }),
			fauxAssistantMessage("created"),
		]);
		await first.session.prompt("start");
		const file = first.session.sessionFile;
		await closeSession(first.session);
		if (!file) throw new Error("session was not persisted");

		// Session 2: resumed from disk. The transcript still carries the `todo`
		// tool results, so the model CAN see the list — appending it again would be
		// pure token waste. This is the regression a real `pi -c` run exposed.
		const second = await openSession(SessionManager.open(file, sessionDir));
		try {
			faux.setResponses([fauxAssistantMessage("ok")]);
			await second.session.prompt("continue");
			expect(second.contexts.some((text) => text.includes("todo-resync"))).toBe(false);
			expect(second.contexts.some((text) => text.includes("todo-review"))).toBe(false);
		} finally {
			await closeSession(second.session);
		}
	});

	it("does not write anything into the session branch on resume", async () => {
		const first = await openSession(SessionManager.create(cwd, sessionDir));
		faux.setResponses([toolCall("todo", { action: "create", subject: "Only task" }), fauxAssistantMessage("ok")]);
		await first.session.prompt("start");
		const file = first.session.sessionFile;
		await closeSession(first.session);
		if (!file) throw new Error("session was not persisted");

		const second = await openSession(SessionManager.open(file, sessionDir));
		try {
			faux.setResponses([fauxAssistantMessage("ok")]);
			await second.session.prompt("continue");
			const customMessages = second.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "custom");
			expect(customMessages).toEqual([]);
		} finally {
			await closeSession(second.session);
		}
	});
});
