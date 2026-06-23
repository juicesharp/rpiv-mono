/**
 * lane-viewer — read-only LIVE transcript viewer for a switched-into run (FR2).
 *
 * The no-upstream-SDK substitute for native reattach: a focused ctx.ui.custom
 * overlay that RENDERS the lane's currently-live child session's getBranch()
 * (in-memory, always current — never the lagging .jsonl) via the SDK's own
 * exported message components, re-rendered on every streaming tick. Strictly
 * read-only: it never swaps, disposes, or writes any session.
 *
 * It FOLLOWS the lane: as stages advance the registry's currentSession changes,
 * so the viewer re-subscribes to the new child; when the run is evicted (FR6) it
 * shows a terminal "finished" frame and waits for esc.
 *
 * Input split while this viewer is open (the lane is focused, Slice 6): esc/↑/↓ are
 * the viewer's own (esc → back to root, ↑/↓ → scroll); Ctrl-C is consumed by the
 * focus-gated abort tap (which fires ahead of this component) and aborts the run on
 * screen. The viewer therefore deliberately does NOT handle Ctrl-C itself.
 *
 * Tool calls + results are reconstructed via the SDK's own ToolExecutionComponent,
 * mirroring interactive-mode's renderSessionContext two-pass replay: each assistant
 * `toolCall` block spawns a component, and the later `toolResult` entry (matched by
 * toolCallId) is folded into it via updateResult before render. ToolDefinition/cwd
 * come from the live session (getToolDefinition/getCwd), or — once a run retires — from
 * the snapshot retireRun captured before dropping the session; a tool with no captured
 * def degrades to the component's built-in fallback renderer. Bash runs,
 * custom messages, skill invocations, and compaction/branch summaries each render via
 * their own SDK component; only genuinely unknown-role entries collapse to one dim line.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	type ExtensionUIContext,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { getLane, type LaneSession, type LaneStatus, laneNeedsInput, subscribeLanes } from "./run-lane-registry.js";

const MAX_HEIGHT_RATIO = 0.9;

/** Header glyph for a retained terminal lane (Phase A) — mirrors the overlay's STATUS_GLYPH. */
const TERMINAL_GLYPH: Partial<Record<LaneStatus, string>> = {
	completed: "✓",
	failed: "✗",
	aborted: "⊘",
	cancelled: "⊘",
};

/** Local narrowing of getBranch()'s entry shape (mirrors rpiv-workflow transcript.ts:BranchEntry).
 *  Tool-call blocks (assistant content) and toolResult messages carry the extra fields the
 *  ToolExecutionComponent pass pairs on; the registry types the whole branch `unknown`. */
interface ViewerContentPart {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
}
interface ViewerMessage {
	role?: string;
	content?: ViewerContentPart[];
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
}
interface ViewerEntry {
	type: string;
	message?: ViewerMessage;
}

/** Constructor/arg types borrowed from the SDK components so we cast `unknown` branch data
 *  at the call site without importing the SDK's message/tool types into this module. */
type ToolDefArg = ConstructorParameters<typeof ToolExecutionComponent>[4];
type ToolResultArg = Parameters<ToolExecutionComponent["updateResult"]>[0];
type CustomMsgArg = ConstructorParameters<typeof CustomMessageComponent>[0];
type CompactionMsgArg = ConstructorParameters<typeof CompactionSummaryMessageComponent>[0];
type BranchSummaryMsgArg = ConstructorParameters<typeof BranchSummaryMessageComponent>[0];
type TruncationArg = NonNullable<Parameters<BashExecutionComponent["setComplete"]>[2]>;

/** The cwd + per-tool-definition lookup the ToolExecutionComponent pass needs. Sourced
 *  from the live child session, or — for a retired lane — from retireRun's snapshot. */
interface RenderSource {
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

export class LaneViewer implements Component {
	private scrollOffset = 0;
	/** Collapsed by default (keeps the overlay short); `t` toggles every tool/summary
	 *  component's expanded state, mirroring interactive-mode's tool-output toggle. */
	private toolsExpanded = false;
	private currentSession: LaneSession | undefined;
	private sessionUnsub: (() => void) | undefined;
	private readonly registryUnsub: () => void;

	constructor(
		private readonly runId: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
	) {
		this.currentSession = getLane(runId)?.currentSession;
		this.sessionUnsub = this.currentSession?.subscribe(() => this.tui.requestRender());
		// Follow the lane across stage transitions + detect eviction.
		this.registryUnsub = subscribeLanes(() => this.syncSession());
	}

