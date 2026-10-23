import type { ActiveView } from "../../view/stateful-view.ts";
import type { ScreenKind, VoiceState } from "../state.ts";

export interface BindingContext {
	readonly activeView: ActiveView;
}

export interface PerScreenBindingContext extends BindingContext {
	readonly kind: ScreenKind;
}

export type GlobalSelector<P> = (state: VoiceState, ctx: BindingContext) => P;
export type PerScreenSelector<P> = (state: VoiceState, ctx: PerScreenBindingContext) => P;
