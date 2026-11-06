/**
 * Real multi-turn proof for the context sync (issues #222 / #159).
 *
 * The single-turn resume test proves the hook fires once; this one drives a
 * real `AgentSession` across enough turns to cross the default
 * `staleAfterTurns` threshold, and exercises a real `session.compact()`. The
 * assertions are on the chained `context_with_system` output, so an off-by-one
 * in the counter, a missing settle continuation, or a resync that never fires
 * after compaction all fail here.
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

/** Default from `config.ts` — the scenario must cross it, not a mocked value. */
const STALE_AFTER_TURNS = 12;

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

describe("context sync — real multi-turn session", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let sessionDir: string;
	let prevHome: string | undefined;
	let prevOffline: string | undefined;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
	let runtime: ModelRuntime;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "rpiv-todo-multiturn-"));
		agentDir = join(home, "agent");
		cwd = join(home, "cwd");
		sessionDir = join(home, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), "{}");
		// Keep a tiny recent window so a scripted session can actually reach a
		// compaction boundary; the default keeps more than a faux reply can produce.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 100 } }));
		// Pin HOME so the extension reads the DEFAULT thresholds from an absent
		// config file instead of the developer's real ~/.config/rpiv-todo/config.json.
		prevHome = process.env.HOME;
		prevOffline = process.env.PI_OFFLINE;
		process.env.HOME = home;
		process.env.PI_OFFLINE = "1";
		runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		runtime.registerNativeProvider(faux.provider);
	});

	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prevOffline;
		rmSync(home, { recursive: true, force: true });
	});

	async function openSession(): Promise<{ session: AgentSession; contexts: string[] }> {
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
			sessionManager: SessionManager.create(cwd, sessionDir),
			model: faux.getModel(),
		});
		await session.bindExtensions({});
		return { session, contexts };
	}

	const toolCall = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));

	/** One scripted prompt with a single text response. */
	async function step(session: AgentSession, label: string, length = 0): Promise<void> {
		const filler = length > 0 ? " " + "x".repeat(length) : "";
		faux.setResponses([fauxAssistantMessage(`ok ${label}${filler}`)]);
		await session.prompt(label);
	}

	it("crosses the default stale threshold across turns and nudges exactly once", async () => {
		const { session, contexts } = await openSession();
		try {
			// Turn 1 — real task creation through the real tool.
			faux.setResponses([
				toolCall("todo", { action: "create", tasks: [{ subject: "Task A" }, { subject: "Task B" }] }),
				fauxAssistantMessage("created"),
			]);
			await session.prompt("create the plan");

			// Drain the create turn: no reminder should have been armed yet.
			expect(contexts.some((text) => text.includes("<todo-review"))).toBe(false);

			// STALE_AFTER_TURNS turns with no `todo` call. The threshold is crossed
			// on the last one, where the settle boundary must request one extra
			// request so the reminder is not dropped.
			for (let i = 1; i <= STALE_AFTER_TURNS; i++) {
				await step(session, `turn ${i}`);
			}
			await session.waitForIdle();

			const reviews = contexts.filter((text) => text.includes("<todo-review"));
			expect(reviews).toHaveLength(1);
			expect(reviews[0]).toContain("[ ] #1 Task A");
			expect(reviews[0]).toContain("[ ] #2 Task B");
			// A brand-new session restores nothing, so no resync was due.
			expect(contexts.filter((text) => text.includes("<todo-resync"))).toHaveLength(0);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("a successful todo call inside the window resets the counter", async () => {
		const { session, contexts } = await openSession();
		try {
			faux.setResponses([toolCall("todo", { action: "create", subject: "Only" }), fauxAssistantMessage("created")]);
			await session.prompt("create");

			// Control experiment: the run spans MORE turns than the threshold, but a
			// real `update` in the middle resets the counter, so no reminder is due.
			// Without the reset this run would cross it twice.
			for (let i = 1; i <= 6; i++) await step(session, `before ${i}`);

			faux.setResponses([
				toolCall("todo", { action: "update", id: 1, status: "in_progress" }),
				fauxAssistantMessage("updated"),
			]);
			await session.prompt("mark in progress");

			for (let i = 1; i <= 6; i++) await step(session, `after ${i}`);
			await session.waitForIdle();
			expect(contexts.some((text) => text.includes("<todo-review"))).toBe(false);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("re-states the list after a real compaction", async () => {
		const { session, contexts } = await openSession();
		try {
			faux.setResponses([
				toolCall("todo", { action: "create", tasks: [{ subject: "Alpha" }, { subject: "Beta" }] }),
				fauxAssistantMessage("created"),
			]);
			await session.prompt("create");
			// Real compaction refuses a session that is still tiny: grow it with
			// substantial messages until `prepareCompaction` can find a split point.
			for (let i = 1; i <= 25; i++) {
				await step(session, `bulk ${i}`, 2000);
			}
			await session.waitForIdle();
			contexts.length = 0;

			// Real compaction path: a split turn needs both a prefix summary and the
			// main history summary, so queue two scripted replies.
			faux.setResponses([
				fauxAssistantMessage("Prefix: partial turn."),
				fauxAssistantMessage("Earlier: created two tasks."),
			]);
			await session.compact();
			await session.waitForIdle();

			await step(session, "after compact");

			const resyncs = contexts.filter((text) => text.includes("<todo-resync"));
			expect(resyncs.length).toBeGreaterThan(0);
			expect(resyncs[0]).toContain("0/2 completed");
			expect(resyncs[0]).toContain("[ ] #1 Alpha");
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});
});
