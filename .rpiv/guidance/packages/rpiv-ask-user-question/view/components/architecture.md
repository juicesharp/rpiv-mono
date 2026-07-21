# rpiv-ask-user-question/view/components/

## Responsibility
TUI component library for the questionnaire dialog. Each file is a `StatefulView<P>` renderer driven exclusively by `setProps(p)` from outside; rendering is pure of canonical state (the props adapter in `../props-adapter.ts` is the only writer). The `WrappingSelect` primitive underlies `OptionListView` only; `MultiSelectView` renders its own rows and shares just the `renderInlineInputRow` core from `inline-input.ts`. The free-text `Type something.` row appears on every question type — single-select (including preview mode) and multi-select. `PreviewPane` (under `preview/`) is the side-by-side / stacked preview composer.

## Dependencies
- **`@earendil-works/pi-tui`** (peer): `Component`, `CURSOR_MARKER`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi` (width-correct text helpers — never `string.length`)
- **`@earendil-works/pi-coding-agent`** (peer): `Theme` type — injected styling in `multi-select-view.ts`, `submit-picker.ts`, `tab-bar.ts`, and preview renderers
- **`../../state/i18n-bridge.ts`** — `displayLabel` for the localized sentinel labels (`other` → "Type something.", `next`) in `multi-select-view.ts`; `t()` for the submit/cancel row labels in `submit-picker.ts`
- **`../../tool/types.ts`** — `QuestionData` (`multi-select-view.ts`, `preview/preview-pane.ts`)
- **NO state reducer imports** — components emit nothing; they only render props

## Consumers
- **`../props-adapter.ts`**: registers each component in `globalBindings` or `perTabBindings` and pushes `setProps(p)` from canonical state
- **`../dialog-builder.ts`**: composes the dialog chrome and mounts the per-tab body component
- **`../../state/questionnaire-session.ts`**: routes keystrokes via `routeKey()` (the `kb.matches(...)` table lives in `state/key-router.ts`); components NEVER read keystrokes

## Module Structure
```
wrapping-select.ts        — Core primitive: row list with active pointer, numbering, ✔ confirmed mark, inline-input
                            row for `kind: "other"`. Owns the `WrappingSelectItem` discriminator (option | other | next).
inline-input.ts           — Shared `renderInlineInputRow` core: reverse-video cursor cell; wrap vs one-line modes.
option-list-view.ts       — Per-tab options renderer (composes WrappingSelect); owns `MAX_VISIBLE_OPTIONS`.
multi-select-view.ts      — Multi-select variant: checkbox glyphs, never-checkable `Type something.` row (single-line
                            inline input), `next` row. Renders rows directly — no WrappingSelect.
submit-picker.ts          — Submit-tab picker (rows: SUBMIT_LABEL "Submit answers" | CANCEL_LABEL "Cancel").
tab-bar.ts                — Optional tab strip when ≥2 questions; pure styling (`handleInput` empty). The
                            left/right→`tab_switch` aliasing lives in `key-router.ts` (`tabSwitchAction`), not here.
preview/                  — PreviewPane facade + private renderers/layout/cache (side-by-side vs stacked).
```

## StatefulView Contract (one file per component)
```typescript
// view/stateful-view.ts — extends pi-tui Component (render, handleInput, invalidate).
// Owning container (DialogView) is the single source of truth for focus + keystrokes.
interface StatefulView<P> extends Component {
    setProps(props: P): void; // pure: adapter selects props from canonical state, pushes here
}
```

## Row-Kind Branching
```typescript
// view/components/wrapping-select.ts — the inline-input branch is the only place
// where `kind === "other"` is special-cased at render time. All other row behavior
// (auto-append, multi toggle gating, numbering) comes from the `ROW_INTENT_META`
// table in `state/row-intent.ts`, consumed on the state side (state-reducer.ts,
// key-router.ts, i18n-bridge.ts) — components never duplicate the rule.
private shouldRenderAsInlineInput(item: WrappingSelectItem, isActive: boolean): boolean {
    return item.kind === "other" && isActive;
}

