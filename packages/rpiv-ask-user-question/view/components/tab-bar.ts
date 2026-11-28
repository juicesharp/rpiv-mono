import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.ts";

/**
 * Per-tick projection of TabBar state. The selector
 * (`selectTabBarProps`) hoists every render-time derivation
 * (`allAnswered`, `answered`, `isActive`, `submitActive`) into props so
 * `render()` is pure styling.
 */
export interface TabBarProps {
	/** One per author-defined question, in order. */
	tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean }>;
	/** Submit-tab state. `allAnswered` drives the success/dim color picker. */
	submit: { active: boolean; allAnswered: boolean };
}

interface TabSegment {
	styled: string;
	width: number;
}

interface TabWindow {
	start: number;
	end: number;
	leftClip: boolean;
	rightClip: boolean;
}

const LEFT_CAP = " ← ";
const RIGHT_CAP = " →";
const SUBMIT_TEXT = " ✓ Submit ";
const ELLIPSIS = "…";

function segmentFor(theme: Theme, tab: TabBarProps["tabs"][number]): TabSegment {
	const raw = ` ${tab.answered ? "■" : "□"} ${tab.label} `;
	const styled = tab.active
		? theme.bg("selectedBg", theme.fg("text", raw))
		: theme.fg(tab.answered ? "success" : "muted", raw);
	return { styled, width: visibleWidth(raw) };
}

/**
 * Width of a tab run joined by single spaces, including one ellipsis per
 * clipped side (the ellipsis itself plus its separating space).
 */
function runWidth(segments: readonly TabSegment[], leftClip: boolean, rightClip: boolean): number {
	const inner = segments.reduce((sum, segment) => sum + segment.width, 0);
	const gaps = Math.max(0, segments.length - 1);
	return inner + gaps + (leftClip ? 2 : 0) + (rightClip ? 2 : 0);
}

/**
 * Largest run of tabs around `active` that fits `available` columns. Returns
 * undefined when even the active tab plus both ellipses cannot fit; callers
 * fall back to the compact `Q i/N` indicator.
 */
function findWindow(segments: readonly TabSegment[], active: number, available: number): TabWindow | undefined {
	for (let length = segments.length; length >= 1; length -= 1) {
		let best: (TabWindow & { distance: number }) | undefined;
		const startMin = Math.max(0, active - length + 1);
		const startMax = Math.min(active, segments.length - length);
		for (let start = startMin; start <= startMax; start += 1) {
			const end = start + length - 1;
			const leftClip = start > 0;
			const rightClip = end < segments.length - 1;
			const window = segments.slice(start, end + 1);
			if (runWidth(window, leftClip, rightClip) > available) continue;
			const distance = Math.abs((start + end) / 2 - active);
			if (best === undefined || distance < best.distance) {
				best = { start, end, leftClip, rightClip, distance };
			}
		}
		if (best !== undefined) return best;
	}
	return undefined;
}

export class TabBar implements StatefulView<TabBarProps> {
	private props: TabBarProps;
	private readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
		this.props = { tabs: [], submit: { active: false, allAnswered: false } };
	}

	setProps(props: TabBarProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	private renderSubmit(): string {
		const submitText = SUBMIT_TEXT;
		return this.props.submit.active
			? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
			: this.theme.fg(this.props.submit.allAnswered ? "success" : "dim", submitText);
	}

	private renderTabs(available: number): string {
		const segments = this.props.tabs.map((tab) => segmentFor(this.theme, tab));
		if (segments.length === 0) return "";

		const active = Math.max(
			0,
			this.props.tabs.findIndex((tab) => tab.active),
		);
		const fullWidth = runWidth(segments, false, false);
		if (fullWidth <= available) {
			return segments.map((segment) => segment.styled).join(" ");
		}

		const window = findWindow(segments, active, available);
		if (window === undefined) {
			const compact = ` ${this.props.tabs[active]?.answered ? "■" : "□"} ${active + 1}/${segments.length} `;
			return visibleWidth(compact) <= available ? this.theme.bg("selectedBg", this.theme.fg("text", compact)) : "";
		}

		const pieces: string[] = [];
		if (window.leftClip) pieces.push(this.theme.fg("muted", ELLIPSIS));
		for (const segment of segments.slice(window.start, window.end + 1)) {
			pieces.push(segment.styled);
		}
		if (window.rightClip) pieces.push(this.theme.fg("muted", ELLIPSIS));
		return pieces.join(" ");
	}

	render(width: number): string[] {
		const fixedWidth = visibleWidth(LEFT_CAP) + visibleWidth(RIGHT_CAP) + visibleWidth(SUBMIT_TEXT) + 1;
		const tabs = this.renderTabs(width - fixedWidth);
		const tabsPart = tabs === "" ? "" : `${tabs} `;
		const tabLine = `${LEFT_CAP}${tabsPart}${this.renderSubmit()}${RIGHT_CAP}`;
		return [truncateToWidth(tabLine, width, ""), ""];
	}
}
