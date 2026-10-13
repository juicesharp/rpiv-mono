/**
 * The advisor never inherits the executor's callable tools (#295) — a REAL Pi
 * session, only the outbound completion is captured.
 *
 * Pi >= 1.0 records the executor's system prompt and tool loadout in the session
 * transcript as `system` messages carrying `toolsAdded`/`toolsRemoved`, and every
 * provider resolves the request's tools from those deltas — `tools: []` alone
 * does not clear them, so the advisor model could call a tool and return no text.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
} from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionToolContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return { ...actual, completeSimple: vi.fn() };
});

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { registerAdvisorTool, setAdvisorModel } from "./advisor/index.js";

/** Run one real executor turn so Pi records its system prompt + tool loadout in the transcript. */
async function executorSession(home: string): Promise<SessionManager> {
	const agentDir = join(home, "agent");
	const cwd = join(home, "cwd");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), "{}");
	const faux = fauxProvider({ provider: "faux", models: [{ id: "executor" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager,
		model: faux.getModel(),
	});
	await session.bindExtensions({});
	faux.setResponses([fauxAssistantMessage("working on it")]);
	await session.prompt("refactor the parser");
	session.dispose();
	return sessionManager;
}

describe("advisor request carries no executor tool declarations (#295)", () => {
	let home: string | undefined;
	const prevOffline = process.env.PI_OFFLINE;
	beforeEach(() => {
		process.env.PI_OFFLINE = "1";
	});
	afterEach(() => {
		if (prevOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prevOffline;
		if (home) rmSync(home, { recursive: true, force: true });
		home = undefined;
	});

	it("tools: [] holds even though the executor's transcript declares its tools", async () => {
		home = mkdtempSync(join(tmpdir(), "rpiv-advisor-tools-"));
		const sm = await executorSession(home);
		const transcript = convertToLlm(buildSessionContext(sm.getEntries(), sm.getLeafId()).messages);
		// Premise: the copied transcript itself declares the executor's tools.
		expect(getCurrentTools(transcript).map((t) => t.name)).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write"]),
		);

		vi.mocked(completeSimple).mockResolvedValueOnce(fauxAssistantMessage("advice") as never);
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = { ...createMockCtx(), sessionManager: sm } as unknown as ExtensionToolContext;
		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const context = vi.mocked(completeSimple).mock.calls[0]?.[1] as Context;
		const request = normalizeContext(context).messages; // what every provider builds its request from
		expect(getCurrentTools(request)).toEqual([]);
		// The executor's prompt text still reaches the advisor — only the declarations go.
		expect(getCurrentSystemPrompt(request)).toContain("You are an expert coding assistant");
	});
});
