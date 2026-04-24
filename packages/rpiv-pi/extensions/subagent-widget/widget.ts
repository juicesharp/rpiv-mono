/**
 * SubagentWidget — setWidget lifecycle controller for the subagent-tree overlay.
 *
 * Mirrors the canonical references: TodoOverlay (register-once +
 * identity-compared ctx + invalidate() render-cache reset) and AgentWidget
 * (80 ms spinner timer + turn-aware overflow loop). Reads tracker state
 * live at render time; never snapshots state in the factory closure.
 *
 * Timer ownership: setInterval(.unref()) drives widgetFrame++ for the
 * braille spinner. TUI's 16 ms coalescing absorbs the tick rate. Interval
 * starts on first update() with tracked runs and stops on idle teardown.
 */

import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import { type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import { describeActivity, formatDuration, formatTokens, formatToolUses, formatTurns } from "./activity.js";
import { MAX_DESCRIPTOR_CHARS, MAX_WIDGET_LINES, SPINNER, TICK_MS, WIDGET_KEY } from "./constants.js";
import { listRuns, runningCount } from "./run-tracker.js";
import type { AgentProgress, SingleResult, TrackedRun } from "./types.js";

// Defensive: any \n in a returned string[] element splits into physical rows pi-tui can't
// track, leaving stale artifacts every frame. Run-tracker sanitizes at ingest; this guard
// covers any future caller that mutates description/displayName directly on the tracked run.
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, " ");
// Character cap on the descriptor column. Keeps stats visible on both running
// and finished rows regardless of terminal width — prior width-aware budget
// let long prompts push stats off the right edge where `truncateToWidth`
// silently clipped them with "...".
const capDescriptor = (s: string): string =>
	s.length <= MAX_DESCRIPTOR_CHARS ? s : `${s.slice(0, MAX_DESCRIPTOR_CHARS - 1)}…`;

export class SubagentWidget {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private widgetFrame = 0;
	private widgetInterval: ReturnType<typeof setInterval> | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	ensureTimer(): void {
		if (!this.widgetInterval) {
			const handle = setInterval(() => this.tick(), TICK_MS);
			handle.unref?.();
			this.widgetInterval = handle;
		}
	}

	private tick(): void {
		this.widgetFrame++;
		if (this.widgetRegistered && this.tui) {
			this.tui.requestRender();
		} else {
			this.update();
		}
	}

	update(): void {
		if (!this.uiCtx) return;

		// Keep the widget registered even when there are no visible runs so
		// our slot in Pi's aboveEditor widget Map is claimed at session_start
		// (before Todos registers). Map iteration order is insertion-order,
		// so first-registered renders on top. renderWidget() returns [] when
		// empty — no visible footprint, just the reservation.
		if (runningCount() > 0) {
			this.ensureTimer();
		} else if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const runs = listRuns();
		if (runs.length === 0) return [];

		// Single-char `…` marker matches our descriptor cap (capDescriptor) and the
		// activity-line helper (activity.ts:truncateLine). pi-tui's default is "..."
		// which would mix two ellipsis styles inside the same widget.
		const truncate = (line: string) => truncateToWidth(line, width, "…");
		const frame = SPINNER[this.widgetFrame % SPINNER.length];
		const active = runningCount() > 0;

		const headingColor: "accent" | "dim" = active ? "accent" : "dim";
		const headingIcon = active ? "●" : "○";
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Subagents")}`);

		const runningBlocks: string[][] = [];
		const finishedLines: string[] = [];
		for (const run of runs) {
			if (run.status === "running") {
				runningBlocks.push(this.renderRunningBlock(run, theme, frame, truncate));
			} else {
				finishedLines.push(this.renderFinishedLine(run, theme, truncate));
			}
		}

		const maxBody = MAX_WIDGET_LINES - 1;
		const totalBody = runningBlocks.reduce((n, b) => n + b.length, 0) + finishedLines.length;

		const lines: string[] = [heading];
		if (totalBody <= maxBody) {
			for (const pair of runningBlocks) lines.push(...pair);
			lines.push(...finishedLines);
			this.fixupLastConnector(lines, runningBlocks.length, finishedLines.length);
			// Trailing blank separates our overlay from whatever sits below (Todos,
			// editor, next widget). Without it our last tree row hugs the next
			// overlay's heading row with no visual break.
			lines.push("");
			return lines;
		}

		// Overflow: reserve 1 line for footer; prioritize running > finished.
		let budget = maxBody - 1;
		let hiddenRunning = 0;
		let hiddenFinished = 0;
		for (const pair of runningBlocks) {
			if (budget >= pair.length) {
				lines.push(...pair);
				budget -= pair.length;
			} else {
				hiddenRunning++;
			}
		}
		for (const fl of finishedLines) {
			if (budget >= 1) {
				lines.push(fl);
				budget--;
			} else {
				hiddenFinished++;
			}
		}
		const total = hiddenRunning + hiddenFinished;
		const parts: string[] = [];
		if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
		if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
		const footer = parts.length > 0 ? `+${total} more (${parts.join(", ")})` : `+${total} more`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", footer)}`));
		lines.push("");
		return lines;
	}

