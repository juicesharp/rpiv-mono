/**
 * pi-compat tests — the child model-services bridge.
 *
 * Two layers:
 *   - Unit: `getRegistryRuntime` / `childModelServices` pick the right option
 *     for a registry with and without the runtime slot (Pi ≥ 0.80.8 vs ≤ 0.80.7).
 *   - SDK contract: a REAL `createAgentSession` (no mocks) proves a child built
 *     with `childModelServices(launcherRegistry)` shares the launcher's model
 *     state on whichever Pi host is installed — a built-in provider authed only
 *     by a runtime (`--api-key`-style) key, an extension-registered provider,
 *     and a settings default model that lives on that extension provider.
 *     Version-agnostic: the launcher services are built the way the installed
 *     host builds them (ModelRuntime on ≥ 0.80.8, AuthStorage+ModelRegistry before).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piSdk from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childModelServices, getRegistryRuntime } from "./pi-compat.js";

describe("getRegistryRuntime", () => {
	it("returns the runtime slot when it carries streamSimple", () => {
		const runtime = { streamSimple: () => undefined };
		expect(getRegistryRuntime({ runtime })).toBe(runtime);
	});

	it.each([
		["a non-object registry", undefined],
		["a registry without the slot (Pi ≤ 0.80.7)", { find: () => undefined }],
		["a non-object slot", { runtime: "x" }],
		["a slot without streamSimple", { runtime: { getModel: () => undefined } }],
	])("returns undefined for %s", (_label, registry) => {
		expect(getRegistryRuntime(registry)).toBeUndefined();
	});

	it("fails soft when reading the slot throws", () => {
		const registry = Object.defineProperty({}, "runtime", {
			get() {
				throw new Error("private");
			},
		});
		expect(getRegistryRuntime(registry)).toBeUndefined();
	});
});

describe("childModelServices", () => {
	it("hands the child the launcher runtime on Pi ≥ 0.80.8 (and not the ignored registry)", () => {
		const runtime = { streamSimple: () => undefined };
		const registry = { runtime } as unknown as ModelRegistry;
		expect(childModelServices(registry)).toEqual({ modelRuntime: runtime });
	});

	it("passes the registry through on Pi ≤ 0.80.7", () => {
		const registry = { find: () => undefined } as unknown as ModelRegistry;
		const services = childModelServices(registry);
		expect(services).toEqual({ modelRegistry: registry });
		expect((services as { modelRegistry: ModelRegistry }).modelRegistry).toBe(registry);
	});
});

// ---------------------------------------------------------------------------
// SDK contract — real child sessions against the installed Pi host.
// ---------------------------------------------------------------------------

const EXT_PROVIDER = "rpiv-ext-prov";
const EXT_MODEL = "m1";
const RUNTIME_KEY = "sk-rpiv-runtime-only";
const EXT_PROVIDER_CONFIG = {
	baseUrl: "http://127.0.0.1:9/v1",
	api: "openai-completions",
	apiKey: "ext-key",
	models: [
		{
			id: EXT_MODEL,
			name: EXT_MODEL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		},
	],
};

/** Host ≥ 0.80.8 exports ModelRuntime; ≤ 0.80.7 exports AuthStorage instead. Both are read
 *  untyped so this file compiles against either generation of the SDK's types. */
type RuntimeLike = {
	setRuntimeApiKey(provider: string, key: string): Promise<void>;
	registerProvider(name: string, config: unknown): void;
};
const ModelRuntimeCtor = (piSdk as Record<string, unknown>).ModelRuntime as
	| { create(opts: { authPath: string; modelsPath: string }): Promise<RuntimeLike> }
	| undefined;
const AuthStorageCtor = (piSdk as Record<string, unknown>).AuthStorage as {
	create(authPath: string): { setRuntimeApiKey(provider: string, key: string): void };
};
const ModelRegistryCtor = piSdk.ModelRegistry as unknown as {
	new (runtime: RuntimeLike): ModelRegistry;
	create(auth: unknown, modelsPath: string): ModelRegistry;
};

