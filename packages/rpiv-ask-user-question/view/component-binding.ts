import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { WrappingSelectItem } from "./components/wrapping-select.js";
import type { ActiveView, StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";

/**
 * Per-tick context shared across all bindings. Built once at the top of
 * `apply()`; threaded into every projector closure unchanged. Carries every
 * free variable today's selectors take beyond `state` itself.
 *
 * `activePreviewPane` is typed as `StatefulView<PreviewPaneProps>` (not the
 * concrete `PreviewPane` class) so the adapter can thread the resolved pane
 * through without `as unknown as` casts; the dialog and tab-content-strategy
 * consume it as a `Component` only.
 */
export interface BindingContext {
	readonly questions: readonly QuestionData[];
	readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	readonly totalQuestions: number;
	readonly activeView: ActiveView;
	readonly inputBuffer: string;
	readonly activePreviewPane: StatefulView<PreviewPaneProps>;
}

/**
 * Per-tab extension of `BindingContext`. The nested per-tab loop builds this
 * once per tab (extending the global ctx with `tab` + `i`) and threads it to
 * every per-tab binding's projector + predicate.
 */
export interface PerTabBindingContext extends BindingContext {
	readonly tab: TabComponents;
	readonly i: number;
}

/**
 * Global axis binding spec: paired component + selector, generic in `<P>`. Used
 * at construction sites only; never lands in the adapter's iteration array.
 * `globalBinding(spec)` erases `<P>` via the closure form below — TS verifies
 * `select(s, ctx) → P` matches `component.setProps(P)` at the call site.
 */
export interface ComponentBinding<P> {
	readonly component: StatefulView<P>;
	readonly select: (state: QuestionnaireState, ctx: BindingContext) => P;
}

/**
 * Per-tab axis binding spec: resolver picks the per-tab component instance
 * from the `TabComponents` slot (returning `undefined` when absent — e.g.,
 * `multiSelect` on non-multi tabs). Optional predicate gates the projection
 * (e.g., `optionList` and `preview` only fire on `i === paneIndex`). Bound
 * via `perTabBinding(spec)` for the same reason as `ComponentBinding`.
 */
export interface PerTabBinding<P> {
	readonly resolve: (tab: TabComponents) => StatefulView<P> | undefined;
	readonly select: (state: QuestionnaireState, ctx: PerTabBindingContext) => P;
	readonly predicate?: (state: QuestionnaireState, ctx: PerTabBindingContext) => boolean;
}

/**
 * Bound global binding consumed by the adapter's iteration. `<P>` is captured
 * inside the closures returned by `globalBinding`; from the array's
 * perspective each entry is just an `apply` + `invalidate` pair, no generic
 * surface.
 */
export interface BoundGlobalBinding {
	apply(state: QuestionnaireState, ctx: BindingContext): void;
	invalidate(): void;
}

/**
 * Bound per-tab binding. Mirrors `BoundGlobalBinding`: the adapter calls
 * `apply(state, perTabCtx)` per tab and the closure handles
 * `predicate → resolve → setProps` internally. Missing per-tab components
 * silently skip.
 */
export interface BoundPerTabBinding {
	apply(state: QuestionnaireState, ctx: PerTabBindingContext): void;
}

/**
 * Existential wrapper for a global binding. Inside this generic helper `<P>`
 * is a free type variable, so TS verifies that `spec.select(...) : P` lines
 * up with `spec.component.setProps(P)` at the call site. Once bound into
 * `BoundGlobalBinding` the array is monomorphic.
 */
export function globalBinding<P>(spec: ComponentBinding<P>): BoundGlobalBinding {
	return {
		apply: (state, ctx) => spec.component.setProps(spec.select(state, ctx)),
		invalidate: () => spec.component.invalidate(),
	};
}

/**
 * Existential wrapper for a per-tab binding. Same trick as `globalBinding`:
 * `<P>` is local to this function, so the predicate, resolver, and selector
 * all check against one `P`. Resolves the component lazily inside `apply` so
 * missing slots (e.g., non-multi `multiSelect`) skip without a guard at the
 * iteration site.
 */
export function perTabBinding<P>(spec: PerTabBinding<P>): BoundPerTabBinding {
	return {
		apply: (state, ctx) => {
			if (spec.predicate && !spec.predicate(state, ctx)) return;
			spec.resolve(ctx.tab)?.setProps(spec.select(state, ctx));
		},
	};
}
