# rpiv-ask-user-question / view

## Responsibility
Orchestration shell above leaf widgets: composes pi-tui primitives into a height-stable dialog chrome, defines the `StatefulView<P>` contract every component honours, and fans canonical `QuestionnaireState` out to leaf `setProps` via two binding registries. Never touches reducer or input handling.

## Dependencies
- **`@earendil-works/pi-tui`**: `Component`, `Container`, `Editor`, `Spacer`, `Text`, `truncateToWidth`
- **`@earendil-works/pi-coding-agent`**: `Theme`, `DynamicBorder`
- **`../state/selectors/{contract,derivations,focus}.js`**: read-only selectors and types
- **`../state/state.js`**, **`../state/i18n-bridge.js`**, **`../tool/{types,format-answer}.js`**

## Module Structure
```
stateful-view.ts          — StatefulView<P> interface + ActiveView discriminant
component-binding.ts      — globalBinding / perTabBinding factories → BoundGlobalBinding / BoundPerTabBinding
props-adapter.ts          — QuestionnairePropsAdapter (fan-out + invalidate())
tab-components.ts         — TabComponents per-tab bundle record (incl. the `bodyHeights(width) → {current, max}` thunk feeding the dialog's height closures)
tab-content-strategy.ts   — TabContentStrategy + QuestionTabStrategy / SubmitTabStrategy + OneLineClippedText
dialog-builder.ts         — DialogView class + DialogProps/DialogConfig; re-exports the dialog copy by name.
                            Residual height-equalizer computed inline as `spacerRows` in `render()`.
dialog-copy.ts            — Hint / heading / Submit-tab copy constants. A leaf: imports nothing from `view/`,
                            so `dialog-builder` ↔ `tab-content-strategy` never form a runtime cycle (#208).
components/               — Leaf renderers (see .rpiv/guidance/packages/rpiv-ask-user-question/view/components/architecture.md)
```

## StatefulView<P> Contract
```ts
export interface StatefulView<P> extends Component {
    setProps(props: P): void;
}
```
Extends pi-tui `Component` (`render`, `handleInput`, `invalidate`); adds a single `setProps(P)` writer. `focused: boolean` lives on `P` where needed, derived by one equality check against the three-cell `ActiveView` focus discriminant — `"notes" | "options" | "submit"`, priority notes > submit > options, matching the `key-router.ts` dispatcher cascade.

## Binding Registry Entries
```ts
const globalBindings = [
    globalBinding({ component: dialog,       select: selectDialogProps }),
    globalBinding({ component: submitPicker, select: selectSubmitPickerProps }),
    globalBinding({ component: tabBar,       select: selectTabBarProps }),
];
const perTabBindings = [
    perTabBinding({ resolve: t => t.optionList,  predicate: isActiveTab, select: selectOptionListProps }),
    perTabBinding({ resolve: t => t.preview,     predicate: isActiveTab, select: selectPreviewPaneProps }),
    perTabBinding({ resolve: t => t.multiSelect, select: selectMultiSelectProps }),
];
```
- `globalBinding` covers cross-tab components (dialog, optional submit picker, optional tab bar — the two optionals are conditionally spread in)
- `perTabBinding` resolves the target via `resolve(tab)` with optional chaining (absent panes silently skip); `predicate(state, ctx)` short-circuits when false

## PropsAdapter Fan-Out
```ts
apply(state) {
    const ctx = { activeView, activePreviewPane, inputBuffer: this.inlineInput.getText(), inputCursorOffset, ... };
    for (const b of this.globalBindings) b.apply(state, ctx);
    for (let i = 0; i < this.tabsByIndex.length; i++)
        for (const b of this.perTabBindings) b.apply(state, { ...ctx, tab: this.tabsByIndex[i]!, i });
    this.tui.requestRender();
}
```
`invalidate()` walks the same registries plus per-tab `optionList/preview/multiSelect` plus `extraInvalidatables` (the notes `Editor`, which is not reached by a binding).

## TabContentStrategy (fixed shape)
```ts
class QuestionTabStrategy implements TabContentStrategy {
    readonly footerRowCount = 2;  // Spacer(1) + OneLineClippedText(hint, 1) — MUST equal rendered footerRows.length
    headingRows(state) { /* header badge (single-mode) + question */ }
    bodyComponent(state) { /* multiSelect ?? activePreviewPane */ }
    bodyHeight(w, _s) { return this.config.getCurrentBodyHeight(w); }
    // hint via OneLineClippedText (not Text): the collapse affordance would word-wrap and break footerRowCount=2
    footerRows(state) { return [Spacer, OneLineClippedText(hint)]; }
    // midRows: notes editor while notesVisible; otherwise ONE OneLineClippedText row
    // "Note for this answer: <first line>[ …]" when selectSavedNote finds a note (#197) — clipped so a long or
    // multi-line note never crowds the body; mid rows are subtracted from the body allowance (rowsAroundBody)
}
// SubmitTabStrategy: footerRowCount = 5; pads missing picker with Spacer rows to preserve count; mounts the
// shared notes Editor in midRows for the global note (GLOBAL_NOTES_HEADER) + a committed-note review entry
// gated on !state.notesVisible; per-question review notes use the same `notes.saved_label` as the question tab; the submit hint row adds the global-note key while the editor is closed
```

