import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const COLOR_ACCENT = "accent";

const HORIZONTAL_RULE = "─";

/** Renders the shared voice overlay divider without reading Pi's global theme singleton. */
export class AccentDivider implements Component {
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(private readonly theme: Theme) {}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.#cachedLines && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		const lines = [this.theme.fg(COLOR_ACCENT, HORIZONTAL_RULE.repeat(Math.max(1, width)))];
		this.#cachedWidth = width;
		this.#cachedLines = lines;
		return lines;
	}
}
