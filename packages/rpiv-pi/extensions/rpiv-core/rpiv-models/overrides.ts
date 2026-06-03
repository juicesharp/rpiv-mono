/**
 * rpiv-models/overrides — Scope descriptor table for models.json override CRUD.
 *
 * Each scope (defaults, agents, stages, skills, presets) is modeled as a
 * ScopeDescriptor with has/get/remove/apply/pickKey accessors. This eliminates
 * repeated `as Record<string, unknown>` casts and inline four-branch key-picker
 * blocks from the command handler.
 *
 * Modeled on the Record<X, Meta> descriptor-table pattern (cf.
 * rpiv-ask-user-question/state/row-intent.ts:72-115).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { ModelsConfigSchema, ModelThinkingLevelValue } from "../models-config.js";
import { bundledAgentNames, loadWorkflowMap, skillCommandNames } from "../models-config-sources.js";
import { showFilterablePicker } from "../models-picker.js";

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

export const SCOPE_DEFAULTS = "defaults";
export const SCOPE_AGENTS = "agents";
export const SCOPE_STAGES = "stages";
export const SCOPE_SKILLS = "skills";
export const SCOPE_PRESETS = "presets";
export const SCOPE_RESET_ALL = "__reset_all__";

// ---------------------------------------------------------------------------
// Small UI helpers (shared with items.ts and command.ts)
// ---------------------------------------------------------------------------

/** Suffix appended to a picker label to mark "an override is set here". */
export const CHECK = " ✓";

export const withCheck = (label: string, has: boolean): string => (has ? `${label}${CHECK}` : label);

/** Stable partition: ✓-marked items float to the front, original order preserved. */
export function floatChecked(items: SelectItem[]): SelectItem[] {
	const checked = items.filter((i) => i.label.endsWith(CHECK));
	const rest = items.filter((i) => !i.label.endsWith(CHECK));
	return [...checked, ...rest];
}

/** Build key-picker items: ✓-decorate via `has`, then float the marked ones up. */
export function keyItems(names: string[], has: (name: string) => boolean): SelectItem[] {
	return floatChecked(names.map((n) => ({ value: n, label: withCheck(n, has(n)) })));
}

// ---------------------------------------------------------------------------
// ScopeDescriptor interface
// ---------------------------------------------------------------------------

/** Entry shape for applyOverride. */
export interface OverrideEntry {
	model: string;
	thinking?: ModelThinkingLevelValue;
}

/**
 * Per-scope descriptor: each scope in the models.json taxonomy is modeled as
 * one entry with CRUD + interactive key-picker accessors. This replaces the
 * six functions that each switched on the three-way scope taxonomy.
 */
export interface ScopeDescriptor {
	/** True if the scope holds ≥1 override. */
	hasOverride(raw: ModelsConfigSchema): boolean;
	/** True if a specific key under this scope holds an override. */
	keyHasOverride(raw: ModelsConfigSchema, keyPath: string[]): boolean;
	/** Current override model key for this scope+keyPath, or undefined. */
	getCurrentKey(raw: ModelsConfigSchema, keyPath: string[]): string | undefined;
	/** Strip one override with cascading empty-container cleanup. */
	removeOverride(config: ModelsConfigSchema, keyPath: string[]): { next: ModelsConfigSchema; removed: boolean };
	/** Apply an override entry at the given scope+keyPath. */
	applyOverride(config: ModelsConfigSchema, keyPath: string[], entry: OverrideEntry): ModelsConfigSchema;
	/**
	 * Interactive key picker for this scope. Returns the keyPath array, or null
	 * if the user cancelled. Defaults returns []; flat-maps return [key];
	 * presets returns [workflow, stage].
	 */
	pickKey(ctx: ExtensionContext, raw: ModelsConfigSchema, pi: ExtensionAPI): Promise<string[] | null>;
}

// ---------------------------------------------------------------------------
// Flat-map descriptor factory (agents, stages, skills)
// ---------------------------------------------------------------------------

/** Error message for missing workflows — shared by stages and presets pickKey. */
const MSG_NO_WORKFLOWS = "No workflows discovered; install rpiv-workflow or define a workflow first.";

/**
 * Factory for the three structurally-identical flat-map scopes. Each accesses
 * `raw[scope]` as a typed optional record — no casts needed since the closure
 * captures the literal scope key.
 */
