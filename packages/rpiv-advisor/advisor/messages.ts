/**
 * messages — advisor vocabulary: tool identity, selector sentinels, effort
 * levels, UI labels, and every user-facing string (static + parameterized).
 * Pure declarations, no logic; consumed across the advisor/ modules.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

// Tool identity
export const ADVISOR_TOOL_NAME = "advisor";
export const TOOL_LABEL = "Advisor";

// Selector sentinels — double-underscore form is collision-proof against real provider:id keys
export const NO_ADVISOR_VALUE = "__no_advisor__";
export const OFF_VALUE = "__off__";

// Effort levels
export const EFFORT_ORDINAL: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: ThinkingLevel = "high";
export const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

// UI — labels used by command flow; panel prose/titles live in advisor-ui.ts
export const CHECKMARK = " ✓";

// Messages (static)
export const MSG_ADVISOR_DISABLED = "Advisor disabled";
export const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";
export const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above.";
export const MSG_PERSIST_FAILED = "Failed to save advisor selection — selection not persisted";

// Errors (static)
export const ERR_NO_MODEL = "No advisor model is configured. The user can enable one with the /advisor command.";
export const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
export const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
export const ERR_NO_MODEL_SELECTED = "no advisor model selected";
export const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
export const ERR_ABORTED_DETAIL = "aborted";
export const ERR_UNKNOWN = "unknown error";

// Errors/messages (parameterized)
export const errMisconfigured = (label: string, err: string) => `Advisor (${label}) is misconfigured: ${err}`;
export const errNoApiKey = (label: string) => `Advisor (${label}) has no API key available.`;
export const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
export const errCallFailed = (err: string | undefined) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
export const errCallThrew = (msg: string) => `Advisor call threw: ${msg}`;
export const errSelectionNotFound = (choice: string) => `Advisor selection not found: ${choice}`;
export const errModelUnavailable = (key: string) => `Previously configured advisor model ${key} is no longer available`;
export const msgAdvisorEnabled = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestoredInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgAdvisorEnabledInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgConsulting = (label: string, effort: ThinkingLevel | undefined) =>
	`Consulting advisor (${label}${effort ? `, ${effort}` : ""})…`;
