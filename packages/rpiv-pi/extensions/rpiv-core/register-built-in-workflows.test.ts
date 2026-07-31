/**
 * Regression tests for the clean-install chicken-and-egg bug: a top-level
 * static `import … from "@juicesharp/rpiv-workflow"` in rpiv-core/index.ts made
 * the whole extension fail to load when the (peerDependency) sibling was
 * absent, suppressing the /rpiv-setup command + missing-sibling banner that
 * tell the user to install it. The fix defers the dependency behind a guarded
 * dynamic import; these tests pin both the happy path and the absent-sibling
 * no-op.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltInWorkflows } from "./register-built-in-workflows.js";

// Alphabetical: the three shipped presets.
const BUILT_IN_NAMES = ["build", "polish", "vet"];

describe("registerBuiltInWorkflows", () => {
	it("registers all built-in workflows (three presets) when rpiv-workflow is present", async () => {
		const { getBuiltIns, flushBuiltInProviders } = await import("@juicesharp/rpiv-workflow/internal");
		expect(getBuiltIns()).toEqual([]); // setup.ts beforeEach resets the registry

		await registerBuiltInWorkflows();
		// registerBuiltInWorkflows now registers a LAZY provider — the registry
		// stays empty until the first loadWorkflows() flushes it. Flush directly
		// to assert the provider contributes the three definitions.
		expect(getBuiltIns()).toEqual([]);
		await flushBuiltInProviders();

		expect(
			getBuiltIns()
				.map((w) => w.name)
				.sort(),
		).toEqual(BUILT_IN_NAMES);
	});

	it("is idempotent — re-registering does not duplicate", async () => {
		const { getBuiltIns, flushBuiltInProviders } = await import("@juicesharp/rpiv-workflow/internal");
		await registerBuiltInWorkflows();
		await registerBuiltInWorkflows();
		await flushBuiltInProviders();
		expect(getBuiltIns()).toHaveLength(BUILT_IN_NAMES.length);
	});

	describe("when the rpiv-workflow sibling is absent", () => {
		afterEach(() => {
			// registerBuiltInWorkflows imports the thin `/startup` entry, so the
			// absence simulation mocks THAT specifier (not the bare barrel).
			vi.doUnmock("@juicesharp/rpiv-workflow/startup");
			vi.resetModules();
		});

		it("no-ops without throwing and registers nothing", async () => {
			vi.resetModules();
			vi.doMock("@juicesharp/rpiv-workflow/startup", () => {
				throw Object.assign(new Error("Cannot find package '@juicesharp/rpiv-workflow/startup'"), {
					code: "ERR_MODULE_NOT_FOUND",
				});
			});

			// Re-import the registrar so its internal dynamic import resolves the mock.
			const fresh = await import("./register-built-in-workflows.js");
			await expect(fresh.registerBuiltInWorkflows()).resolves.toBeUndefined();

			const { getBuiltIns, flushBuiltInProviders } = await import("@juicesharp/rpiv-workflow/internal");
			await flushBuiltInProviders();
			expect(getBuiltIns()).toEqual([]);
		});
	});
});
