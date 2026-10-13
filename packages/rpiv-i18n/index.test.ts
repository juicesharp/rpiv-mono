/**
 * Handler-level tests for the /languages slash command — symmetric with the
 * handler-failure tests in rpiv-advisor + rpiv-web-tools + rpiv-voice.
 *
 * The SDK-level boolean return of saveLocaleConfig is asserted in i18n.test.ts.
 * This file exercises the persist-first save-then-apply invariant — i.e. that a failed disk write produces
 * an error notification AND skips applyLocale, leaving the in-memory locale
 * untouched so the next session's detection chain runs cleanly.
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./i18n-ui.js", () => ({
	showLanguagePicker: vi.fn(),
}));

import { __resetState, applyLocale, getActiveLocale } from "./i18n.js";
import { showLanguagePicker } from "./i18n-ui.js";
import registerI18n from "./index.js";

const LOCALE_CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-i18n", "locale.json");

function registerAndCaptureLanguages() {
	const { pi, captured } = createMockPi();
	registerI18n(pi);
	return { pi, captured, handler: () => captured.commands.get("languages")?.handler };
}

beforeEach(() => {
	__resetState();
	vi.mocked(showLanguagePicker).mockReset();
	rmSync(LOCALE_CONFIG_PATH, { force: true });
});

afterEach(() => {
	// Drain anything our EISDIR trick leaves behind.
	try {
		rmSync(LOCALE_CONFIG_PATH, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("/languages — command shape", () => {
	it("registers under 'languages'", () => {
		const { captured } = registerAndCaptureLanguages();
		expect(captured.commands.has("languages")).toBe(true);
	});
});

describe("/languages — !hasUI", () => {
	it("notifies error and never opens the picker", async () => {
		const { captured } = registerAndCaptureLanguages();
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("languages")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(showLanguagePicker).not.toHaveBeenCalled();
	});
});

describe("/languages — picker cancelled", () => {
	it("no-ops when showLanguagePicker resolves null", async () => {
		vi.mocked(showLanguagePicker).mockResolvedValueOnce(null);
		const { captured } = registerAndCaptureLanguages();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("languages")?.handler("", ctx as never);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(getActiveLocale()).toBeUndefined();
	});
});

describe("/languages — save failure (save-then-apply invariant, review I1 from prior round)", () => {
	it("EISDIR on save: error notify; applyLocale skipped; in-memory locale unchanged", async () => {
		if (process.platform === "win32") return;
		// Pre-seed in-memory locale so we can prove the handler does NOT touch it
		// on failure (would be silently reverted on next start otherwise).
		applyLocale("en");
		expect(getActiveLocale()).toBe("en");

		// Force EISDIR by mkdir at the file path — same trick web-tools + advisor use.
		mkdirSync(dirname(LOCALE_CONFIG_PATH), { recursive: true });
		mkdirSync(LOCALE_CONFIG_PATH, { recursive: true });

		vi.mocked(showLanguagePicker).mockResolvedValueOnce("uk");
		const { captured } = registerAndCaptureLanguages();
		const ctx = createMockCtx({ hasUI: true });

		await captured.commands.get("languages")?.handler("", ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save locale preference"), "error");
		// Success notify must NOT have fired — would deliver a contradictory
		// "Language: uk" alongside the error message.
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Language: uk"), "info");
		// applyLocale skipped — in-memory locale is whatever we pre-seeded, not "uk".
		expect(getActiveLocale()).toBe("en");
	});
});
