import type { StatefulView } from "../stateful-view.ts";
import type { SettingsFieldView } from "./settings-field-view.ts";

// The settings screen is a flat stack of rows: a read-only mic line and a
// hallucination-filter toggle. No tabs — too few rows to justify chrome.
export interface SettingsFormViewProps {}

export interface SettingsFormViewConfig {
	fields: ReadonlyArray<SettingsFieldView>;
}

export class SettingsFormView implements StatefulView<SettingsFormViewProps> {
	constructor(private readonly config: SettingsFormViewConfig) {}

	setProps(_props: SettingsFormViewProps): void {}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const view of this.config.fields) lines.push(...view.render(width));
		return lines;
	}
}
