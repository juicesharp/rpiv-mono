/**
 * lane-transcript — shared two-pass replay of a session branch into a flat string[]
 * body, extracted from the lane viewer so BOTH the focused viewer (lane-viewer.ts)
 * and the dock's active-only transcript preview (lane-dock.ts) render identically.
 *
 * Mirrors interactive-mode's renderSessionContext: build an ordered SDK-component list
 * (one per message / toolCall, folding toolResult entries into their matching
 * ToolExecutionComponent by toolCallId), then render each in order. Per-tool renderers
 * (diffs, bash output, file reads) need a ToolDefinition + cwd, supplied via RenderSource
 * — from the live child session, or a retired lane's snapshot. Strictly read-only and
 * fail-soft: every component renders inside a try/catch so it never throws into its host
 * overlay/widget.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

/** Local narrowing of getBranch()'s entry shape (mirrors rpiv-workflow transcript.ts:BranchEntry).
 *  Tool-call blocks (assistant content) and toolResult messages carry the extra fields the
 *  ToolExecutionComponent pass pairs on; the registry types the whole branch `unknown`. */
export interface ViewerContentPart {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
}
export interface ViewerMessage {
	role?: string;
	content?: ViewerContentPart[];
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
}
export interface ViewerEntry {
	type: string;
	message?: ViewerMessage;
}

/** Constructor/arg types borrowed from the SDK components so callers cast `unknown` branch
 *  data at the call site without importing the SDK's message/tool types. `ToolDefArg` is
 *  exported because RenderSource producers (the viewer's live + retired sources) cast to it. */
export type ToolDefArg = ConstructorParameters<typeof ToolExecutionComponent>[4];
type ToolResultArg = Parameters<ToolExecutionComponent["updateResult"]>[0];
type CustomMsgArg = ConstructorParameters<typeof CustomMessageComponent>[0];
type CompactionMsgArg = ConstructorParameters<typeof CompactionSummaryMessageComponent>[0];
type BranchSummaryMsgArg = ConstructorParameters<typeof BranchSummaryMessageComponent>[0];
type TruncationArg = NonNullable<Parameters<BashExecutionComponent["setComplete"]>[2]>;

/** The cwd + per-tool-definition lookup the ToolExecutionComponent pass needs. Sourced
 *  from the live child session, or — for a retired lane — from retireRun's snapshot. */
export interface RenderSource {
	cwd: string;
	toolDef: (name: string) => ToolDefArg;
}

/** Bash-execution branch entry — primitives the BashExecutionComponent is rebuilt from. */
interface BashExecMessage {
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
}

/** A single dim fallback line wrapped as a Component so it can sit in the ordered list. */
export function dimLine(text: string, theme: Theme): Component {
	return {
		render: (w: number) => [truncateToWidth(theme.fg("dim", text), w, "…")],
		invalidate() {},
	};
}

/**
 * Two-pass replay of a branch into a flat body (mirrors interactive-mode's
 * renderSessionContext): build an ordered component list, fold toolResult entries
 * into their matching ToolExecutionComponent by toolCallId, then render in order.
 * Per-tool renderers (diffs, bash output, file reads) need ToolDefinition + cwd, which
 * `source` supplies from the live session or — for a retired lane — retireRun's
 * snapshot. A tool with no captured def degrades to the component's built-in fallback.
 * Never throws — each component renders fail-soft.
 */
