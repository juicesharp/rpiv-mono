import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { EqualizerViewProps } from "./components/equalizer-view.ts";
import type { SettingsFormViewProps } from "./components/settings-form-view.ts";
import type { StatusBarViewProps } from "./components/status-bar-view.ts";
import type { TranscriptViewProps } from "./components/transcript-view.ts";
import { DictationScreenStrategy, SettingsScreenStrategy } from "./screen-content-strategy.ts";
import type { StatefulView } from "./stateful-view.ts";

function fakeComponent(): Component {
	return {
		render: () => ["fake"],
		invalidate: () => {},
	};
}

function fakeStateful<P>(): StatefulView<P> {
	return {
		...fakeComponent(),
		setProps() {},
		handleInput() {},
	};
}

describe("DictationScreenStrategy", () => {
	it("has kind 'dictation'", () => {
		const strategy = new DictationScreenStrategy({
			transcript: fakeStateful<TranscriptViewProps>(),
			divider: fakeComponent(),
			equalizer: fakeStateful<EqualizerViewProps>(),
			statusBar: fakeStateful<StatusBarViewProps>(),
		});
		expect(strategy.kind).toBe("dictation");
	});

	it("returns [transcript, divider, equalizer, statusBar] children", () => {
		const transcript = fakeStateful<TranscriptViewProps>();
		const divider = fakeComponent();
		const equalizer = fakeStateful<EqualizerViewProps>();
		const statusBar = fakeStateful<StatusBarViewProps>();
		const strategy = new DictationScreenStrategy({ transcript, divider, equalizer, statusBar });

		const children = strategy.children();
		expect(children).toHaveLength(4);
		expect(children[0]).toBe(transcript);
		expect(children[1]).toBe(divider);
		expect(children[2]).toBe(equalizer);
		expect(children[3]).toBe(statusBar);
	});
});

describe("SettingsScreenStrategy", () => {
	it("has kind 'settings'", () => {
		const strategy = new SettingsScreenStrategy({
			settingsForm: fakeStateful<SettingsFormViewProps>(),
			divider: fakeComponent(),
			equalizer: fakeStateful<EqualizerViewProps>(),
			statusBar: fakeStateful<StatusBarViewProps>(),
		});
		expect(strategy.kind).toBe("settings");
	});

	it("returns [settingsForm, divider, equalizer, statusBar] children", () => {
		const settingsForm = fakeStateful<SettingsFormViewProps>();
		const divider = fakeComponent();
		const equalizer = fakeStateful<EqualizerViewProps>();
		const statusBar = fakeStateful<StatusBarViewProps>();
		const strategy = new SettingsScreenStrategy({ settingsForm, divider, equalizer, statusBar });

		const children = strategy.children();
		expect(children).toHaveLength(4);
		expect(children[0]).toBe(settingsForm);
		expect(children[1]).toBe(divider);
		expect(children[2]).toBe(equalizer);
		expect(children[3]).toBe(statusBar);
	});
});
