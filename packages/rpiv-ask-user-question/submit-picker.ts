import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth } from "@mariozechner/pi-tui";
import type { DialogState } from "./dialog-builder.js";

const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const NUMBER_SEPARATOR = ". ";

export const SUBMIT_LABEL = "Submit answers";
export const CANCEL_LABEL = "Cancel";

/**
 * Static 2-row picker rendered on the Submit Tab. Row 0 = "Submit answers", Row 1 = "Cancel".
 *
 * - Active pointer (❯) follows `state.submitChoiceIndex` and is shown only when `focused`.
 * - Both rows render in normal style at all times — D1 (revised) allows partial submission,
 *   so Submit is never dimmed or visually marked as unselectable. The warning header in
 *   `buildSubmitContainer` is the sole signal of incompleteness.
 * - `naturalHeight(width)` is state-INDEPENDENT and returns a constant 2, so the
 *   chrome-mirror layout in `buildSubmitContainer` can subtract a fixed 2 lines without
 *   re-rendering.
 */
export class SubmitPicker implements Component {
	private state: DialogState;
	private focused = false;

	constructor(
		private readonly theme: Theme,
		initialState: DialogState,
	) {
		this.state = initialState;
	}

	setState(state: DialogState): void {
		this.state = state;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	naturalHeight(_width: number): number {
		return 2;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < 2; i++) {
			const text = i === 0 ? SUBMIT_LABEL : CANCEL_LABEL;
			const active = this.focused && i === this.state.submitChoiceIndex;
			const pointer = active ? ACTIVE_POINTER : INACTIVE_POINTER;
			const number = `${i + 1}${NUMBER_SEPARATOR}`;
			const label = active ? this.theme.fg("accent", this.theme.bold(text)) : this.theme.fg("text", text);
			lines.push(truncateToWidth(`${pointer}${number}${label}`, width, ""));
		}
		return lines;
	}
}
