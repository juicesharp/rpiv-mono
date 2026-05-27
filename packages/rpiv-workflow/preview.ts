/**
 * Pretty-print workflow lists (no-args path) and per-workflow details
 * (workflow-name-only path). Read-only against `LoadedWorkflows` — no I/O,
 * no mutation. Two public formatters, both returning a single multiline
 * string that `command.ts` hands straight to `ctx.ui.notify(..., "info")`.
 */

import type { StageDef, Workflow } from "./api.js";
import { type ConfigLayer, renderConfigLayer } from "./layers.js";
import type { LoadedWorkflows } from "./load/index.js";
import { CMD_USAGE_LIST, CMD_USAGE_PREVIEW, CMD_USAGE_RUN } from "./messages.js";

// ===========================================================================
// Public formatters
// ===========================================================================

/** Truncate a description to `maxLen` characters, appending "..." if truncated. */
function truncateDescription(desc: string, maxLen = 50): string {
	if (desc.length <= maxLen) return desc;
	return `${desc.slice(0, maxLen - 3)}...`;
}

/** No-args listing: every loaded workflow, its stage count, and its source. */
export function formatWorkflowList(loaded: LoadedWorkflows): string {
	const rows = loaded.workflows.map((w) => {
		const layer = loaded.workflowSources.get(w.name) ?? "built-in";
		const stages = Object.keys(w.stages).length;
		const tags = [`[${renderConfigLayer(layer)}]`];
		if (w.name === loaded.default) tags.push("(default)");
		const desc = w.description ? ` ${truncateDescription(w.description)}` : "";
		return ` ${w.name} ${stages} stages ${tags.join(" ")}${desc}`;
	});

	return [
		"Available workflows:",
		...rows,
		"",
		formatLayerBanner(loaded.layers),
		CMD_USAGE_LIST,
		CMD_USAGE_PREVIEW,
	].join("\n");
}

/** Workflow-name-only path: full stage list + edges for one workflow. */
export function formatWorkflowDetails(loaded: LoadedWorkflows, name: string): string {
	const workflow = loaded.workflows.find((w) => w.name === name);
	if (!workflow) {
		throw new Error(`formatWorkflowDetails: workflow "${name}" not found in loaded set`);
	}

	const layer = loaded.workflowSources.get(name) ?? "built-in";
	const heading = formatWorkflowHeading(name, layer, name === loaded.default);
	const descriptionLine = workflow.description ? [workflow.description] : [];
	const stageRows = Object.entries(workflow.stages).map(([stageName, stage], i) =>
		formatStageRow(i + 1, stageName, stage, workflow),
	);

	return [heading, ...descriptionLine, "", ...stageRows, "", CMD_USAGE_RUN(name)].join("\n");
}

// ===========================================================================
// Stage / source rendering
// ===========================================================================

/** `workflow: <name>  (<layer>[, default])` — header line for details view. */
function formatWorkflowHeading(name: string, layer: ConfigLayer, isDefault: boolean): string {
	const tags: string[] = [renderConfigLayer(layer)];
	if (isDefault) tags.push("default");
	return `workflow: ${name}  (${tags.join(", ")})`;
}

/** Numbered row showing the stage + its outgoing edge target(s). */
function formatStageRow(idx: number, stageName: string, stage: StageDef, workflow: Workflow): string {
	const num = `${idx}.`.padEnd(3);
	const decorations = [stage.kind.padEnd(13), stage.sessionPolicy, outcomeTag(stage)];
	if (stage.inputSchema) decorations.push("in-schema");
	if (stage.outputSchema) decorations.push("out-schema");

	const displayName = stage.skill && stage.skill !== stageName ? `${stageName} (skill: ${stage.skill})` : stageName;
	const arrow = formatEdge(workflow, stageName);
	const trailer = arrow ? `  → ${arrow}` : "";

	return `  ${num} ${displayName.padEnd(36)} ${decorations.join(" · ")}${trailer}`;
}

/**
/**
 * Single tag per stage encoding the outcome shape. Custom outcomes
 * report `custom` (+`snapshot` when the collector declares a snapshot
 * hook, +`parser` when a parser is wired). Stages without an outcome
 * fall through to the framework default: `side-effect` for
 * side-effect stages (the only kind that has a default); `???` for
 * `produces` (load-time validation rejects this — the tag is for
 * defensive rendering only).
 */
function outcomeTag(stage: StageDef): string {
	if (stage.outcome) {
		const tags = ["custom"];
		if (stage.outcome.collector.snapshot) tags.push("snapshot");
		if (stage.outcome.parser) tags.push("parser");
		return tags.join("+");
	}
	return stage.kind === "produces" ? "???" : "side-effect";
}

/** Render the outgoing edge as a human-readable trailer (string or predicate target set). */
function formatEdge(workflow: Workflow, from: string): string | undefined {
	const target = workflow.edges[from];
	if (target === undefined) return "(terminal — no edge declared)";
	if (target === "stop") return "stop";
	if (typeof target === "string") return target;
	const targets = target.targets;
	if (Array.isArray(targets) && targets.length > 0) return `predicate(${targets.join(" | ")})`;
	return "predicate";
}

/** "Sources: built-in + user + project" — single-line layer banner. */
function formatLayerBanner(layers: readonly ConfigLayer[]): string {
	return `Sources: ${layers.map(renderConfigLayer).join(" + ")}`;
}
