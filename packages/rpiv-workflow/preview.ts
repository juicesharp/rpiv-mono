/**
 * Pretty-print workflow lists (no-args path) and per-workflow details
 * (workflow-name-only path). Read-only against `LoadedWorkflows` — no I/O,
 * no mutation. Two public formatters, both returning a single multiline
 * string that `command.ts` hands straight to `ctx.ui.notify(..., "info")`.
 */

import { STOP, type StageDef } from "./api.js";
import { describeFlow, type StageShape } from "./control-flow.js";
import { type ConfigLayer, renderConfigLayer } from "./layers.js";
import type { LoadedWorkflows } from "./load/index.js";
import type { SkillContractMap } from "./skill-contract.js";

/** No-args listing footer — generic usage hint. */
export const CMD_USAGE_LIST = "Usage: /wf [workflow] <description>";

/** No-args listing footer — preview-mode hint paired with CMD_USAGE_LIST. */
export const CMD_USAGE_PREVIEW = "/wf <workflow>             — preview stages";

/** Per-workflow details footer — narrowed to the workflow the user previewed. */
export const CMD_USAGE_RUN = (name: string) => `Usage: /wf ${name} <description>`;

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
	const items = loaded.workflows.map((w) => {
		const layer = loaded.workflowSources.get(w.name) ?? "built-in";
		return {
			name: w.name,
			stages: Object.keys(w.stages).length,
			layerTag: `[${renderConfigLayer(layer)}]`,
			defaultTag: w.name === loaded.default ? "(default)" : "",
			description: w.description ? truncateDescription(w.description) : "",
		};
	});

	// Column widths computed across the rendered set so name / stages / layer /
	// default-tag align vertically — same posture as `formatStageRow`'s padEnd
	// usage in the details view.
	const widths = {
		name: Math.max(0, ...items.map((i) => i.name.length)),
		stages: Math.max(0, ...items.map((i) => String(i.stages).length)),
		layerTag: Math.max(0, ...items.map((i) => i.layerTag.length)),
		defaultTag: Math.max(0, ...items.map((i) => i.defaultTag.length)),
	};

	const rows = items.map((i) => {
		const name = i.name.padEnd(widths.name);
		const stages = `${String(i.stages).padStart(widths.stages)} stages`;
		const layerTag = i.layerTag.padEnd(widths.layerTag);
		const defaultTag = i.defaultTag.padEnd(widths.defaultTag);
		const desc = i.description ? `  ${i.description}` : "";
		return `  ${name}  ${stages}  ${layerTag}  ${defaultTag}${desc}`.trimEnd();
	});

	const aliasBanner = formatAliasBanner(loaded.skillAliases);
	const contractsBanner = formatContractsBanner(loaded.skillContracts);
	return [
		"Available workflows:",
		"",
		...rows,
		"",
		...(aliasBanner ? [aliasBanner] : []),
		...(contractsBanner ? [contractsBanner] : []),
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
	// Flow facets (loop / verify / edge) come from `describeFlow` — the ONE
	// introspector (M12: preview must never lag a new loop kind again, the
	// 09032b1 retrofit lesson). Per-stage knobs (kind, policy, outcome,
	// schemas) are plain field reads off the def.
	const shapeByStage = new Map(describeFlow(workflow).map((shape) => [shape.stage, shape]));
	const stageRows = Object.entries(workflow.stages).map(([stageName, stage], i) =>
		formatStageRow(i + 1, stageName, stage, shapeByStage.get(stageName)!, stageName in workflow.edges),
	);
	const aliasBanner = formatAliasBanner(loaded.skillAliases);

	return [
		heading,
		...descriptionLine,
		"",
		...stageRows,
		"",
		...(aliasBanner ? [aliasBanner, ""] : []),
		CMD_USAGE_RUN(name),
	].join("\n");
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
function formatStageRow(
	idx: number,
	stageName: string,
	stage: StageDef,
	shape: StageShape,
	edgeDeclared: boolean,
): string {
	const num = `${idx}.`.padEnd(3);
	const decorations = [stage.kind.padEnd(13), stage.sessionPolicy, outcomeTag(stage)];
	if (stage.inputSchema) decorations.push("in-schema");
	if (stage.outputSchema) decorations.push("out-schema");
	if (shape.control.mode !== "single") decorations.push(loopTag(shape.control));
	if (shape.verify) decorations.push(verifyTag(shape.verify));

	const displayName = shape.skill && shape.skill !== stageName ? `${stageName} (skill: ${shape.skill})` : stageName;
	const arrow = formatEdge(shape.edge, edgeDeclared);
	const trailer = arrow ? `  → ${arrow}` : "";

	return `  ${num} ${displayName.padEnd(36)} ${decorations.join(" · ")}${trailer}`;
}

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

/**
 * Decoration for a loop stage. Assess keeps its exact pre-redesign strings
 * (`assess(judge: skill:<name>)·max=N`, `assess(judge: prompt)·max=N` — the
 * constructor always sets `max`, defaulting to 8). Fanout/iterate gain tags
 * for the first time: `fanout·max=32`, `iterate·max=32`, or the bare kind
 * when no cap is declared (the run-wide maxIterations still backstops).
 */
function loopTag(control: StageShape["control"]): string {
	const spec = control.spec;
	if (!spec) return control.mode;
	if (spec.kind === "assess") {
		const judge = spec.judge?.skill ? `skill:${spec.judge.skill}` : "prompt";
		return `assess(judge: ${judge})·max=${spec.max}`;
	}
	return spec.max !== undefined ? `${spec.kind}·max=${spec.max}` : spec.kind;
}

/**
 * Decoration for a verify-bearing stage: `verify(skill:<name>)` /
 * `verify(prompt)`, with the attempt budget appended when retrying
 * (`·attempts=N`); a gate-only verify (the default, max 1) stays compact.
 */
function verifyTag(v: NonNullable<StageShape["verify"]>): string {
	const judge = v.skill ? `skill:${v.skill}` : "prompt";
	const attempts = v.max > 1 ? `·attempts=${v.max}` : "";
	return `verify(${judge})${attempts}`;
}

/**
 * Render the outgoing edge as a human-readable trailer from the introspected
 * `StageShape.edge`. `describeFlow` collapses "no edge declared" and an
 * explicit `STOP` into one `terminal` mode; the declared-or-not distinction
 * is a one-key lookup the caller supplies (it matters to authors — the
 * validator warns on the undeclared form).
 */
function formatEdge(edge: StageShape["edge"], declared: boolean): string | undefined {
	if (edge.mode === "terminal") return declared ? STOP : "(terminal — no edge declared)";
	if (edge.mode === "linear") return edge.targets?.[0];
	return edge.targets?.length ? `predicate(${edge.targets.join(" | ")})` : "predicate";
}

/** "Sources: built-in + user + project" — single-line layer banner. */
function formatLayerBanner(layers: readonly ConfigLayer[]): string {
	return `Sources: ${layers.map(renderConfigLayer).join(" + ")}`;
}

/**
 * "Skill aliases in effect: commit → attributed-commit, code-review → strict-review"
 * — shown only when a `skillAliases` map is in effect. No silent magic: the
 * banner surfaces every active remap so a reader can see why a stage dispatches
 * a different skill than its name.
 */
function formatAliasBanner(aliases: Readonly<Record<string, string>>): string | undefined {
	const entries = Object.entries(aliases);
	if (entries.length === 0) return undefined;
	return `Skill aliases in effect: ${entries.map(([from, to]) => `${from} → ${to}`).join(", ")}`;
}

/**
 * "Skill contracts: 3 declared, 2 harvested" — coverage summary shown when any
 * contract is in effect. Surfaces how many skills carry a declared (frontmatter)
 * vs harvested (usage-derived) contract so a reader knows the registry's tier.
 */
function formatContractsBanner(contracts: SkillContractMap): string | undefined {
	if (contracts.size === 0) return undefined;
	let declared = 0;
	let harvested = 0;
	for (const c of contracts.values()) {
		if (c.source === "declared") declared++;
		else if (c.source === "harvested") harvested++;
	}
	return `Skill contracts: ${declared} declared, ${harvested} harvested`;
}
