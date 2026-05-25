/**
 * /rpiv-setup — installs any SIBLINGS not present in the active Pi settings file
 * and prunes deprecated entries (e.g. the unscoped `npm:pi-subagents` from
 * the rpiv-pi 0.12.x → 0.14.0 line). Both mutations are previewed in the
 * confirmation dialog and only executed after the user agrees.
 *
 * Serial `pi install <pkg>` loop via spawnPiInstall (Windows-safe).
 * Reports succeeded/failed split; prompts the user to restart Pi on success.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findMissingSiblings } from "./package-checks.js";
import { spawnPiInstall } from "./pi-installer.js";
import { findLegacySiblings, pruneLegacySiblings } from "./prune-legacy-siblings.js";
import type { SiblingPlugin } from "./siblings.js";
import { getPiAgentSettingsPath, toErrorMessage } from "./utils.js";

const INSTALL_TIMEOUT_MS = 120_000;
const STDERR_SNIPPET_CHARS = 300;

const MSG_INTERACTIVE_ONLY = "/rpiv-setup requires interactive mode";
const MSG_NOTHING_TO_DO = "All rpiv-pi sibling dependencies already installed.";
const MSG_CANCELLED = "/rpiv-setup cancelled";
const MSG_CONFIRM_TITLE = "Apply rpiv-pi setup changes?";
const MSG_RESTART = "Restart your Pi session to load the newly-installed extensions.";

const msgInstalling = (pkg: string) => `Installing ${pkg}…`;
const msgInstalledLine = (pkgs: string[]) => `✓ Installed: ${pkgs.join(", ")}`;
const msgFailedHeader = () => `✗ Failed:`;
const msgFailedLine = (pkg: string, err: string) => `  ${pkg}: ${err}`;
const msgLegacyPruned = (entries: string[]) =>
	`Removed legacy subagent library from settings.json: ${entries.join(", ")}. Run \`pi uninstall\` to free disk space, then restart Pi.`;

type UI = {
	notify: (msg: string, sev: "info" | "warning" | "error") => void;
	confirm: (title: string, body: string) => Promise<boolean>;
};

function buildConfirmBody(missing: SiblingPlugin[], legacyEntries: string[]): string {
	const lines: string[] = ["rpiv-pi will apply the following changes:", ""];
	if (missing.length > 0) {
		lines.push("Install via `pi install`:");
		for (const m of missing) lines.push(`  • ${m.pkg}  (required — provides ${m.provides})`);
		lines.push("");
	}
	const settingsPath = getPiAgentSettingsPath();
	if (legacyEntries.length > 0) {
		lines.push(`Remove from \`${settingsPath}\` (deprecated):`);
		for (const entry of legacyEntries) lines.push(`  • ${entry}`);
		lines.push("");
	}
	lines.push(`Your \`${settingsPath}\` will be updated. Proceed?`);
	return lines.join("\n");
}

export function registerSetupCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv-setup", {
		description: "Install rpiv-pi's sibling extension plugins",
		handler: handleSetupCommand,
	});
}

async function handleSetupCommand(_args: string, ctx: { hasUI: boolean; ui: UI }): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_INTERACTIVE_ONLY, "error");
		return;
	}

	const missing = findMissingSiblings();
	const legacyEntries = findLegacySiblings();
	if (missing.length === 0 && legacyEntries.length === 0) {
		ctx.ui.notify(MSG_NOTHING_TO_DO, "info");
		return;
	}

	const confirmed = await ctx.ui.confirm(MSG_CONFIRM_TITLE, buildConfirmBody(missing, legacyEntries));
	if (!confirmed) {
		ctx.ui.notify(MSG_CANCELLED, "info");
		return;
	}

	if (legacyEntries.length > 0) {
		const prune = pruneLegacySiblings();
		if (prune.pruned.length > 0) {
			ctx.ui.notify(msgLegacyPruned(prune.pruned), "info");
		}
	}

	if (missing.length === 0) return;

	const { succeeded, failed } = await installMissing(ctx.ui, missing);
	ctx.ui.notify(buildReport(succeeded, failed), failed.length > 0 ? "warning" : "info");
}

async function installMissing(
	ui: UI,
	missing: SiblingPlugin[],
): Promise<{ succeeded: string[]; failed: Array<{ pkg: string; error: string }> }> {
	const succeeded: string[] = [];
	const failed: Array<{ pkg: string; error: string }> = [];
	for (const { pkg } of missing) {
		ui.notify(msgInstalling(pkg), "info");
		try {
			const result = await spawnPiInstall(pkg, INSTALL_TIMEOUT_MS);
			if (result.code === 0) {
				succeeded.push(pkg);
			} else {
				failed.push({
					pkg,
					error: (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, STDERR_SNIPPET_CHARS),
				});
			}
		} catch (err) {
			failed.push({ pkg, error: toErrorMessage(err) });
		}
	}
	return { succeeded, failed };
}

function buildReport(succeeded: string[], failed: Array<{ pkg: string; error: string }>): string {
	const lines: string[] = [];
	if (succeeded.length > 0) lines.push(msgInstalledLine(succeeded));
	if (failed.length > 0) {
		lines.push(msgFailedHeader());
		for (const { pkg, error } of failed) lines.push(msgFailedLine(pkg, error));
	}
	if (succeeded.length > 0) {
		lines.push("");
		lines.push(MSG_RESTART);
	}
	return lines.join("\n");
}
