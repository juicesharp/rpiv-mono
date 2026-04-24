/**
 * /rpiv-setup — installs any SIBLINGS not present in ~/.pi/agent/settings.json.
 *
 * Serial `pi install <pkg>` loop via spawnPiInstall (Windows-safe).
 * Reports succeeded/failed split; prompts the user to restart Pi on success.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureBuiltinsDisabled } from "./ensure-builtins-disabled.js";
import { ensureSubagentConfig } from "./ensure-subagent-config.js";
import { findMissingSiblings } from "./package-checks.js";
import { spawnPiInstall } from "./pi-installer.js";
import { pruneLegacySiblings } from "./prune-legacy-siblings.js";
import type { SiblingPlugin } from "./siblings.js";

const INSTALL_TIMEOUT_MS = 120_000;
const STDERR_SNIPPET_CHARS = 300;

const MSG_INTERACTIVE_ONLY = "/rpiv-setup requires interactive mode";
const MSG_ALL_INSTALLED = "All rpiv-pi sibling dependencies already installed.";
const MSG_CANCELLED = "/rpiv-setup cancelled";
const MSG_CONFIRM_TITLE = "Install rpiv-pi dependencies?";
const MSG_RESTART = "Restart your Pi session to load the newly-installed extensions.";

const msgInstalling = (pkg: string) => `Installing ${pkg}…`;
const msgInstalledLine = (pkgs: string[]) => `✓ Installed: ${pkgs.join(", ")}`;
const msgFailedHeader = () => `✗ Failed:`;
const msgFailedLine = (pkg: string, err: string) => `  ${pkg}: ${err}`;
const msgSubagentSeeded = (keys: string[]) => `Seeded subagent config keys: ${keys.join(", ")}`;
const msgLegacyPruned = (entries: string[]) =>
	`Removed legacy subagent library from settings.json: ${entries.join(", ")}. Run \`pi uninstall\` to free disk space, then restart Pi.`;
const MSG_BUILTINS_DISABLED = "Disabled pi-subagents built-in agents (scout, planner, worker, …). Restart Pi to apply.";

type UI = {
	notify: (msg: string, sev: "info" | "warning" | "error") => void;
	confirm: (title: string, body: string) => Promise<boolean>;
};

function buildConfirmBody(missing: SiblingPlugin[]): string {
	return [
		"rpiv-pi will install the following Pi packages via `pi install`:",
		"",
		...missing.map((m) => `  • ${m.pkg}  (required — provides ${m.provides})`),
		"",
		"Each install is a separate `pi install <pkg>` invocation. Your",
		"~/.pi/agent/settings.json will be updated. Proceed?",
	].join("\n");
}

export function registerSetupCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv-setup", {
		description: "Install rpiv-pi's sibling extension plugins",
		handler: async (_args, ctx) => {
			const prune = pruneLegacySiblings();
			if (prune.pruned.length > 0) {
				ctx.ui.notify(msgLegacyPruned(prune.pruned), "info");
			}

			const builtins = ensureBuiltinsDisabled();
			if (builtins.disabled) {
				ctx.ui.notify(MSG_BUILTINS_DISABLED, "info");
			}

			const seed = ensureSubagentConfig();
			if (seed.merged.length > 0) {
				ctx.ui.notify(msgSubagentSeeded(seed.merged), "info");
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_INTERACTIVE_ONLY, "error");
				return;
			}

			const missing = findMissingSiblings();
			if (missing.length === 0) {
				ctx.ui.notify(MSG_ALL_INSTALLED, "info");
				return;
			}

			const confirmed = await ctx.ui.confirm(MSG_CONFIRM_TITLE, buildConfirmBody(missing));
			if (!confirmed) {
				ctx.ui.notify(MSG_CANCELLED, "info");
				return;
			}

			const { succeeded, failed } = await installMissing(ctx.ui, missing);
			ctx.ui.notify(buildReport(succeeded, failed), failed.length > 0 ? "warning" : "info");
		},
	});
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
			failed.push({ pkg, error: err instanceof Error ? err.message : String(err) });
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
