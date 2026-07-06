import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { VoiceConfig } from "../config/voice-config.js";
import { saveVoiceConfig } from "../config/voice-config.js";
import { globalBinding } from "../view/component-binding.js";
import { AccentDivider } from "../view/components/accent-divider.js";
import { EqualizerView } from "../view/components/equalizer-view.js";
import { SettingsFieldView } from "../view/components/settings-field-view.js";
import { SettingsFormView } from "../view/components/settings-form-view.js";
import { StatusBarView } from "../view/components/status-bar-view.js";
import { TranscriptView } from "../view/components/transcript-view.js";
import { OverlayView } from "../view/overlay-view.js";
import { VoiceOverlayPropsAdapter } from "../view/props-adapter.js";
import { DictationScreenStrategy, SettingsScreenStrategy } from "../view/screen-content-strategy.js";
import { t } from "./i18n-bridge.js";
import { routeKey, type VoiceAction } from "./key-router.js";
import {
	selectEqualizerFieldProps,
	selectEqualizerProps,
	selectHallucinationFilterFieldProps,
	selectLanguageReadonlyFieldProps,
	selectMicReadonlyFieldProps,
	selectStatusBarProps,
	selectTranscriptProps,
} from "./selectors/projections.js";
import { initialVoiceState, type VoiceState } from "./state.js";
import { type ApplyContext, draftFromConfig, type Effect, reduce, type VoiceResult } from "./state-reducer.js";

export interface VoiceSessionDeps {
	pasteToEditor: (text: string) => void;
	notify: (message: string, level: "error" | "info") => void;
	abort: () => void;
	stopMic: () => void;
	setPipelinePaused: (paused: boolean) => void;
	setHallucinationFilterEnabled: (enabled: boolean) => void;
}

export interface VoiceSessionConfig {
	tui: { terminal: { columns: number; rows?: number }; requestRender(): void };
	theme: Theme;
	persistedConfig: VoiceConfig;
	deps: VoiceSessionDeps;
	done: (result: VoiceResult) => void;
}

export interface VoiceSessionComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export class VoiceSession {
	private state: VoiceState;
	private readonly persistedConfig: VoiceConfig;
	private readonly adapter: VoiceOverlayPropsAdapter;
	private readonly overlay: OverlayView;
	private readonly tui: VoiceSessionConfig["tui"];
	private readonly deps: VoiceSessionDeps;
	private readonly done: (result: VoiceResult) => void;
	private readonly statusBar: StatusBarView;

	readonly component: VoiceSessionComponent;

	constructor(config: VoiceSessionConfig) {
		this.tui = config.tui;
		this.deps = config.deps;
		this.done = config.done;
		this.persistedConfig = config.persistedConfig;
		this.state = initialVoiceState(draftFromConfig(config.persistedConfig));

		const transcript = new TranscriptView(config.theme);
		const divider = new AccentDivider(config.theme);
		const equalizer = new EqualizerView(config.theme);
		const statusBar = new StatusBarView(config.theme);
		this.statusBar = statusBar;
		const micField = new SettingsFieldView(config.theme);
		const languageField = new SettingsFieldView(config.theme);
		const hallucinationField = new SettingsFieldView(config.theme);
		const equalizerField = new SettingsFieldView(config.theme);
		const settingsForm = new SettingsFormView({
			fields: [micField, languageField, hallucinationField, equalizerField],
		});

		const dictation = new DictationScreenStrategy({ transcript, divider, equalizer, statusBar });
		const settings = new SettingsScreenStrategy({ settingsForm, divider, equalizer, statusBar });
		this.overlay = new OverlayView({
			tui: config.tui,
			dictation,
			settings,
		});

		// Predicates are intentionally absent: OverlayView pre-renders the inactive
		// strategy on every tick to compute the height-pad target, so every
		// component must hold fresh props regardless of which screen is visible.
		const bindings = [
			globalBinding({ component: statusBar, select: selectStatusBarProps }),
			globalBinding({ component: transcript, select: selectTranscriptProps }),
			globalBinding({ component: equalizer, select: selectEqualizerProps }),
			globalBinding({ component: micField, select: selectMicReadonlyFieldProps }),
			globalBinding({ component: languageField, select: selectLanguageReadonlyFieldProps }),
			globalBinding({ component: hallucinationField, select: selectHallucinationFilterFieldProps }),
			globalBinding({ component: equalizerField, select: selectEqualizerFieldProps }),
			globalBinding({ component: this.overlay, select: (state) => ({ state }) }),
		];

		this.adapter = new VoiceOverlayPropsAdapter({ tui: config.tui, bindings });

		this.component = {
			render: (w) => this.overlay.render(w),
			invalidate: () => this.adapter.invalidate(),
			handleInput: (data) => this.dispatch(data),
		};

		this.adapter.apply(this.state);
	}

	dispatchAction(action: VoiceAction): void {
		this.commit(action);
	}

	tickPulse(): void {
		this.statusBar.tickPulse();
		this.tui.requestRender();
	}

	dispatch(data: string): void {
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") return;
		this.commit(action);
	}

	private commit(action: VoiceAction): void {
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const e of result.effects) this.runEffect(e);
		this.adapter.apply(this.state);
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "request_render":
				this.tui.requestRender();
				return;
			case "paste_to_editor":
				this.deps.pasteToEditor(effect.text);
				return;
			case "notify":
				this.deps.notify(effect.message, effect.level);
				return;
			case "abort_session":
				this.deps.abort();
				return;
			case "stop_mic":
				this.deps.stopMic();
				return;
			case "set_pipeline_paused":
				this.deps.setPipelinePaused(effect.paused);
				return;
			case "set_hallucination_filter":
				this.deps.setHallucinationFilterEnabled(effect.enabled);
				return;
			case "save_config":
				if (saveVoiceConfig(effect.config)) {
					// Success notify only fires if the reducer asked for one (Ctrl-S
					// path); the implicit close_settings save omits the message and
					// stays silent. Conditional fire-on-success keeps the user out
					// of the contradictory "Failed … / Saved" state the review caught.
					if (effect.successMessage) {
						this.deps.notify(effect.successMessage, "info");
					}
				} else {
					this.deps.notify(
						t("notify.settings_save_failed", "Failed to save voice settings — change not persisted"),
						"error",
					);
				}
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	private runtime() {
		return { keybindings: getKeybindings() };
	}

	private applyContext(): ApplyContext {
		return { persistedConfig: this.persistedConfig };
	}
}
