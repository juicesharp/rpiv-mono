import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.ts";

// Rows start at col 0 so the settings surface aligns with dictation
// (transcript + status bar are also flush-left). The pointer occupies a fixed
// 2-col slot so active/inactive rows share the same label start column.
const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const VALUE_SEPARATOR = ": ";
const EMPTY_PLACEHOLDER = "<unset>";
const TRUNCATE_ELLIPSIS = "…";

const COLOR_ACCENT = "accent";
const COLOR_MUTED = "muted";
const COLOR_DIM = "dim";
const COLOR_SUCCESS = "success";

export type SettingsFieldKind = { kind: "readonly"; value: string } | { kind: "toggle"; enabled: boolean };

export interface SettingsFieldViewProps {
	label: string;
	active: boolean;
	field: SettingsFieldKind;
	/** Optional muted hint rendered on the next line when active. */
	hint?: string;
}

export class SettingsFieldView implements StatefulView<SettingsFieldViewProps> {
	private props: SettingsFieldViewProps = {
		label: "",
		active: false,
		field: { kind: "readonly", value: "" },
	};

	constructor(private readonly theme: Theme) {}

	setProps(props: SettingsFieldViewProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const pointer = this.props.active ? this.theme.fg(COLOR_ACCENT, ACTIVE_POINTER) : INACTIVE_POINTER;
		const labelText = this.props.active
			? this.theme.fg(COLOR_ACCENT, this.theme.bold(this.props.label))
			: this.props.label;
		const head = `${pointer}${labelText}${VALUE_SEPARATOR}`;
		const valueText = this.renderValue();
		const headWidth = visibleWidth(head);
		const valueWidth = Math.max(1, width - headWidth);
		const clamped = truncateToWidth(valueText, valueWidth, TRUNCATE_ELLIPSIS, false);
		const lines = [`${head}${clamped}`];
		// Hints render unconditionally — gating on `active` made the form's row
		// count change as focus moved between toggles, which translated to a
		// visible jump of the bottom chrome each time the user pressed an arrow.
		// A stable height is worth the extra noise of inactive hints.
		const hint = this.props.hint;
		if (hint) {
			const hintIndent = " ".repeat(visibleWidth(ACTIVE_POINTER));
			const hintLine = `${hintIndent}${this.theme.fg(COLOR_DIM, hint)}`;
			lines.push(truncateToWidth(hintLine, width, TRUNCATE_ELLIPSIS, false));
		}
		return lines;
	}

	private renderValue(): string {
		const f = this.props.field;
		if (f.kind === "readonly") {
			return f.value.length > 0 ? this.theme.fg(COLOR_MUTED, f.value) : this.theme.fg(COLOR_DIM, EMPTY_PLACEHOLDER);
		}
		return f.enabled ? this.theme.fg(COLOR_SUCCESS, "[ on ]") : this.theme.fg(COLOR_DIM, "[ off ]");
	}
}
