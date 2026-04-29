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
 * Global axis binding: one component, one selector, optionally skippable.
 * Iterated unconditionally in `apply()`; absent components (`submitPicker`/
 * `tabBar` when `!isMulti`) are excluded from the registry at construction.
 *
 * `<P>` is reified at construction; the iteration boundary erases to
 * `unknown` since the codebase has no precedent for heterogeneous-generic
 * arrays. Per-binding closures retain the typed `P` internally.
 */
export interface ComponentBinding<P> {
	readonly component: StatefulView<P>;
	readonly select: (state: QuestionnaireState, ctx: BindingContext) => P;
}

/**
 * Per-tab axis binding: resolver picks the per-tab component instance from
 * the `TabComponents` slot (returning `undefined` when absent — e.g.,
 * `multiSelect` on non-multi tabs). Optional predicate gates the projection
 * (e.g., `optionList` and `preview` only fire on `i === paneIndex`).
 *
 * Iteration calls `resolve(tab)?.setProps(select(state, ctx))` so missing
 * components silently skip without an explicit guard at the call site.
 */
export interface PerTabBinding<P> {
	readonly resolve: (tab: TabComponents) => StatefulView<P> | undefined;
	readonly select: (state: QuestionnaireState, ctx: PerTabBindingContext) => P;
	readonly predicate?: (state: QuestionnaireState, ctx: PerTabBindingContext) => boolean;
}
