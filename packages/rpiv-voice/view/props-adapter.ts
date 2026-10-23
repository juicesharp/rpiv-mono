import type { BindingContext } from "../state/selectors/contract.ts";
import { selectActiveView } from "../state/selectors/focus.ts";
import type { VoiceState } from "../state/state.ts";
import type { BoundGlobalBinding } from "./component-binding.ts";

export interface VoiceOverlayPropsAdapterConfig {
	tui: { requestRender(): void };
	bindings: ReadonlyArray<BoundGlobalBinding>;
}

export class VoiceOverlayPropsAdapter {
	private readonly tui: VoiceOverlayPropsAdapterConfig["tui"];
	private readonly bindings: ReadonlyArray<BoundGlobalBinding>;

	constructor(config: VoiceOverlayPropsAdapterConfig) {
		this.tui = config.tui;
		this.bindings = config.bindings;
	}

	apply(state: VoiceState): void {
		const ctx: BindingContext = { activeView: selectActiveView(state) };
		for (const b of this.bindings) b.apply(state, ctx);
		this.tui.requestRender();
	}

	invalidate(): void {
		for (const b of this.bindings) b.invalidate();
	}
}
