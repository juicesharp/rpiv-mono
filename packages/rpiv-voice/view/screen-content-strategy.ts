import type { Component } from "@earendil-works/pi-tui";
import type { EqualizerViewProps } from "./components/equalizer-view.ts";
import type { SettingsFormViewProps } from "./components/settings-form-view.ts";
import type { StatusBarViewProps } from "./components/status-bar-view.ts";
import type { TranscriptViewProps } from "./components/transcript-view.ts";
import type { StatefulView } from "./stateful-view.ts";

/**
 * Per-screen layout. Returns the ordered list of pi-tui Components that the
 * overlay container renders top-down: body component → divider → equalizer →
 * status row. Both screens share the same bottom chrome so the equalizer
 * column and key hints stay vertically pinned when flipping between dictation
 * and settings; nothing is inserted above the body or between the equalizer
 * and the status row, so the overlay reads flush against both edges.
 */
export interface ScreenContentStrategy {
	readonly kind: "dictation" | "settings";
	children(): readonly Component[];
}

export interface DictationScreenStrategyConfig {
	transcript: StatefulView<TranscriptViewProps>;
	divider: Component;
	equalizer: StatefulView<EqualizerViewProps>;
	statusBar: StatefulView<StatusBarViewProps>;
}

export class DictationScreenStrategy implements ScreenContentStrategy {
	readonly kind = "dictation" as const;

	constructor(private readonly config: DictationScreenStrategyConfig) {}

	children(): readonly Component[] {
		return [this.config.transcript, this.config.divider, this.config.equalizer, this.config.statusBar];
	}
}

export interface SettingsScreenStrategyConfig {
	settingsForm: StatefulView<SettingsFormViewProps>;
	divider: Component;
	equalizer: StatefulView<EqualizerViewProps>;
	statusBar: StatefulView<StatusBarViewProps>;
}

export class SettingsScreenStrategy implements ScreenContentStrategy {
	readonly kind = "settings" as const;

	constructor(private readonly config: SettingsScreenStrategyConfig) {}

	children(): readonly Component[] {
		return [this.config.settingsForm, this.config.divider, this.config.equalizer, this.config.statusBar];
	}
}
