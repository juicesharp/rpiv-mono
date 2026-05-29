/**
 * advisor — Advisor-strategy pattern: a zero-param `advisor` tool + `/advisor`
 * command that forward the serialized conversation branch to a separately-
 * configured reviewer model. Advisor has no tools, never emits user-facing
 * output, and returns guidance the executor resumes with.
 *
 * The implementation is one concern per file under this directory; this barrel
 * re-exports the package's public surface (consumed by ../index.ts, the repo-
 * root test/setup.ts, and the advisor.*.test.ts suite via "./advisor/index.js").
 *
 * Module map:
 *   messages   — tool identity, sentinels, effort vocabulary, all strings
 *   config     — persisted config + provider:id key codec
 *   state      — in-memory model/effort selection
 *   policy     — disabledForModels blocklist + blocked predicates
 *   inventory  — globalThis tool-inventory cache + serializer
 *   context    — branch-message massaging
 *   prompt     — system-prompt loader
 *   execute    — the advisor side-call
 *   register   — advisor tool registration
 *   handlers   — mid-session lifecycle handlers
 *   restore    — session_start restoration
 *   command    — /advisor slash command
 */

export { registerAdvisorCommand } from "./command.js";
export { loadAdvisorConfig, saveAdvisorConfig } from "./config.js";
export { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./context.js";
export {
	registerAdvisorBeforeAgentStart,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "./handlers.js";
export { getInventoryMessage, stableStringify } from "./inventory.js";
export { ADVISOR_TOOL_NAME } from "./messages.js";
export { setDisabledForModels } from "./policy.js";
export { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, registerAdvisorTool } from "./register.js";
export { __resetAdvisorAnnounced, registerAdvisorSessionStart, restoreAdvisorState } from "./restore.js";
export { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.js";
