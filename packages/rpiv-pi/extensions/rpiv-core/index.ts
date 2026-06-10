/**
 * rpiv-core — Pure-orchestrator extension for rpiv-pi.
 *
 * Composes session hooks and the slash commands. All logic lives in the
 * registrar modules; this file is the table of contents.
 *
 * Tool-owning plugins are siblings (see siblings.ts); install via /rpiv-setup.
 *
 * Workflow runtime + `/wf` command live in `@juicesharp/rpiv-workflow`. We
 * contribute six built-in workflows (ship / build / arch / vet / polish / pr-triage) via the
 * sibling's `registerBuiltIns` programmatic API so they're available to
 * users running `/wf` without authoring their own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLAG_DEBUG } from "./constants.js";
import { registerModelOverrideLifecycle, registerModelOverrideSessionStart } from "./model-override.js";
import { registerModelsConfigValidation } from "./models-config-validate.js";
import { registerBuiltInWorkflows } from "./register-built-in-workflows.js";
import { registerRpivModelsCommand } from "./rpiv-models/index.js";
import { registerSessionHooks } from "./session-hooks.js";
import { registerSetupCommand } from "./setup-command.js";
import { registerSkillBracket } from "./skill-bracket.js";
import { registerSkillContractsSource } from "./skill-contracts-source.js";
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
	registerRpivModelsCommand(pi); // /rpiv-models cascade picker
	// Warn-on-miss: surface models.json record-key typos (skills.committ,
	// presets.shipp) that pass schema validation but silently never apply.
	registerModelsConfigValidation(pi);
	// Stage model/effort override: the session_start hook captures modelRegistry +
	// current model UNCONDITIONALLY (independent of rpiv-workflow), and the
	// lifecycle listener registration degrades gracefully when the sibling is
	// absent (isModuleNotFound guard inside registerModelOverrideLifecycle).
	registerModelOverrideSessionStart(pi);
	// Standalone /skill: model/effort override bracket. MUST register AFTER
	// registerModelOverrideSessionStart so the bracket's `getCapturedModel()`
	// read at input-arm time sees the populated baseline. The bracket's
	// `input` + `agent_end` handlers are independent of rpiv-workflow's
	// presence — they read models.json directly.
	registerSkillBracket(pi);
	// Both registerModelOverrideLifecycle and registerBuiltInWorkflows dynamically
	// `import("@juicesharp/rpiv-workflow")`. Firing them concurrently makes jiti
	// (Pi's dev loader) hand the second caller a half-initialized barrel namespace
	// whose re-export getters (e.g. registerBuiltIns) read from a not-yet-evaluated
	// submodule and throw "Cannot read properties of undefined". Chaining them means
	// the second import resolves from jiti's module cache after the first has fully
	// evaluated the barrel — no race. Both are fire-and-forget (the workflow
	// registry is read lazily at `/wf` time, long after this settles) and both
	// degrade gracefully when the sibling is absent (isModuleNotFound guards).
	const logRegistrationFailure = (label: string) => (err: unknown) =>
		console.error(`[rpiv-core] failed to register ${label}:`, err);

	// Register the three rpiv-workflow-dependent stacks STRICTLY in sequence — each
	// awaits the previous to settle so the concurrent `import("@juicesharp/rpiv-workflow")`
	// race described above can't occur. Each step swallows its own failure (the others
	// must still run) and degrades gracefully when the sibling is absent. Fire-and-forget:
	// the workflow registry is read lazily at `/wf` time, long after this settles.
	void (async () => {
		await registerModelOverrideLifecycle(pi).catch(logRegistrationFailure("model override lifecycle"));
		await registerBuiltInWorkflows().catch(logRegistrationFailure("built-in workflows"));
		await registerSkillContractsSource().catch(logRegistrationFailure("skill contracts source"));
	})();
}