export function renderBranch(
	entries: ViewerEntry[],
	width: number,
	source: RenderSource,
	tui: TUI,
	theme: Theme,
	toolsExpanded: boolean,
): string[] {
	const cwd = source.cwd;
	const toolDef = (name: string): ToolDefArg => {
		try {
			return source.toolDef(name);
		} catch {
			return undefined;
		}
	};

	const components: Component[] = [];
	const pending = new Map<string, ToolExecutionComponent>();
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		try {
			if (m.role === "assistant") {
				components.push(new AssistantMessageComponent(m as unknown as AssistantMessage));
				for (const c of m.content ?? []) {
					if (c.type !== "toolCall" || typeof c.id !== "string") continue;
					const tool = new ToolExecutionComponent(
						c.name ?? "tool",
						c.id,
						c.arguments ?? {},
						{},
						toolDef(c.name ?? ""),
						tui,
						cwd,
					);
					tool.setExpanded(toolsExpanded);
					// An aborted/errored turn never produces a toolResult entry; surface the
					// turn's error inline so the call doesn't render as perpetually pending.
					if (m.stopReason === "aborted" || m.stopReason === "error") {
						const text = m.errorMessage || (m.stopReason === "aborted" ? "Operation aborted" : "Error");
						tool.updateResult({ content: [{ type: "text", text }], isError: true });
					} else {
						pending.set(c.id, tool);
					}
					components.push(tool);
				}
			} else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
				pending.get(m.toolCallId)?.updateResult(e.message as unknown as ToolResultArg);
				pending.delete(m.toolCallId);
			} else if (m.role === "bashExecution") {
				const b = e.message as unknown as BashExecMessage;
				const bash = new BashExecutionComponent(b.command ?? "", tui, b.excludeFromContext);
				if (b.output) bash.appendOutput(b.output);
				// SDK passes a bare { truncated: true } here (untyped JS); cast to the param type.
				const trunc = b.truncated ? ({ truncated: true } as TruncationArg) : undefined;
				bash.setComplete(b.exitCode, b.cancelled ?? false, trunc, b.fullOutputPath);
				components.push(bash);
			} else if (m.role === "custom") {
				// display:false custom messages are context-only — hidden in the TUI, so skip.
				const cm = e.message as unknown as CustomMsgArg;
				if (cm.display) {
					const custom = new CustomMessageComponent(cm);
					custom.setExpanded(toolsExpanded);
					components.push(custom);
				}
			} else if (m.role === "compactionSummary") {
				const comp = new CompactionSummaryMessageComponent(e.message as unknown as CompactionMsgArg);
				comp.setExpanded(toolsExpanded);
				components.push(dimLine("", theme), comp);
			} else if (m.role === "branchSummary") {
				const bs = new BranchSummaryMessageComponent(e.message as unknown as BranchSummaryMsgArg);
				bs.setExpanded(toolsExpanded);
				components.push(dimLine("", theme), bs);
			} else if (m.role === "user") {
				const text = (m.content ?? [])
					.filter((p) => p.type === "text" && typeof p.text === "string")
					.map((p) => p.text)
					.join("\n")
					.trim();
				if (!text) {
					components.push(dimLine("└ tool result", theme)); // non-text user content (images / tool_result)
				} else {
					// A skill invocation arrives as a user turn whose text wraps a skill block;
					// render the (collapsible) block, then any trailing user message separately.
					const skill = parseSkillBlock(text);
					if (skill) {
						const sk = new SkillInvocationMessageComponent(skill);
						sk.setExpanded(toolsExpanded);
						components.push(sk);
						if (skill.userMessage) components.push(new UserMessageComponent(skill.userMessage));
					} else {
						components.push(new UserMessageComponent(text));
					}
				}
			} else {
				components.push(dimLine(`· ${m.role ?? e.type}`, theme));
			}
		} catch {
			// unexpected message shape — keep replaying the rest of the branch
			components.push(dimLine(`· ${m.role ?? e.type}`, theme));
		}
	}

	const body: string[] = [];
	for (const c of components) {
		try {
			body.push(...c.render(width));
		} catch {
			body.push(truncateToWidth(theme.fg("dim", "· (unrenderable)"), width, "…"));
		}
	}
	return body;
}

/** Opaque handle for a surface's persistent streaming component. Surfaces hold one across
 *  ticks but never construct it — `renderStreamingMessage` owns the SDK component value, so
 *  `lane-viewer.ts`/`lane-dock.ts` import only this type (no SDK component value import). */
export type StreamingHandle = AssistantMessageComponent;

/**
 * Render the in-flight partial assistant message into its own persistent component,
 * mirroring interactive-mode's `streamingComponent` (NOT a fresh per-tick replay through
 * `renderBranch`). The surface passes its previous handle and the latest partial; this
 * `updateContent`s the handle (reused across ticks so only this one component rebuilds per
 * token) and returns its rendered lines. A `undefined`/non-assistant partial — no turn
 * streaming, or the turn just committed into `getBranch()` — returns an empty handle + no
 * lines, which is how the surface drops the component at the streaming→committed boundary.
 * Fail-soft: a throwing `updateContent`/`render` clears the handle and yields nothing.
 */
export function renderStreamingMessage(
	prev: StreamingHandle | undefined,
	partial: ViewerMessage | undefined,
	width: number,
): { component: StreamingHandle | undefined; lines: string[] } {
	if (partial?.role !== "assistant") return { component: undefined, lines: [] };
	const component = prev ?? new AssistantMessageComponent(undefined);
	try {
		component.updateContent(partial as unknown as AssistantMessage);
		return { component, lines: component.render(width) };
	} catch {
		return { component: undefined, lines: [] };
	}
}
