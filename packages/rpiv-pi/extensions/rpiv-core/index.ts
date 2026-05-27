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
import { registerBuiltIns } from "@juicesharp/rpiv-workflow";
import { builtInWorkflows } from "./built-in-workflows.js";
import { FLAG_DEBUG } from "./constants.js";
import { registerSessionHooks } from "./session-hooks.js";
import { registerSetupCommand } from "./setup-command.js";
import { registerUpdateAgentsCommand } from "./update-agents-command.js";

export default function (pi: ExtensionAPI) {
	pi.registerFlag(FLAG_DEBUG, {
		description: "Show injected guidance and git-context messages",
		type: "boolean",
		default: false,
	});
	registerSessionHooks(pi);
	registerUpdateAgentsCommand(pi);
	registerSetupCommand(pi);
	registerBuiltIns(builtInWorkflows);
}
