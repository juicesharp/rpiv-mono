/**
 * rpiv-core — Pure-orchestrator extension for rpiv-pi.
 *
 * Composes session hooks and the slash commands. All logic lives in the
 * registrar modules; this file is the table of contents.
 *
 * Tool-owning plugins are siblings (see siblings.ts); install via /rpiv-setup.
 *
 * Workflow runtime + `/wf` command live in `@juicesharp/rpiv-workflow`. We
 * contribute five built-in workflows (arch / build / ship / vet / polish) via the
 * sibling's `registerBuiltIns` programmatic API so they're available to
 * users running `/wf` without authoring their own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLAG_DEBUG } from "./constants.js";
import { registerLaneProgressHook } from "./lane-progress.js";
import { registerLaneSwitcher } from "./lane-switcher.js";
import { registerModelsConfigValidation } from "./models-config-validate.js";
import { registerBuiltInWorkflows } from "./register-built-in-workflows.js";
import { registerRpivModelsCommand } from "./rpiv-models/index.js";
import { registerSessionCapture } from "./session-capture.js";
import { registerSessionHooks } from "./session-hooks.js";
import { registerSetupCommand } from "./setup-command.js";
import { registerSkillBracket } from "./skill-bracket.js";
import { registerSkillContractsSource, registerUserSkillContractsSource } from "./skill-contracts-source.js";
import { registerUpdateAgentsCommand } from "./update-agents-command.js";
import { registerWorkflowExecutionHostProviderHook } from "./workflow-execution-host.js";
import { registerWorkflowQuestionWarpBridgeHook } from "./workflow-question-warp-bridge.js";

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
	// current model + the foreground uiContext UNCONDITIONALLY (independent of
	// rpiv-workflow). The detached executor (SdkWorkflowHost) borrows the captured
	// registry/uiContext for per-child models — the workflow-path lifecycle latch
	// is retired. The /skill: bracket below still consumes the capture.
	registerSessionCapture(pi);
	// Always-on lane dock (belowEditor) + dock editor + /lanes/^Q entry (launcher owns
	// the registry). Independent of the rpiv-workflow sibling: the registry is populated
	// only when a /wf run actually launches, so this is a safe unconditional registration.
	// Its session_start hook is root-gated (skips detached children).
	registerLaneSwitcher(pi);
	// SDK execution-host provider — registered on the ROOT launcher's session_start
	// (NOT here / not in the IIFE below) so a detached child re-loading rpiv-core can
	// never overwrite the process-global provider box. The session_start
	// timing is safe: /wf is interactive-only and only fires after session start.
	registerWorkflowExecutionHostProviderHook(pi);
	// Lifecycle→registry bridge for live dock stage progress. Root-gated
	// + idempotent, same as the provider hook above: registered on the ROOT launcher's
	// session_start so a re-loading child never double-subscribes, and it dynamically
	// imports the rpiv-workflow `/startup` entry (degrades when the sibling is absent).
	registerLaneProgressHook(pi);
	// Workflow-question → Warp badge bridge. Root-gated + idempotent, same as the
	// lane-progress hook above: registered on the ROOT launcher's session_start so a
	// re-loading child never double-subscribes. Dynamically imports the opt-in
	// rpiv-warp sibling (degrades to a silent no-op when it is absent).
	registerWorkflowQuestionWarpBridgeHook(pi);
	// Standalone /skill: model/effort override bracket. MUST register AFTER
	// registerSessionCapture so the bracket's `getCapturedModel()`
	// read at input-arm time sees the populated baseline. The bracket's
	// `input` + `agent_end` handlers are independent of rpiv-workflow's
	// presence — they read models.json directly.
	registerSkillBracket(pi);
	// These rpiv-workflow-dependent registrars each dynamically
	// `import("@juicesharp/rpiv-workflow")` (or its `/startup` sub-entry). Firing
	// them concurrently makes jiti (Pi's dev loader) hand the second caller a
	// half-initialized barrel namespace whose re-export getters (e.g.
	// registerBuiltIns) read from a not-yet-evaluated submodule and throw "Cannot
	// read properties of undefined". Chaining them means the second import resolves
	// from jiti's module cache after the first has fully evaluated the barrel — no
	// race. All are fire-and-forget (the workflow registry is read lazily at `/wf`
	// time, long after this settles) and all degrade gracefully when the sibling is
	// absent (isModuleNotFound guards).
	const logRegistrationFailure = (label: string) => (err: unknown) =>
		console.error(`[rpiv-core] failed to register ${label}:`, err);

	// Register the rpiv-workflow-dependent stacks STRICTLY in sequence — each
	// awaits the previous to settle so the concurrent `import("@juicesharp/rpiv-workflow")`
	// race described above can't occur. Each step swallows its own failure (the others
	// must still run) and degrades gracefully when the sibling is absent. Fire-and-forget:
	// the workflow registry is read lazily at `/wf` time, long after this settles.
	//
	// The SDK execution-host provider is NOT registered here — it is wired to the
	// root launcher's session_start (registerWorkflowExecutionHostProviderHook above)
	// so a detached child re-loading rpiv-core cannot overwrite the process-global
	// provider box. Per-child models are resolved through the provider's
	// resolveModel and applied at child-session creation, not via a global
	// pi.setModel() flip. (The session_start capture + /skill: bracket stay.)
	void (async () => {
		await registerBuiltInWorkflows().catch(logRegistrationFailure("built-in workflows"));
		await registerSkillContractsSource().catch(logRegistrationFailure("skill contracts source"));
		await registerUserSkillContractsSource().catch(logRegistrationFailure("user skill contracts source"));
	})();
}
