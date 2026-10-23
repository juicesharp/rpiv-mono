/**
 * @juicesharp/rpiv-i18n — Pi extension entry point.
 *
 * Wires:
 *   - --locale CLI flag (pi.registerFlag)
 *   - /languages slash command (interactive picker)
 *   - session_start hook (applies flag → config → LANG → English priority chain)
 *
 * Exposes i18n state via globalThis[Symbol.for("rpiv-i18n")] as plain data.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
	applyLocale,
	detectLocaleFromConfigAndEnv,
	getActiveLocale,
	SUPPORTED_LOCALES,
	saveLocaleConfig,
} from "./i18n.ts";
import { showLanguagePicker } from "./i18n-ui.ts";

const FLAG_NAME = "locale";
const COMMAND_NAME = "languages";
const NO_LOCALE_VALUE = "__system__";
const CHECKMARK = " ✓";
const MSG_REQUIRES_INTERACTIVE = "/languages requires interactive mode";
const MSG_PERSIST_FAILED = "Failed to save locale preference — selection not persisted";
const msgLocaleSet = (code: string | undefined) => (code ? `Language: ${code}` : "Language: system default");

export default function (pi: ExtensionAPI): void {
	pi.registerFlag(FLAG_NAME, {
		type: "string",
		description: "UI locale code (e.g. en, uk, es, de)",
	});

	pi.on("session_start", async () => {
		const flagValue = pi.getFlag(FLAG_NAME);
		const fromFlag = typeof flagValue === "string" && flagValue.length > 0 ? flagValue : undefined;
		applyLocale(fromFlag ?? detectLocaleFromConfigAndEnv());
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Select UI language for rpiv-* TUI strings",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}
			const current = getActiveLocale();
			const items: SelectItem[] = SUPPORTED_LOCALES.map((l) => ({
				value: l.code,
				label: `${l.label} (${l.code})${current === l.code ? CHECKMARK : ""}`,
			}));
			items.push({
				value: NO_LOCALE_VALUE,
				label: current === undefined ? `System default${CHECKMARK}` : "System default",
			});

			const choice = await showLanguagePicker(ctx, items);
			if (!choice) return;

			const next = choice === NO_LOCALE_VALUE ? undefined : choice;
			if (!saveLocaleConfig(next)) {
				// Honor the documented save-then-apply invariant: a successful
				// applyLocale followed by a failed disk write would silently
				// revert at next start with no diagnostic surface.
				ctx.ui.notify(MSG_PERSIST_FAILED, "error");
				return;
			}
			applyLocale(next);
			ctx.ui.notify(msgLocaleSet(next), "info");
		},
	});
}