	private fixupLastConnector(lines: string[], runningBlocks: number, finishedCount: number): void {
		if (lines.length <= 1) return;
		const last = lines.length - 1;
		lines[last] = lines[last].replace("├─", "└─");
		if (finishedCount === 0 && runningBlocks > 0 && last >= 2) {
			lines[last - 1] = lines[last - 1].replace("├─", "└─");
			lines[last] = lines[last].replace("│  ", "   ");
		}
	}

	private renderRunningBlock(run: TrackedRun, theme: Theme, frame: string, truncate: (s: string) => string): string[] {
		// Layout: `├─ {frame} {bold(name)}  {muted(descriptor)} · {dim(stats)}`.
		// Descriptor capped by `MAX_DESCRIPTOR_CHARS` so the stats tail is never
		// clipped off the right edge by `truncateToWidth`.
		const last = run.results[run.results.length - 1];
		const progress = run.progress?.[run.progress.length - 1];
		const stats = this.buildStats(run);

		let descriptor: string;
		if (run.mode === "chain") {
			const step = run.results.length;
			const total = this.inferChainSteps(run);
			descriptor = total ? `step ${step}/${total}` : `step ${step}`;
		} else if (run.mode === "parallel") {
			const done = run.results.filter((r) => r.exitCode !== -1).length;
			const total = run.results.length;
			descriptor = total > 0 ? `${done}/${total} done` : "starting";
		} else {
			descriptor = oneLine(run.description);
		}

		const prefix = `${theme.fg("dim", "├─")} ${theme.fg("accent", frame)} ${theme.bold(oneLine(run.displayName))}`;
		const tail = `${theme.fg("dim", "·")} ${theme.fg("dim", stats)}`;
		const descriptorOut = capDescriptor(descriptor);
		const middle = descriptorOut ? `  ${theme.fg("muted", descriptorOut)} ` : "  ";
		const activity = describeActivity(last, progress);
		return [
			truncate(`${prefix}${middle}${tail}`),
			truncate(`${theme.fg("dim", "│  ")}${theme.fg("dim", `  ⎿  ${activity}`)}`),
		];
	}

	private renderFinishedLine(run: TrackedRun, theme: Theme, truncate: (s: string) => string): string {
		const stats = this.buildStats(run);
		let icon: string;
		let trail: string;
		if (run.status === "completed") {
			icon = theme.fg("success", "✓");
			trail = "";
		} else if (run.status === "steered") {
			icon = theme.fg("warning", "✓");
			trail = theme.fg("warning", " (turn limit)");
		} else if (run.status === "stopped") {
			icon = theme.fg("dim", "■");
			trail = theme.fg("dim", " stopped");
		} else if (run.status === "aborted") {
			icon = theme.fg("error", "✗");
			trail = theme.fg("warning", " aborted");
		} else {
			icon = theme.fg("error", "✗");
			const msg = run.errorMessage ? `: ${oneLine(run.errorMessage).slice(0, 60)}` : "";
			trail = theme.fg("error", ` error${msg}`);
		}
		const body =
			`${icon} ${theme.fg("dim", oneLine(run.displayName))}  ${theme.fg("dim", capDescriptor(oneLine(run.description)))} ` +
			`${theme.fg("dim", "·")} ${theme.fg("dim", stats)}${trail}`;
		return truncate(`${theme.fg("dim", "├─")} ${body}`);
	}

	private buildStats(run: TrackedRun): string {
		const last: SingleResult | undefined = run.results[run.results.length - 1];
		const progress: AgentProgress | undefined = run.progress?.[run.progress.length - 1];
		const parts: string[] = [];

		// Turns: only settle on message_end, so last.usage.turns is authoritative
		// across both streaming and terminal states.
		if (last?.usage.turns) parts.push(formatTurns(last.usage.turns));

		// Tool uses: live during streaming via progress.toolCount (set on
		// tool_execution_start, before message_end). No SingleResult equivalent.
		if (progress?.toolCount) parts.push(formatToolUses(progress.toolCount));

		// Tokens: prefer live progress.tokens during streaming; at terminal state
		// prefer the SingleResult.usage aggregate (authoritative post-completion).
		const streamingTokens = run.status === "running" ? (progress?.tokens ?? 0) : 0;
		const terminalTokens = last ? last.usage.input + last.usage.output : 0;
		const tokens = Math.max(streamingTokens, terminalTokens);
		if (tokens > 0) parts.push(formatTokens(tokens));

		parts.push(formatDuration(run.startedAt, run.completedAt));
		return parts.join(" · ");
	}

	private inferChainSteps(run: TrackedRun): number | undefined {
		const match = run.displayName.match(/\((\d+) steps?\)/);
		return match ? Number.parseInt(match[1], 10) : undefined;
	}

	dispose(): void {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}
		if (this.uiCtx) {
			this.uiCtx.setWidget(WIDGET_KEY, undefined);
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}