	/** Re-point to the lane's current child if it changed; always re-render. */
	private syncSession(): void {
		const next = getLane(this.runId)?.currentSession;
		if (next !== this.currentSession) {
			this.sessionUnsub?.();
			this.currentSession = next;
			this.sessionUnsub = next?.subscribe(() => this.tui.requestRender());
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lane = getLane(this.runId);
		if (!lane) return this.frame([this.theme.fg("dim", "(run dismissed — esc to return)")], width);
		const session = this.currentSession;
		let entries: ViewerEntry[];
		let source: RenderSource;
		try {
			if (session) {
				entries = (session.sessionManager.getBranch() as ViewerEntry[] | undefined) ?? [];
				// Live source: cwd + per-tool definitions straight from the running child.
				source = {
					cwd: session.sessionManager.getCwd(),
					toolDef: (name) => session.getToolDefinition(name) as ToolDefArg,
				};
			} else if (lane.finalBranch !== undefined) {
				// Phase A — terminated run: the live session is gone, render the snapshot,
				// and resolve cwd + tool defs from what retireRun captured (Phase 4).
				entries = (lane.finalBranch as ViewerEntry[]) ?? [];
				const defs = lane.finalToolDefs;
				source = {
					cwd: lane.finalCwd ?? "",
					toolDef: (name) => defs?.get(name) as ToolDefArg,
				};
			} else if (lane.status === "running") {
				return this.frame([this.theme.fg("dim", "(stage starting…)")], width); // between stages
			} else {
				return this.frame([this.theme.fg("dim", "(no transcript — esc to return)")], width);
			}
		} catch {
			// disposed mid-render / unexpected shape — fail soft (never throw inside the overlay)
			return this.frame([this.theme.fg("dim", "(transcript unavailable)")], width);
		}
		return this.frame(this.renderBranch(entries, width, source), width);
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
	private renderBranch(entries: ViewerEntry[], width: number, source: RenderSource): string[] {
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
							this.tui,
							cwd,
						);
						tool.setExpanded(this.toolsExpanded);
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
					const bash = new BashExecutionComponent(b.command ?? "", this.tui, b.excludeFromContext);
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
						custom.setExpanded(this.toolsExpanded);
						components.push(custom);
					}
				} else if (m.role === "compactionSummary") {
					const comp = new CompactionSummaryMessageComponent(e.message as unknown as CompactionMsgArg);
					comp.setExpanded(this.toolsExpanded);
					components.push(this.dimLine(""), comp);
				} else if (m.role === "branchSummary") {
					const bs = new BranchSummaryMessageComponent(e.message as unknown as BranchSummaryMsgArg);
					bs.setExpanded(this.toolsExpanded);
					components.push(this.dimLine(""), bs);
				} else if (m.role === "user") {
					const text = (m.content ?? [])
						.filter((p) => p.type === "text" && typeof p.text === "string")
						.map((p) => p.text)
						.join("\n")
						.trim();
					if (!text) {
						components.push(this.dimLine("└ tool result")); // non-text user content (images / tool_result)
					} else {
						// A skill invocation arrives as a user turn whose text wraps a skill block;
						// render the (collapsible) block, then any trailing user message separately.
						const skill = parseSkillBlock(text);
						if (skill) {
							const sk = new SkillInvocationMessageComponent(skill);
							sk.setExpanded(this.toolsExpanded);
							components.push(sk);
							if (skill.userMessage) components.push(new UserMessageComponent(skill.userMessage));
						} else {
							components.push(new UserMessageComponent(text));
						}
					}
				} else {
					components.push(this.dimLine(`· ${m.role ?? e.type}`));
				}
			} catch {
				// unexpected message shape — keep replaying the rest of the branch
				components.push(this.dimLine(`· ${m.role ?? e.type}`));
			}
		}

		const body: string[] = [];
		for (const c of components) {
			try {
				body.push(...c.render(width));
			} catch {
				body.push(truncateToWidth(this.theme.fg("dim", "· (unrenderable)"), width, "…"));
			}
		}
		return body;
	}

	/** A single dim fallback line wrapped as a Component so it can sit in the ordered list. */
	private dimLine(text: string): Component {
		const theme = this.theme;
		return {
			render: (w: number) => [truncateToWidth(theme.fg("dim", text), w, "…")],
			invalidate() {},
		};
	}

	/** Header + bottom-anchored windowed body + footer. scrollOffset 0 = newest (tail). */
	private frame(body: string[], width: number): string[] {
		const lane = getLane(this.runId);
		const name = lane?.name ?? this.runId;
		// Live runs read "▶ name — live"; a retained terminal run reflects its outcome.
		const headText =
			!lane || lane.status === "running"
				? `▶ ${name} — live`
				: `${TERMINAL_GLYPH[lane.status] ?? "•"} ${name} — ${lane.status}`;
		const header = truncateToWidth(this.theme.fg("accent", headText), width, "…");
		// When the lane has a queued question, esc closes the viewer AND surfaces it
		// (switchIntoLane drains after the viewer resolves) — so advertise "esc to answer".
		const needs = laneNeedsInput(this.runId);
		const toggle = this.toolsExpanded ? "t collapse" : "t expand";
		const footer = truncateToWidth(
			this.theme.fg(
				needs ? "warning" : "dim",
				needs ? `↑/↓ scroll · ${toggle} · esc to answer` : `↑/↓ scroll · ${toggle} · esc back`,
			),
			width,
			"…",
		);
		const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(6, Math.floor(termRows * MAX_HEIGHT_RATIO));
		const bodyBudget = Math.max(1, maxRows - 2); // header + footer
		const excess = Math.max(0, body.length - bodyBudget);
		if (this.scrollOffset > excess) this.scrollOffset = excess;
		const start = excess - this.scrollOffset;
		return [header, ...body.slice(start, start + bodyBudget), footer];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = this.scrollOffset + 1; // reveal older
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (data === "t") {
			// Toggle expanded state for every tool/summary component (rebuilt next render).
			this.toolsExpanded = !this.toolsExpanded;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		// render recomputes from live state each cycle — nothing cached
	}

	dispose(): void {
		this.sessionUnsub?.();
		this.registryUnsub();
	}
}

/**
 * Open the viewer as a focused overlay (mirror showBtwOverlay). The focused lane
 * manager (Phase 5) calls this on ⏎; resolves when the user presses esc.
 */
export function showLaneViewer(ui: ExtensionUIContext, runId: string): Promise<void> {
	return ui.custom<void>((tui, theme, _kb, done) => new LaneViewer(runId, tui, theme, done), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "90%",
			margin: { left: 0, right: 0, bottom: 0 },
		},
	});
}
