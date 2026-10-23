/**
 * Codemode "only" regression (#310) — REAL Pi session, no mocks.
 *
 * With `codemode.mode: "only"`, Pi stops declaring active `direct` tools to the
 * model and lists them in the `codemode` description instead, so the model
 * reaches them only from scripts. An interactive tool must stay a top-level
 * call: the test drives a real `AgentSession` with Pi's built-in codemode
 * extension and this package's entry, and reads the tools the request declares
 * to the (faux) model. The entry goes in as a factory, not a path: a path loads
 * a second copy outside Vitest, whose coverage merges badly with this one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import askUserQuestion from "./index.ts";

/** Any UI context other than Pi's no-op one makes `ctx.hasUI` true; its methods no-op. */
const uiContext = new Proxy({}, { get: () => () => undefined }) as ExtensionUIContext;

/** Tool names a request declares: system messages add and remove tools in order. */
function declaredTools(messages: readonly Message[]): string[] {
	const declared = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) declared.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) declared.delete(tool.name);
	}
	return [...declared];
}

describe("ask_user_question stays declared under codemode 'only' (#310)", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let prevOffline: string | undefined;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
	let runtime: ModelRuntime;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "rpiv-auq-codemode-"));
		agentDir = join(home, "agent");
		cwd = join(home, "cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), "{}");
		// The issue's setting.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
		);
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

	it("declares ask_user_question to the model while codemode hides the direct tools", async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				{ name: "codemode", factory: createCodemodeExtension() },
				{ name: "rpiv-ask-user-question", factory: askUserQuestion },
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			model: faux.getModel(),
		});
		await session.bindExtensions({ uiContext });

		let declared: string[] = [];
		faux.setResponses([
			(context) => {
				declared = declaredTools(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);
		try {
			await session.prompt("go");
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}

		expect(declared).toContain("codemode");
		expect(declared).not.toContain("bash");
		expect(declared).toContain("ask_user_question");
	});
});
