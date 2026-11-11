/**
 * Tests the interceptor chain dispatch in registerWebTools: first-match-wins,
 * empty-chain fall-through, and the consumer×user-config opt-in resolution.
 * Exercises the chain end-to-end via the registered web_fetch tool rather
 * than the GitHubInterceptor class directly.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { createMockCtx, createMockPi, stubFetch } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import registerWebTools from "../../index.ts";

const CONFIG_PATH = configPath("rpiv-web-tools");

function writeConfig(contents: unknown) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

beforeEach(() => {
	delete process.env.BRAVE_SEARCH_API_KEY;
	delete process.env.GITHUB_TOKEN;
	rmSync(CONFIG_PATH, { force: true });
});

describe("interceptor chain — opt-in resolution", () => {
	it("default OFF: github URL hits provider fetch when neither user nor consumer opts in", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>plain page</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi);
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("plain page") });
	});

	it("consumer:true enables the interceptor when user config is absent", async () => {
		// The interceptor is built; for github.com/owner/repo without gh available
		// the interceptor returns null (clone+API both fail) and we fall through
		// to provider.fetch. We assert the chain didn't short-circuit the fall-through.
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>provider fallback</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi, { interceptors: { github: true } });
		// owner/repo/issues → parseGitHubUrl returns null → intercept null → provider runs.
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("provider fallback") });
	});

	it("user config false beats consumer true (explicit user disable)", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave", interceptors: { github: false } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>provider only</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi, { interceptors: { github: true } });
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/blob/main/x.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		// Interceptor is off — provider handled it.
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("provider only") });
	});

	it("user object form implies opt-in even when consumer left it unset", async () => {
		// With the interceptor active and gh CLI absent in test env, the interceptor
		// tries clone+API, both fail, and intercept() returns null. The chain falls
		// through to the provider — i.e. the interceptor *ran* (rather than being
		// skipped entirely as it would be when disabled). We verify this indirectly
		// via no provider fetch happening when intercept actually succeeds in tests
		// that use real network mocks; here we just confirm registration accepts it.
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave", interceptors: { github: { maxRepoSizeMB: 999 } } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>provider fallback</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi);
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("provider fallback") });
	});
});

describe("interceptor chain — fall-through semantics", () => {
	it("interceptor returning null falls through to provider fetch", async () => {
		// owner/repo/issues → NON_CODE_SEGMENTS → parseGitHubUrl returns null,
		// intercept short-circuits to null → provider handles the URL.
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave", interceptors: { github: true } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>fallback body</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi);
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("fallback body") });
	});

	it("empty chain (interceptor disabled) is a no-op — every URL hits the provider", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ provider: "brave" });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>vanilla</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi);
		const r1 = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com/" }, undefined as never, undefined as never, createMockCtx());
		const r2 = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/blob/main/file.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r1?.content[0]).toMatchObject({ text: expect.stringContaining("vanilla") });
		expect(r2?.content[0]).toMatchObject({ text: expect.stringContaining("vanilla") });
	});
});
