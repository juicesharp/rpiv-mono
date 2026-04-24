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
import { describeActivity, formatDuration, formatTokens, formatTurns } from "./activity.js";
import { MAX_WIDGET_LINES, SPINNER, TICK_MS, WIDGET_KEY } from "./constants.js";
import { hasAnyVisible, listRuns, runningCount } from "./run-tracker.js";
import type { SingleResult, TrackedRun } from "./types.js";

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

		if (!hasAnyVisible()) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.widgetInterval) {
				clearInterval(this.widgetInterval);
				this.widgetInterval = undefined;
			}
			return;
		}

		this.ensureTimer();

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

		const truncate = (line: string) => truncateToWidth(line, width);
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
		const last = run.results[run.results.length - 1];
		const stats = this.buildStats(run);
		let headingMiddle: string;
		if (run.mode === "chain") {
			const step = run.results.length;
			const total = this.inferChainSteps(run);
			const position = total ? `step ${step}/${total}` : `step ${step}`;
			headingMiddle = `${theme.bold(run.displayName)}  ${theme.fg("muted", position)}`;
		} else if (run.mode === "parallel") {
			const done = run.results.filter((r) => r.exitCode !== -1).length;
			const total = run.results.length;
			const position = total > 0 ? `${done}/${total} done` : "starting";
			headingMiddle = `${theme.bold(run.displayName)}  ${theme.fg("muted", position)}`;
		} else {
			headingMiddle = `${theme.bold(run.displayName)}  ${theme.fg("muted", run.description)}`;
		}
		const heading =
			`${theme.fg("accent", frame)} ${headingMiddle} ` + `${theme.fg("dim", "·")} ${theme.fg("dim", stats)}`;
		const activity = describeActivity(last);
		return [
			truncate(`${theme.fg("dim", "├─")} ${heading}`),
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
			const msg = run.errorMessage ? `: ${run.errorMessage.slice(0, 60)}` : "";
			trail = theme.fg("error", ` error${msg}`);
		}
		const body =
			`${icon} ${theme.fg("dim", run.displayName)}  ${theme.fg("dim", run.description)} ` +
			`${theme.fg("dim", "·")} ${theme.fg("dim", stats)}${trail}`;
		return truncate(`${theme.fg("dim", "├─")} ${body}`);
	}

	private buildStats(run: TrackedRun): string {
		const last: SingleResult | undefined = run.results[run.results.length - 1];
		const parts: string[] = [];
		if (last?.usage.turns) parts.push(formatTurns(last.usage.turns));
		const tokens = last ? last.usage.input + last.usage.output : 0;
		if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
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
