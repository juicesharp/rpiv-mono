# rpiv-ask-user-question / state / selectors

## Responsibility
Pure, mode-agnostic projections over `QuestionnaireState` + a per-tick `BindingContext`, computing view-ready props and small derived values. No dispatch, no IO — read-only fan-out from the canonical state shape into component-shaped DTOs.

## Boundary Contract
All exports are pure. Projection selectors are `(state, ctx) => P` (`GlobalSelector`/`PerTabSelector` in `contract.ts`); the derivation helpers and `selectActiveView` instead take only the narrow fields they need (e.g. `selectActiveView(state, totalQuestions)`, `selectConfirmedIndicator(questions, currentTab, answers, items)`). No mutation of inputs, no closures over module-level mutable cells, no Pi imports. The only non-state lookup is `displayLabel(...)` from `../i18n-bridge` (locale boundary).

## Module Structure
```
contract.ts     — Type-only: BindingContext, PerTabBindingContext, GlobalSelector<P>, PerTabSelector<P>
focus.ts        — Single discriminant: selectActiveView
derivations.ts  — Small reusable computations: computeFocusedOptionHasPreview,
                   selectConfirmedIndicator, selectActivePreviewPaneIndex
projections.ts  — Per-component prop selectors: selectMultiSelectProps, selectOptionListProps,
                   selectSubmitPickerProps, selectPreviewPaneProps, selectTabBarProps, selectDialogProps
```

## BindingContext Shape
```ts
interface BindingContext {
    questions: ReadonlyArray<QuestionData>;
    itemsByTab: ReadonlyArray<ReadonlyArray<WrappingSelectItem>>;
    totalQuestions: number;
    activeView: ActiveView;
    inputBuffer: string;          // live read from inlineInput.getValue() at apply()
    inputCursorOffset: number | undefined;
    activePreviewPane: StatefulView<PreviewPaneProps>;
}
interface PerTabBindingContext extends BindingContext { tab: TabComponents; i: number; }
```

## Active-View Discriminant
```ts
export function selectActiveView(
    state: { notesVisible: boolean; currentTab: number },
    totalQuestions: number,
): ActiveView {
    if (state.notesVisible) return "notes";
    if (state.currentTab === totalQuestions) return "submit";
    return "options";
}
```
Priority: notes > submit > options; `ActiveView` is `"notes" | "options" | "submit"` (`view/stateful-view.ts:24`). Replaces parallel boolean focus flags scattered through the reducer/view.

## Per-Component Selector
```ts
export const selectOptionListProps: PerTabSelector<OptionListViewProps> = (state, ctx) => {
    const items = ctx.itemsByTab[ctx.i] ?? [];
    const focused = ctx.activeView === "options";
    const confirmed = selectConfirmedIndicator(ctx.questions, state.currentTab, state.answers, items);
    return {
        selectedIndex: state.optionIndex, focused, inputBuffer: ctx.inputBuffer,
        inputCursorOffset: ctx.inputCursorOffset,
        ...(confirmed ? { confirmed } : {}),
    };
};
```

## Derivation Example
```ts
export function selectActivePreviewPaneIndex(currentTab: number, totalQuestions: number): number {
    // Submit tab (currentTab === questions.length) reuses the last question's pane purely for layout.
    if (totalQuestions <= 0) return 0;
    return Math.min(currentTab, totalQuestions - 1);
}
```

## Free-Text `other` Row
- `selectMultiSelectProps` projects an `other` sub-object `{ active, inputMode, inputBuffer, inputCursorOffset }` — the `other` row occupies `optionIndex === options.length`, shifting the Next sentinel to `options.length + 1` (`projections.ts:34-35`)
- `selectPreviewPaneProps` forwards `inputMode: state.inputMode` (`projections.ts:78`) so the Type-something row stays live in single-select preview-pane mode
- `selectConfirmedIndicator` handles only `option`/`custom` prior-answer kinds — `custom` maps back to the `other` row with `labelOverride: prior.answer` (`derivations.ts:37-41`)

## Conventions
- Naming: `select<X>Props` for view-shaped projections; `select<X>` / `compute<X>` for scalar/object derivations
- Projection selectors take `state` first, `ctx` second; derivation helpers take narrow explicit parameters (often ctx-derived `questions` first) — all inputs treated as `readonly`
- Defensive guards (`?? []`, length checks, kind narrowing) over throws — keeps selectors safe for every tab index including the Submit clamp

## Why a Separate Layer
The reducer's contract is `(state, action, ctx) => { state, effects }` — it advances the machine. View props are recomputed on every render tick from the same canonical state, including renders triggered by resize/theme/parent re-mount where no action fired. Inlining projection logic in the reducer would couple prop shape to dispatch — selectors must rebuild without dispatch. Keeping them pure also lets `QuestionnairePropsAdapter.apply(state)` run from outside the folder without leaking `QuestionnaireRuntime` (keybindings, input buffer) into view setProps consumers.