## DialogView Chrome Order (always)
top `DynamicBorder` → (if `isMulti`) `tabBar` → `Spacer(1)` → strategy `headingRows` → `bodyComponent` → `Spacer(1)` → `midRows` → bottom `DynamicBorder` → `footerRows` → inline residual `spacerRows`. `maxFooterRowCount` cached at construction as `max(questionStrategy.footerRowCount, submitStrategy?.footerRowCount ?? 0)`. The footer hint interpolates the configured `collapseKey` (`DialogConfig.collapseKey`, construction-time config — not canonical state) into `HINT_PART_COLLAPSE_TEMPLATE` via `{key}`/`KEY_PLACEHOLDER` and omits the collapse part when the key is `"off"`; when `state.collapsed`, the session swaps in `COLLAPSED_HINT_TEMPLATE` interpolated the same way.

## Body Row Allowance (#210)
Before building the container, `DialogView.render` computes the rows the body may use — budget minus top chrome, rendered heading rows, the body's trailing spacer + mid rows, and bottom chrome — and hands them to the active tab's preview pane (`allotBodyRows` → `PreviewPane.setRowAllowance`; other tabs cleared). A fitted body never exceeds the allowance, so the dialog's own scroll window (shared math in `scroll-window.ts`) only engages for bodies that do not fit themselves (option lists, multi-select) or when the allowance is below `MIN_SCROLL_ROWS_WITH_PINNED_HEADING`.

## Residual Spacer (inline in `render()`)
```ts
// Emits Math.max(0, ...) blank rows AFTER the footer (no overflow path only).
// restingMidRows = mid rows while the notes editor is CLOSED (the saved-note row, #197) — absorbed so a
// noted tab keeps the cross-tab height when the body leaves slack; the open editor still grows the dialog.
const restingMidRows = state.notesVisible ? 0 : this.rowsAroundBody(strategy, width) - 1;
const spacerRows = Math.max(0,
    this.config.getBodyHeight(width) + this.maxFooterRowCount
    - strategy.bodyHeight(width, state) - strategy.footerRowCount - restingMidRows);
```
Absorbs footer-row-count asymmetry across tabs — total dialog height equals across Question and Submit tabs without inflating natural body height. Computed inline in `DialogView.render` (no separate component); under terminal overflow it is dropped in favour of the 3-region scroll partition. In that partition the heading rows (badge + question, measured in rendered rows) join the fixed top whenever at least `MIN_SCROLL_ROWS_WITH_PINNED_HEADING` (3) body rows remain, so the question never scrolls away; below that the heading scrolls with the body.

## Architectural Boundaries
- **No runtime import cycles** — the package graph is async (top-level `await` in `i18n-bridge.ts`), and esbuild's ESM bundle turns any cycle of value imports into two initializers awaiting each other, so the questionnaire never mounts (#208; jiti masks it). Shared values go in a leaf module (e.g. `dialog-copy.ts`); a type-only import back is fine. `import-graph.test.ts` fails on any cycle and names it
- **Only `PropsAdapter` calls `setProps`** — `DialogView` never writes sibling props; it only reads `liveProps`
- **`DialogView.invalidate()` is a no-op** — cache busts go through the adapter's registry walk
- **NO `string.length` width math** — chrome uses `Spacer(n)` + row-counted residual; body height via `render(w).length` or injected `getBodyHeight`/`getCurrentBodyHeight` thunks
- **Strategy `footerRowCount` is invariant** — Submit pads with `Spacer` to preserve 5 rows
- **Selectors injected via `select:`** keep view free of reducer/state-shape coupling

<important if="you are adding a new view component to the questionnaire dialog">
## Adding a Component
1. Implement leaf in `view/components/<name>-view.ts` as `class Foo implements StatefulView<FooProps>` with `setProps`/`render`/`invalidate`
2. Add a projection in `../state/selectors/projections.ts` (`selectFooProps: GlobalSelector<FooProps>` or `PerTabSelector<FooProps>`)
3. If per-tab: extend `TabComponents` (`tab-components.ts`) with the new field and construct it in the session wiring
4. Register: `globalBinding({ component: foo, select })` or `perTabBinding({ resolve: t => t.foo, predicate?, select })`
5. If it sits in chrome, surface it through `DialogConfig` and place in `DialogView.buildContainerFromStrategy` or a strategy's `heading/mid/footerRows`; update that strategy's `footerRowCount` if total changes
6. If not reached by a registry (raw `Editor` etc.), pass it as `extraInvalidatables` to the adapter
</important>
