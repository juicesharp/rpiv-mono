/**
 * rpiv-models — Directory barrel for the /rpiv-models cascade picker.
 *
 * Module map:
 *   overrides — ScopeDescriptor table, CRUD convenience functions, UI helpers
 *   items     — SelectItem builders, string constants, loadRawConfig
 *   command   — /rpiv-models command registration
 */

export { registerRpivModelsCommand } from "./command.js";
export {
	buildEffortItems,
	buildModelItems,
	INHERIT_VALUE,
	loadRawConfig,
	MSG_REQUIRES_INTERACTIVE,
	MSG_RESET_ALL,
	MSG_RESET_ALL_BODY,
	MSG_RESET_ALL_CANCELLED,
	MSG_RESET_ALL_TITLE,
	MSG_SAVE_FAILED,
	RESET_LABEL,
	RESET_VALUE,
	scopeItems,
} from "./items.js";
export {
	applyOverride,
	CHECK,
	floatChecked,
	keyItems,
	type OverrideEntry,
	removeOverride,
	SCOPE_AGENTS,
	SCOPE_DEFAULTS,
	SCOPE_PRESETS,
	SCOPE_RESET_ALL,
	SCOPE_SKILLS,
	SCOPE_STAGES,
	SCOPES,
	type ScopeDescriptor,
	withCheck,
} from "./overrides.js";
