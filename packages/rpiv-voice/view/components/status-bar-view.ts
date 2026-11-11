import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RecordingStatus } from "../../state/state.ts";
import { STATUS_META } from "../../state/status-intent.ts";
import type { StatefulView } from "../stateful-view.ts";

const GAP = "  ";
const TRUNCATE_ELLIPSIS = "…";

const COLOR_ACCENT = "accent";
const COLOR_DIM = "dim";
const COLOR_MUTED = "muted";

const RECORDING_PULSE_COLORS = ["error", "error", "error", "dim"] as const;
export const STATUS_BAR_PULSE_FRAME_INTERVAL_MS = 200;

// Plain text key names instead of glyphs (`⏎ ␣ ⇥ ⎋`): most terminal fonts
// substitute lookalikes whose vertical metrics don't match the surrounding
// letters, producing a wobbly baseline. Latin word labels always sit cleanly.
const HINT_SEP = " · ";

// Splits each i18n string on its first space so the leading key word ("Enter",
// "Space", …) renders in `muted` while the rest stays `dim`. The split is
// locale-stable as long as translations preserve the "Key <verb-phrase>"
// shape — e.g. "Enter to paste", "Введите для вставки" both split cleanly.
function splitHint(literal: string): { key: string; action: string } {
	const sp = literal.indexOf(" ");
	if (sp <= 0) return { key: literal, action: "" };
	return { key: literal.slice(0, sp), action: literal.slice(sp + 1) };
}

export interface StatusBarViewProps {
	status: RecordingStatus;
	/** Pre-resolved i18n strings ("Enter to paste", "Esc to go back"…). The
	 *  selector decides which set to pass based on the current screen. */
	hints: readonly string[];
}

export class StatusBarView implements StatefulView<StatusBarViewProps> {
	private props: StatusBarViewProps = { status: "recording", hints: [] };
	private pulseFrame = 0;
	private readonly startedAtMs: number;
	private pausedAtMs: number | undefined;
	private pausedAccumMs = 0;

	constructor(private readonly theme: Theme) {
		this.startedAtMs = Date.now();
	}

	setProps(props: StatusBarViewProps): void {
		const wasPaused = this.props.status === "paused";
		const isPaused = props.status === "paused";
		if (!wasPaused && isPaused) {
			this.pausedAtMs = Date.now();
		} else if (wasPaused && !isPaused && this.pausedAtMs !== undefined) {
			this.pausedAccumMs += Date.now() - this.pausedAtMs;
			this.pausedAtMs = undefined;
		}
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	tickPulse(): void {
		this.pulseFrame = (this.pulseFrame + 1) % RECORDING_PULSE_COLORS.length;
	}

	render(width: number): string[] {
		const meta = STATUS_META[this.props.status];
		const glyphColor =
			this.props.status === "recording"
				? RECORDING_PULSE_COLORS[this.pulseFrame % RECORDING_PULSE_COLORS.length]
				: meta.glyphColorKey;
		const glyph = this.theme.fg(glyphColor, meta.glyph);
		const timerColor = this.props.status === "recording" ? COLOR_ACCENT : COLOR_MUTED;
		const timer = this.theme.fg(timerColor, formatElapsed(this.elapsedMs()));
		const hints = this.props.hints
			.map((literal) => {
				const { key, action } = splitHint(literal);
				return `${this.theme.fg(COLOR_MUTED, key)} ${this.theme.fg(COLOR_DIM, action)}`;
			})
			.join(this.theme.fg(COLOR_DIM, HINT_SEP));

		const line = `${glyph} ${timer}${GAP}${hints}`;
		return [truncateToWidth(line, width, TRUNCATE_ELLIPSIS, false)];
	}

	private elapsedMs(): number {
		const now = Date.now();
		const livePauseMs = this.pausedAtMs !== undefined ? now - this.pausedAtMs : 0;
		return Math.max(0, now - this.startedAtMs - this.pausedAccumMs - livePauseMs);
	}
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PADDING_DIGITS = 2;

function decomposeElapsed(ms: number): { minutes: number; seconds: number } {
	const totalSeconds = Math.floor(ms / MS_PER_SECOND);
	return {
		minutes: Math.floor(totalSeconds / SECONDS_PER_MINUTE),
		seconds: totalSeconds % SECONDS_PER_MINUTE,
	};
}

function formatElapsed(ms: number): string {
	const { minutes, seconds } = decomposeElapsed(ms);
	return `${minutes}:${seconds.toString().padStart(SECONDS_PADDING_DIGITS, "0")}`;
}