// Confirmed-row treatment is uniform across kinds — pointer (❯) + selectedText
// styling come from focus, ✔ + label-override come from setConfirmedIndex.
const isConfirmed = index === this.confirmedIndex;
const label = isConfirmed
    ? `${this.confirmedLabelOverride ?? item.label}${WrappingSelect.CONFIRMED_MARK}`
    : item.label;
```

## Width-Correct Rendering Discipline
```typescript
// EVERY width math goes through pi-tui helpers — `string.length` is wrong on
// emojis, CJK, and ANSI-escaped strings, all of which appear in the TUI surface.
const continuationPrefix = " ".repeat(visibleWidth(rowPrefix));
const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - visibleWidth(rowPrefix));
const wrapped = wrapTextWithAnsi(label, contentWidth);
lines.push(truncateToWidth(line, width, ""));
```

## Inline-Input Cursor (shared core)
```typescript
// view/components/inline-input.ts — both consumers share one cursor-building core:
// grapheme-aware extraction (Intl.Segmenter) of the cell AT the cursor, ECMA-48
// SGR 7/27 reverse-video, NBSP fallback at end-of-buffer, zero-width CURSOR_MARKER
// so wrap/truncate math is preserved.
// multiline: true  → WrappingSelect (single-select): wrap at contentWidth.
// multiline: false → MultiSelectView: EXACTLY one line — overflow truncates with `…` (see Boundaries).
export function renderInlineInputRow(opts: RenderInlineInputOptions): string[] {
```

## Architectural Boundaries
- **NO width math via `string.length`** — always `visibleWidth` / `wrapTextWithAnsi` / `truncateToWidth`
- **NO keystroke handling inside components** — `handleInput` is intentionally empty (`wrapping-select.ts`); the container routes keys
- **NO setProps from outside the adapter** — bindings are the only `setProps` callers
- **NO ad-hoc raw ANSI** — styling flows through `theme.fg/bold/bg` or injected `WrappingSelectTheme` callbacks; sole exception is the SGR 7/27 reverse-video cursor in `inline-input.ts`
- **Named constants for glyphs** (`❯`, `✔`, `[✔]`) — `private static readonly` (WrappingSelect) or module-level `const` — never inline literals
- **Row-kind discriminator is the only mechanism** — no boolean per-kind flags, no subclassing of WrappingSelect (banned-flags test enforces this)
- **Pointer (❯) follows focus, ✔ follows confirmation** — both can co-occur on the same row when prior answer == active row
- **Multi-select `Type something.` row is always exactly one rendered line** — `renderInlineInputRow` with `multiline: false` truncates on overflow so `MultiSelectView.naturalHeight(width)` stays state-independent

<important if="you are adding a new view component (e.g. a new dialog body)">
## Adding a Component
1. Create `view/components/<name>-view.ts` implementing `StatefulView<P>` — extends pi-tui `Component` (`render`, `handleInput`, `invalidate`) plus `setProps`
2. Define the props interface — selector that produces it lives in `state/selectors/projections.ts`
3. Register the component in `view/props-adapter.ts` — pick `globalBindings` (cross-tab) or `perTabBindings` (per-tab kind); never call `setProps` from outside
4. If the component renders a new sentinel row, add the kind to `WrappingSelectItem["kind"]` AND `ROW_INTENT_META` first — see `state/architecture.md`
5. Width math: import from `@earendil-works/pi-tui` (`visibleWidth`, `wrapTextWithAnsi`, `truncateToWidth`) — never `string.length`
6. Glyphs/labels: `private static readonly` on the class, OR module-level const — never inline string literals
7. Co-locate `<name>-view.test.ts` exercising props → rendered lines (snapshot or string-list assertion)
</important>
