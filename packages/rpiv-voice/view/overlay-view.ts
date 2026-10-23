import { Container } from "@earendil-works/pi-tui";
import { clipToTerminalHeight } from "../state/selectors/derivations.ts";
import type { VoiceState } from "../state/state.ts";
import type { ScreenContentStrategy } from "./screen-content-strategy.ts";
import type { StatefulView } from "./stateful-view.ts";

const FALLBACK_TERMINAL_ROWS = 24;

// Bottom chrome rows depend on whether the equalizer is enabled. With the
// equalizer ON, the chrome is `[divider, eq×7, statusBar]` (9 rows); with it
// OFF the equalizer renders zero rows and the chrome collapses to `[divider,
// statusBar]` (2 rows). Subtracting the chrome count from total rows gives
// the body row count that needs height equalization.
const BOTTOM_CHROME_ROWS_WITH_EQ = 9;
const BOTTOM_CHROME_ROWS_WITHOUT_EQ = 2;

export interface OverlayViewProps {
	state: VoiceState;
}

export interface OverlayViewConfig {
	tui: { terminal: { rows?: number; columns: number } };
	dictation: ScreenContentStrategy;
	settings: ScreenContentStrategy;
}

/**
 * OverlayView keeps the divider + status-bar pinned at the same vertical
 * offset across screen flips. Each render:
 *   1. Renders both strategies (cheap — components are pure renderers).
 *   2. Updates a high-water mark of the body height (rows above the bottom
 *      chrome) across both. Once dictation has grown to N rows, every
 *      subsequent settings render pads up to N too — so the user never sees
 *      the chrome jump after switching screens.
 *   3. Top-pads the active strategy's rows with empty lines to match the
 *      target.
 *   4. Top-clips to ~85% of terminal height (handled by clipToTerminalHeight).
 */
export class OverlayView implements StatefulView<OverlayViewProps> {
	private liveState: VoiceState | undefined;
	private targetBodyHeight = 0;

	constructor(private readonly config: OverlayViewConfig) {}

	setProps(props: OverlayViewProps): void {
		this.liveState = props.state;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.liveState;
		if (!state) return [];

		const chromeRows = state.settingsDraft.equalizerEnabled
			? BOTTOM_CHROME_ROWS_WITH_EQ
			: BOTTOM_CHROME_ROWS_WITHOUT_EQ;
		const dictRows = this.renderStrategy(this.config.dictation, width);
		const settRows = this.renderStrategy(this.config.settings, width);
		const dictBody = Math.max(0, dictRows.length - chromeRows);
		const settBody = Math.max(0, settRows.length - chromeRows);
		this.targetBodyHeight = Math.max(this.targetBodyHeight, dictBody, settBody);

		const activeRows = state.currentScreen === "settings" ? settRows : dictRows;
		const currentBody = Math.max(0, activeRows.length - chromeRows);
		const padNeeded = this.targetBodyHeight - currentBody;
		const padded = padNeeded > 0 ? [...new Array<string>(padNeeded).fill(""), ...activeRows] : activeRows;
		return clipToTerminalHeight(padded, this.terminalRows());
	}

	private renderStrategy(strategy: ScreenContentStrategy, width: number): string[] {
		const container = new Container();
		for (const child of strategy.children()) container.addChild(child);
		return container.render(width);
	}

	private terminalRows(): number {
		return this.config.tui.terminal.rows ?? FALLBACK_TERMINAL_ROWS;
	}
}
