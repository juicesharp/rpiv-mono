/**
 * rpiv-core — Pure-orchestrator extension for rpiv-pi.
 *
 * Composes session hooks and the slash commands. All logic lives in the
 * registrar modules; this file is the table of contents.
 *
 * Tool-owning plugins are siblings (see siblings.ts); install via /rpiv-setup.
 *
 * Workflow runtime + `/wf` command live in `@juicesharp/rpiv-workflow`. We
 * contribute three built-in workflows (small / mid / large) via the
 * sibling's `registerBuiltIns` programmatic API so they're available to
 * users running `/wf` without authoring their own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLAG_DEBUG } from "./constants.js";
import { registerBuiltInWorkflows } from "./register-built-in-workflows.js";
import { registerSessionHooks } from "./session-hooks.js";
import { registerSetupCommand } from "./setup-command.js";
import { registerUpdateAgentsCommand } from "./update-agents-command.js";

export default function (pi: ExtensionAPI) {
	pi.registerFlag(FLAG_DEBUG, {
		description: "Show injected guidance and git-context messages",
		type: "boolean",
		default: false,
	});
	// These three register UNCONDITIONALLY and FIRST — they must work on a clean
	// install where the rpiv-workflow sibling is absent, so the missing-sibling
	// banner and /rpiv-setup are what guide the user to install it.
	registerSessionHooks(pi);
	registerUpdateAgentsCommand(pi);
	registerSetupCommand(pi);
	// Built-in workflows feed the sibling's `/wf` command. Deferred behind a
	// dynamic import so a missing sibling degrades gracefully instead of taking
	// the whole extension down (see register-built-in-workflows.ts). Fire-and-
	// forget: the registry is read lazily at `/wf` time, long after this settles.
	registerBuiltInWorkflows().catch((err: unknown) => {
		console.error("[rpiv-core] failed to register built-in workflows:", err);
	});
}