function flatMapScope(scope: "agents" | "stages" | "skills", pickKey: ScopeDescriptor["pickKey"]): ScopeDescriptor {
	return {
		hasOverride(raw) {
			const map = raw[scope];
			return !!map && Object.keys(map).length > 0;
		},
		keyHasOverride(raw, keyPath) {
			const map = raw[scope];
			return !!map && keyPath[0] in map;
		},
		getCurrentKey(raw, keyPath) {
			const map = raw[scope];
			if (!map) return undefined;
			const entry = map[keyPath[0]];
			if (typeof entry === "string") return entry;
			if (entry && typeof entry === "object") return entry.model;
			return undefined;
		},
		removeOverride(config, keyPath) {
			const next: ModelsConfigSchema = { ...config };
			const map = next[scope];
			if (!map || !(keyPath[0] in map)) return { next, removed: false };
			const updated = { ...map };
			delete updated[keyPath[0]];
			if (!Object.keys(updated).length) delete next[scope];
			else next[scope] = updated;
			return { next, removed: true };
		},
		applyOverride(config, keyPath, entry) {
			const next: ModelsConfigSchema = { ...config };
			const target = next[scope];
			const updated = { ...(target ?? {}) };
			updated[keyPath[0]] = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
			next[scope] = updated;
			return next;
		},
		pickKey,
	};
}

// ---------------------------------------------------------------------------
// Scope descriptors
// ---------------------------------------------------------------------------

const defaultsDescriptor: ScopeDescriptor = {
	hasOverride(raw) {
		return raw.defaults !== undefined;
	},
	keyHasOverride(raw) {
		return raw.defaults !== undefined;
	},
	getCurrentKey(raw) {
		const entry = raw.defaults;
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object") return entry.model;
		return undefined;
	},
	removeOverride(config) {
		const next: ModelsConfigSchema = { ...config };
		if (next.defaults === undefined) return { next, removed: false };
		delete next.defaults;
		return { next, removed: true };
	},
	applyOverride(config, _keyPath, entry) {
		const next: ModelsConfigSchema = { ...config };
		next.defaults = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		return next;
	},
	async pickKey() {
		return [];
	},
};

const agentsDescriptor: ScopeDescriptor = flatMapScope(SCOPE_AGENTS, async (ctx, raw) => {
	const items = keyItems(bundledAgentNames(), (n) => agentsDescriptor.keyHasOverride(raw, [n]));
	if (items.length === 0) {
		ctx.ui.notify("No bundled agents found.", "error");
		return null;
	}
	const picked = await showFilterablePicker(ctx, {
		title: "Agent",
		proseLines: ["Select agent."],
		items,
	});
	return picked ? [picked] : null;
});

const stagesDescriptor: ScopeDescriptor = flatMapScope(SCOPE_STAGES, async (ctx, raw) => {
	let wfMap: Record<string, string[]>;
	try {
		wfMap = await loadWorkflowMap(ctx.cwd);
	} catch {
		ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
		return null;
	}
	const stages = Array.from(new Set(Object.values(wfMap).flat())).sort();
	if (stages.length === 0) {
		ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
		return null;
	}
	const picked = await showFilterablePicker(ctx, {
		title: "Stage",
		proseLines: ["Select stage."],
		items: keyItems(stages, (s) => stagesDescriptor.keyHasOverride(raw, [s])),
	});
	return picked ? [picked] : null;
});

const skillsDescriptor: ScopeDescriptor = flatMapScope(SCOPE_SKILLS, async (ctx, raw, pi) => {
	const names = skillCommandNames(pi);
	if (names.length === 0) {
		ctx.ui.notify("No skills registered; install or enable an extension that contributes skills.", "error");
		return null;
	}
	const picked = await showFilterablePicker(ctx, {
		title: "Skill",
		proseLines: ["Select skill."],
		items: keyItems(names, (n) => skillsDescriptor.keyHasOverride(raw, [n])),
	});
	return picked ? [picked] : null;
});

