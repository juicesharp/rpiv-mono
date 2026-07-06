import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { t } from "../../state/i18n-bridge.js";
import type { StatefulView } from "../stateful-view.js";
import { AccentDivider } from "./accent-divider.js";

export const SPLASH_FRAMES = ["⠴", "⠦", "⠖", "⠲"] as const;
export const SPLASH_FRAME_INTERVAL_MS = 160;

export type SplashPhase =
	| {
			kind: "downloading";
			message: string;
			/** 0-100 integer when Content-Length was provided. */
			percent?: number;
			bytesReceived?: number;
			totalBytes?: number;
	  }
	| { kind: "extracting"; message: string }
	| { kind: "verifying"; message: string }
	| { kind: "loading_engine" }
	| { kind: "initializing_mic" };

export interface SplashViewProps {
	phase: SplashPhase;
	frame: number;
}

const TRUNCATE_ELLIPSIS = "…";

const COLOR_ACCENT = "accent";
const COLOR_MUTED = "muted";

function phaseLabel(phase: SplashPhase): string {
	switch (phase.kind) {
		case "downloading":
			return appendDownloadProgress(phase.message, phase);
		case "extracting":
		case "verifying":
			return phase.message;
		case "loading_engine":
			return t("splash.loading_engine", "Loading speech model…");
		case "initializing_mic":
			return t("splash.initializing_mic", "Initializing microphone…");
	}
}

const BYTES_PER_MB = 1024 * 1024;

function formatMB(bytes: number): string {
	return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

// Decorate the downloading label with whatever progress information we have:
//   - percent + bytes when Content-Length was present
//   - byte counter only when the server didn't send Content-Length
//   - bare label on the very first emit before any chunk has arrived
function appendDownloadProgress(
	base: string,
	progress: { percent?: number; bytesReceived?: number; totalBytes?: number },
): string {
	if (progress.bytesReceived === undefined) return base;
	if (progress.totalBytes && progress.percent !== undefined) {
		return `${base} ${progress.percent}% (${formatMB(progress.bytesReceived)} / ${formatMB(progress.totalBytes)})`;
	}
	return `${base} ${formatMB(progress.bytesReceived)}`;
}

/**
 * Splash chrome mirrors the in-session layout: a divider line on top followed
 * by a single status line. The status line uses the same `${glyph} ${label}`
 * shape as `StatusBarView` (`● 0:42 …`) — a leading colored glyph, single
 * space, then a muted label — so the splash feels like a quieter sibling of
 * the dictation/settings chrome rather than a separate widget.
 */
export class SplashView implements StatefulView<SplashViewProps> {
	private readonly divider: AccentDivider;
	private props: SplashViewProps = { phase: { kind: "loading_engine" }, frame: 0 };

	constructor(private readonly theme: Theme) {
		this.divider = new AccentDivider(theme);
	}

	setProps(props: SplashViewProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const frameChar = SPLASH_FRAMES[this.props.frame % SPLASH_FRAMES.length];
		const spinner = this.theme.fg(COLOR_ACCENT, frameChar);
		const label = this.theme.fg(COLOR_MUTED, phaseLabel(this.props.phase));
		const statusLine = `${spinner} ${label}`;
		return [...this.divider.render(width), truncateToWidth(statusLine, width, TRUNCATE_ELLIPSIS, false)];
	}
}