/**
 * Build the launcher's model services the way the installed host's `pi` main
 * does, then apply launcher-only state: a runtime API key for a built-in
 * provider (what `pi --api-key` does) and an extension-registered provider
 * (what `pi.registerProvider` does in an extension the child never loads).
 */
async function createLauncherRegistry(agentDir: string): Promise<ModelRegistry> {
	const authPath = join(agentDir, "auth.json");
	const modelsPath = join(agentDir, "models.json");
	if (ModelRuntimeCtor) {
		const runtime = await ModelRuntimeCtor.create({ authPath, modelsPath });
		await runtime.setRuntimeApiKey("anthropic", RUNTIME_KEY);
		runtime.registerProvider(EXT_PROVIDER, EXT_PROVIDER_CONFIG);
		return new ModelRegistryCtor(runtime);
	}
	const auth = AuthStorageCtor.create(authPath);
	auth.setRuntimeApiKey("anthropic", RUNTIME_KEY);
	const registry = ModelRegistryCtor.create(auth, modelsPath);
	registry.registerProvider(EXT_PROVIDER, EXT_PROVIDER_CONFIG as never);
	return registry;
}

/** The child's model view through the same facade extensions get, on either host generation. */
function childRegistry(session: unknown): ModelRegistry {
	const s = session as { modelRuntime?: RuntimeLike; modelRegistry?: ModelRegistry };
	return s.modelRuntime ? new ModelRegistryCtor(s.modelRuntime) : (s.modelRegistry as ModelRegistry);
}

describe("childModelServices — real child sessions share the launcher's model state", () => {
	let agentDir: string;
	let cwd: string;
	let prevOffline: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "rpiv-pi-compat-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "rpiv-pi-compat-cwd-"));
		writeFileSync(join(agentDir, "auth.json"), "{}");
		prevOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1"; // no catalog network refresh
	});

	afterEach(() => {
		if (prevOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prevOffline;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	async function spawnChild(launcher: ModelRegistry, model?: ReturnType<ModelRegistry["find"]>) {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		// No extensions discovered under the temp dirs: the child can only know the
		// extension provider through the shared launcher services.
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			...childModelServices(launcher),
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			model,
		});
		return session;
	}

	it("built-in provider: the child sees a runtime-only API key", async () => {
		const launcher = await createLauncherRegistry(agentDir);
		const builtIn = launcher.getAll().find((m) => m.provider === "anthropic");
		expect(builtIn).toBeDefined();

		const session = await spawnChild(launcher, builtIn);
		try {
			expect(session.model?.provider).toBe("anthropic");
			expect(await childRegistry(session).getApiKeyForProvider("anthropic")).toBe(RUNTIME_KEY);
		} finally {
			session.dispose();
		}
	});

	it("extension provider: the child resolves and authenticates the launcher-registered provider", async () => {
		const launcher = await createLauncherRegistry(agentDir);
		const session = await spawnChild(launcher, launcher.find(EXT_PROVIDER, EXT_MODEL));
		try {
			expect(session.model).toMatchObject({ provider: EXT_PROVIDER, id: EXT_MODEL });
			const registry = childRegistry(session);
			expect(registry.find(EXT_PROVIDER, EXT_MODEL)).toBeDefined();
			expect(await registry.getApiKeyForProvider(EXT_PROVIDER)).toBe("ext-key");
		} finally {
			session.dispose();
		}
	});

	it("no override: a settings default on an extension provider is honoured, not replaced", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: EXT_PROVIDER, defaultModel: EXT_MODEL }),
		);
		const launcher = await createLauncherRegistry(agentDir);
		const session = await spawnChild(launcher);
		try {
			expect(session.model).toMatchObject({ provider: EXT_PROVIDER, id: EXT_MODEL });
		} finally {
			session.dispose();
		}
	});
});
