import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.ts";

const COLOR_MUTED = "muted";
const COLOR_DIM = "dim";

export interface TranscriptViewProps {
	/** Committed (final-decoded) transcript — what gets pasted on Enter. */
	text: string;
	/** In-progress reading of the still-active utterance. Rendered in dim
	 *  immediately after `text`, separated by a single space when both are
	 *  non-empty. Replaced wholesale on each rolling decode and cleared the
	 *  moment the final commit lands. */
	partial?: string;
	placeholder: string;
}

export class TranscriptView implements StatefulView<TranscriptViewProps> {
	private props: TranscriptViewProps = { text: "", partial: "", placeholder: "Listening..." };

	constructor(private readonly theme: Theme) {}

	setProps(props: TranscriptViewProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const committed = this.props.text;
		const partial = this.props.partial ?? "";
		if (!committed && !partial) {
			return [this.theme.fg(COLOR_MUTED, this.props.placeholder)];
		}
		// Concatenate committed + partial with a separating space so wrapping
		// treats them as one paragraph; the partial portion is themed dim.
		const partialColored = partial ? this.theme.fg(COLOR_DIM, partial) : "";
		const merged = committed && partialColored ? `${committed} ${partialColored}` : `${committed}${partialColored}`;

		const lines: string[] = [];
		for (const ln of merged.split("\n")) {
			const src = ln.length === 0 ? " " : ln;
			lines.push(...wrapTextWithAnsi(src, width));
		}
		return lines;
	}
}