const presetsDescriptor: ScopeDescriptor = {
	hasOverride(raw) {
		return !!raw.presets && Object.keys(raw.presets).length > 0;
	},
	keyHasOverride(raw, keyPath) {
		if (keyPath.length >= 2) {
			// Specific stage check: [workflow, stage]
			return raw.presets?.[keyPath[0]]?.stages?.[keyPath[1]] !== undefined;
		}
		// Workflow-level check: [workflow]
		const stages = raw.presets?.[keyPath[0]]?.stages;
		return !!stages && Object.keys(stages).length > 0;
	},
	getCurrentKey(raw, keyPath) {
		const [wf, stage] = keyPath;
		const entry = raw.presets?.[wf]?.stages?.[stage];
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object") return entry.model;
		return undefined;
	},
	removeOverride(config, keyPath) {
		const next: ModelsConfigSchema = { ...config };
		const [wf, stage] = keyPath;
		if (next.presets?.[wf]?.stages?.[stage] === undefined) return { next, removed: false };
		const presets = { ...next.presets };
		const presetBlock = { ...presets[wf] };
		const stages = { ...presetBlock.stages };
		delete stages[stage];
		if (!Object.keys(stages).length) {
			delete presets[wf];
			if (!Object.keys(presets).length) delete next.presets;
			else next.presets = presets;
		} else {
			presetBlock.stages = stages;
			presets[wf] = presetBlock;
			next.presets = presets;
		}
		return { next, removed: true };
	},
	applyOverride(config, keyPath, entry) {
		const next: ModelsConfigSchema = { ...config };
		const [wf, stage] = keyPath;
		const presets = { ...(next.presets ?? {}) };
		const presetBlock = { ...(presets[wf] ?? {}) };
		const stages = { ...(presetBlock.stages ?? {}) };
		stages[stage] = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		presetBlock.stages = stages;
		presets[wf] = presetBlock;
		next.presets = presets;
		return next;
	},
	async pickKey(ctx, raw) {
		let wfMap: Record<string, string[]>;
		try {
			wfMap = await loadWorkflowMap(ctx.cwd);
		} catch {
			ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
			return null;
		}
		const wfNames = Object.keys(wfMap).sort();
		if (wfNames.length === 0) {
			ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
			return null;
		}
		const wf = await showFilterablePicker(ctx, {
			title: "Workflow",
			proseLines: ["Select workflow."],
			items: keyItems(wfNames, (n) => presetsDescriptor.keyHasOverride(raw, [n])),
		});
		if (!wf) return null;
		const stages = wfMap[wf] ?? [];
		if (stages.length === 0) {
			ctx.ui.notify(`Workflow "${wf}" has no stages.`, "error");
			return null;
		}
		const stage = await showFilterablePicker(ctx, {
			title: `Stage — ${wf}`,
			proseLines: ["Select stage."],
			items: keyItems(stages, (s) => presetsDescriptor.keyHasOverride(raw, [wf, s])),
		});
		if (!stage) return null;
		return [wf, stage];
	},
};

// ---------------------------------------------------------------------------
// SCOPES table
// ---------------------------------------------------------------------------

export const SCOPES: Record<string, ScopeDescriptor> = {
	defaults: defaultsDescriptor,
	agents: agentsDescriptor,
	stages: stagesDescriptor,
	skills: skillsDescriptor,
	presets: presetsDescriptor,
};

// ---------------------------------------------------------------------------
// Module-level convenience functions (backward-compatible public surface)
// ---------------------------------------------------------------------------

/**
 * Strip one override with cascading empty-container cleanup. Returns the new
 * config AND whether anything was actually removed — the handler branches its
 * notification on `removed` so a reset chosen on a key with no existing
 * override reports honestly instead of a misleading "Removed".
 */
export function removeOverride(
	config: ModelsConfigSchema,
	scope: string,
	keyPath: string[],
): { next: ModelsConfigSchema; removed: boolean } {
	const descriptor = SCOPES[scope];
	if (!descriptor) return { next: config, removed: false };
	return descriptor.removeOverride(config, keyPath);
}

/**
 * Apply an override entry at the given scope+keyPath.
 * Delegates to the scope's descriptor.
 */
export function applyOverride(
	config: ModelsConfigSchema,
	scope: string,
	keyPath: string[],
	entry: OverrideEntry,
): ModelsConfigSchema {
	const descriptor = SCOPES[scope];
	if (!descriptor) return config;
	return descriptor.applyOverride(config, keyPath, entry);
}
