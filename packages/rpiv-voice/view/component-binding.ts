import type { BindingContext, GlobalSelector } from "../state/selectors/contract.ts";
import type { VoiceState } from "../state/state.ts";
import type { StatefulView } from "./stateful-view.ts";

export interface ComponentBinding<P> {
	readonly component: StatefulView<P>;
	readonly select: GlobalSelector<P>;
	readonly predicate?: (state: VoiceState, ctx: BindingContext) => boolean;
}

export interface BoundGlobalBinding {
	apply(state: VoiceState, ctx: BindingContext): void;
	invalidate(): void;
}

export function globalBinding<P>(spec: ComponentBinding<P>): BoundGlobalBinding {
	return {
		apply: (state, ctx) => {
			if (spec.predicate && !spec.predicate(state, ctx)) return;
			spec.component.setProps(spec.select(state, ctx));
		},
		invalidate: () => spec.component.invalidate(),
	};
}
