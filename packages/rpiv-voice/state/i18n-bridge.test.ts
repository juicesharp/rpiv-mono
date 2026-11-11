import { afterEach, describe, expect, it, vi } from "vitest";

// The module performs `await import("@juicesharp/rpiv-i18n")` at top level and
// caches the result. To exercise both branches (SDK present vs. SDK missing)
// we re-import after resetting the module registry with the dep mocked
// differently each time.

describe("i18n-bridge", () => {
	afterEach(() => {
		vi.doUnmock("@juicesharp/rpiv-i18n");
		vi.resetModules();
	});

	it("uses the rpiv-i18n SDK when it is installed", async () => {
		const scopeFn = vi.fn((_k: string, fb: string) => `[scoped] ${fb}`);
		const scope = vi.fn(() => scopeFn);
		const getActiveLocale = vi.fn(() => "ru");
		vi.resetModules();
		vi.doMock("@juicesharp/rpiv-i18n", () => ({ scope, getActiveLocale }));

		const mod = await import("./i18n-bridge.ts");
		expect(scope).toHaveBeenCalledWith("@juicesharp/rpiv-voice");
		expect(mod.t("k", "fallback")).toBe("[scoped] fallback");
		expect(mod.getActiveLocale()).toBe("ru");
	});

	it("falls back to identity + undefined locale when the SDK is missing", async () => {
		vi.resetModules();
		vi.doMock("@juicesharp/rpiv-i18n", () => {
			throw new Error("module not found");
		});

		const mod = await import("./i18n-bridge.ts");
		expect(mod.t("any.key", "the english fallback")).toBe("the english fallback");
		expect(mod.getActiveLocale()).toBeUndefined();
		expect(mod.I18N_NAMESPACE).toBe("@juicesharp/rpiv-voice");
	});
});
