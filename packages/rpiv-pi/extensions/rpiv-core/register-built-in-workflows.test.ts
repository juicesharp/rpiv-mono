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
import { isModuleNotFound, registerBuiltInWorkflows } from "./register-built-in-workflows.js";

const BUILT_IN_NAMES = ["arch", "build", "polish", "ship", "vet"];

describe("isModuleNotFound", () => {
	it("is true for an ERR_MODULE_NOT_FOUND error", () => {
		const err = Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
		expect(isModuleNotFound(err)).toBe(true);
	});

	it("is false for other error codes and codeless errors", () => {
		expect(isModuleNotFound(Object.assign(new Error("boom"), { code: "ERR_OTHER" }))).toBe(false);
		expect(isModuleNotFound(new Error("no code"))).toBe(false);
	});

	it("is false for non-object values", () => {
		expect(isModuleNotFound(null)).toBe(false);
		expect(isModuleNotFound(undefined)).toBe(false);
		expect(isModuleNotFound("ERR_MODULE_NOT_FOUND")).toBe(false);
	});
});

describe("registerBuiltInWorkflows", () => {
	it("registers the five built-in workflows when rpiv-workflow is present", async () => {
		const { getBuiltIns } = await import("@juicesharp/rpiv-workflow/internal");
		expect(getBuiltIns()).toEqual([]); // setup.ts beforeEach resets the registry

		await registerBuiltInWorkflows();

		expect(
			getBuiltIns()
				.map((w) => w.name)
				.sort(),
		).toEqual(BUILT_IN_NAMES);
	});

	it("is idempotent — re-registering does not duplicate", async () => {
		const { getBuiltIns } = await import("@juicesharp/rpiv-workflow/internal");
		await registerBuiltInWorkflows();
		await registerBuiltInWorkflows();
		expect(getBuiltIns()).toHaveLength(BUILT_IN_NAMES.length);
	});

	describe("when the rpiv-workflow sibling is absent", () => {
		afterEach(() => {
			vi.doUnmock("@juicesharp/rpiv-workflow");
			vi.resetModules();
		});

		it("no-ops without throwing and registers nothing", async () => {
			vi.resetModules();
			vi.doMock("@juicesharp/rpiv-workflow", () => {
				throw Object.assign(new Error("Cannot find package '@juicesharp/rpiv-workflow'"), {
					code: "ERR_MODULE_NOT_FOUND",
				});
			});

			// Re-import the registrar so its internal dynamic import resolves the mock.
			const fresh = await import("./register-built-in-workflows.js");
			await expect(fresh.registerBuiltInWorkflows()).resolves.toBeUndefined();

			const { getBuiltIns } = await import("@juicesharp/rpiv-workflow/internal");
			expect(getBuiltIns()).toEqual([]);
		});
	});
});
