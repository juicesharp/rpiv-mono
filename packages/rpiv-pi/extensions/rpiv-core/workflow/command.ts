/**
 * /rpiv — slash command registration and handler.
 *
 * Parses args (preset name + feature description) using config-driven preset
 * names, resolves the preset, and delegates to runWorkflow(). Config is
 * loaded fresh from disk on every invocation via loadConfig().
 *
 * Registration follows setup-command.ts pattern: registerXxxCommand(pi) export,
 * separate named handler function, guard clauses first.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type LoadedConfigWithSource, loadConfig } from "./loadConfig.js";
import { runWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// Message constants
// ---------------------------------------------------------------------------

const MSG_INTERACTIVE_ONLY = "/rpiv requires interactive mode";
const MSG_USAGE = "Usage: /rpiv [preset] <feature description>";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse command args into preset name and remaining input text.
 * First token = preset name (if in presetNames); remaining text = feature description.
 * If no recognized preset, uses defaultPreset and the entire args string is the input.
 */
export function parseArgs(
	args: string,
	config: { presetNames: ReadonlySet<string>; defaultPreset: string },
): { preset: string; input: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { preset: config.defaultPreset, input: "" };
	}

	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

	if (config.presetNames.has(firstToken)) {
		const remaining = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		return { preset: firstToken, input: remaining };
	}

	// No recognized preset — use default, entire string is input
	return { preset: config.defaultPreset, input: trimmed };
}

// ---------------------------------------------------------------------------
// Help formatting
// ---------------------------------------------------------------------------

/**
 * Format available presets as a help listing with source indicator.
 */
export function formatPresetList(config: LoadedConfigWithSource): string {
	const lines = Array.from(config.presetNames, (name) => {
		const isDefault = name === config.defaultPreset;
		return `  ${name}${isDefault ? " (default)" : ""}`;
	});
	return `Available presets [${config.source}]:\n${lines.join("\n")}\n\n${MSG_USAGE}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWorkflowCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv", {
		description: "Run the rpiv skill pipeline: /rpiv [preset] [description]",
		handler: (args: string, ctx: ExtensionCommandContext) => handleWorkflowCommand(pi, args, ctx),
	});
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleWorkflowCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_INTERACTIVE_ONLY, "error");
		return;
	}

	const config = loadConfig(ctx.cwd);

	// Surface any warnings from config loading
	if (config.warnings?.length) {
		for (const warning of config.warnings) {
			ctx.ui.notify(warning, "warning");
		}
	}

	const { preset, input } = parseArgs(args, config);

	if (!input) {
		ctx.ui.notify(formatPresetList(config), "info");
		return;
	}

	await runWorkflow(ctx, { preset, input, dag: config.dag, pi });
}
