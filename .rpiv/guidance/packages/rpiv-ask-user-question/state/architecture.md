# rpiv-ask-user-question/state/

## Responsibility
Pure state machine for the questionnaire dialog. Owns the canonical shape, the key router, the reducer, per-kind metadata, the runtime session, build-time questionnaire construction, and the per-kind selectors. No view code — the view fan-out lives in `../view/` and reads canonical state via `propsAdapter.apply(state)`. Pi imports stop below the reducer core — `state.ts`, `state-reducer.ts`, `row-intent.ts`, and `selectors/` are pi-free.

## Dependencies
- **`../tool/types.ts`** — `QuestionAnswer`, `QuestionData`, `QuestionParams`, `QuestionnaireResult` (canonical I/O)
- **`../view/components/wrapping-select.ts`** — `WrappingSelectItem` (the row-kind union; `RowKind = WrappingSelectItem["kind"]`)
- **`@juicesharp/rpiv-i18n`** — only via `i18n-bridge.ts`
- **`@earendil-works/pi-tui`** — `Key`/`matchesKey` (`key-router.ts`), `Input`/`OverlayHandle`/`getKeybindings` (session + builder); **`@earendil-works/pi-coding-agent`** — `Theme`, `getMarkdownTheme` (builder). The core files above stay pi-free

## Consumers
- **`questionnaire-session.ts`** is the single composer here — owns the state cell, both `Input` cells (`notesInput` + `inlineInput`), and the `OverlayHandle`; entry points are `dispatch(data)`, `toggleCollapsedExternal()` (raw-terminal reopen path), and `setOverlayHandle()`
- **`../view/QuestionnairePropsAdapter`** — reads canonical state via `propsAdapter.apply(state)` from outside the folder
- **`../ask-user-question.ts`** (tool execute): builds `itemsByTab` via `buildItemsForQuestion` (consumes `sentinelsToAppend`), builds the runtime session, awaits its `done` promise, returns the formatted result envelope
- **`../rpc-fallback.ts`** — imports `displayLabel`/`t` from `i18n-bridge.ts` and mirrors `ROW_INTENT_META.other.autoAppendOnMultiSelect` for the RPC native-dialog path

## Module Structure
```
state.ts                   — `QuestionnaireState` (canonical) + `QuestionnaireRuntime` (per-tick context incl. `collapseKey`, never view-bound)
state-reducer.ts           — Pure (state, action, ctx) → { state, Effect[] }. Per-kind HANDLERS dispatch table.
key-router.ts              — Pure: keystroke → `QuestionnaireAction` (closed union). kb.matches dispatch + top-of-`routeKey` `collapseKey` intercept via `matchesKey`.
row-intent.ts              — `ROW_INTENT_META: Record<RowKind, RowIntentMeta>` — single source of truth for per-kind behavior.
build-questionnaire.ts     — Pure factory: components + props adapter. Receives `itemsByTab` via config (built in `../ask-user-question.ts`).
questionnaire-session.ts   — Holds the live state cell + `notesInput`/`inlineInput` + `OverlayHandle`; entries: `dispatch(data)`, `toggleCollapsedExternal()`, `setOverlayHandle()`.
i18n-bridge.ts             — locale-aware string lookup (the only rpiv-i18n consumer in this folder).
selectors/                 — Pure projections (focus discriminant, derivations, per-component prop selectors).
```

## Closed-Effect IO Contract
```typescript
// state/state-reducer.ts — adding an effect requires extending the union AND the runtime's `runEffect` switch (compiler-enforced exhaustive).
export type Effect =
    | { kind: "set_input_buffer"; value: string } | { kind: "clear_input_buffer" }
    | { kind: "set_notes_value"; value: string }  | { kind: "set_notes_focused"; focused: boolean }
    | { kind: "forward_notes_keystroke"; data: string }
    | { kind: "set_overlay_hidden"; hidden: boolean }  // toggle_collapsed → OverlayHandle.setHidden
    | { kind: "done"; result: QuestionnaireResult };
```

## HANDLERS Dispatch Table (compile-time exhaustive)
```typescript
// state/state-reducer.ts — per-kind handlers replace the prior single big switch.
// `Extract<…, { kind: K }>` narrows without `as` casts; the mapped type
// force-fails compile until every variant has a handler — mirrors `Record<RowKind, …>`.
type Handler<K extends QuestionnaireAction["kind"]> =
    (state: QuestionnaireState, action: Extract<QuestionnaireAction, { kind: K }>, ctx: ApplyContext) => ApplyResult;

const HANDLERS: { [K in QuestionnaireAction["kind"]]: Handler<K> } = {
    nav: navHandler, tab_switch: tabSwitchHandler, confirm: confirmHandler,
    toggle: toggleHandler, multi_confirm: multiConfirmHandler, cancel: cancelHandler,
    notes_enter: notesEnterHandler, notes_exit: notesExitHandler,
    notes_forward: notesForwardHandler, submit: submitHandler, submit_nav: submitNavHandler,
    toggle_collapsed: toggleCollapsedHandler, ignore: ignoreHandler,
};
```

## Row-Kind Metadata Discipline
```typescript
// state/row-intent.ts — every behavior-bearing branch READS these flags;
// `Record<RowKind, …>` makes adding a kind compile-fail until META has an entry.
export const ROW_INTENT_META: Record<RowKind, RowIntentMeta> = {
    option: { livesInMainList: true,  numbered: true,  activatesInputMode: false, /* ... */ },
    other:  { livesInMainList: true,  activatesInputMode: true, /* inline-input row */
              autoAppendOnSingleSelect: true, autoAppendOnMultiSelect: true },
    next:   { livesInMainList: true,  numbered: false, blocksMultiToggle: true,
              autoSubmitsInMulti: true, autoAppendOnMultiSelect: true },
};
```

## Architectural Boundaries
- **Reducer is pure** — every per-kind handler returns `{ state, effects }`; no live-component reads, no IO, no throws
- **HANDLERS is the dispatch surface** — adding a `QuestionnaireAction.kind` fails at compile time until a handler exists
- **Effects are a closed union** — adding one requires extending both the type AND `runEffect`
- **`ROW_INTENT_META` is exhaustive over `RowKind`** — single source of truth for per-kind behavior; banned-flags test enforces no boolean drift
- **`QuestionnaireState` is canonical** — runtime context (keybindings, input buffer, item list, `collapseKey`) lives in `QuestionnaireRuntime` and NEVER reaches view setProps consumers
- **Side-band notes** — `notesByTab` keeps unconfirmed notes out of `answers`, so the missing-check stays honest
- **Two dispatch entries, one reducer** — `dispatch(data)` from overlay `handleInput`, plus `toggleCollapsedExternal()` from the raw `ctx.ui.onTerminalInput` listener in `../ask-user-question.ts` (pi-tui delivers no input to a hidden overlay); both funnel through `commit` → `reduce`, so collapse hides the overlay only via the `set_overlay_hidden` effect
- **No chat escape hatch** — the `chat` row kind, `chatFocused`, and `focus_chat`/`focus_options` were removed; Esc is the only way to abandon without answering
- **Multi-select free text is exclusive** — a `custom` answer on a multi-select tab clears `multiSelectChecked` (`confirmHandler`); Space/Enter never toggles the `activatesInputMode` row, and Enter on regular rows toggles — commit is gated on `autoSubmitsInMulti` (the Next row)
- **`i18n-bridge.ts` is the ONLY rpiv-i18n consumer** — keep reducer/router/selectors English-pure

<important if="you are adding a new QuestionnaireAction kind">
## Adding an Action
1. Extend the `QuestionnaireAction` union in `state/key-router.ts`
2. Map the keystroke to it inside `routeKey` (gated by `kb.matches(...)` against a named binding)
3. Add a per-kind `Handler<...>` in `state/state-reducer.ts`
4. Register it in the `HANDLERS` table — TypeScript fails the build until the entry exists
5. If the action emits a new IO concern, extend the `Effect` union AND the runtime's `runEffect` switch in the same change
</important>

<important if="you are adding a new sentinel row kind">
## Adding a Sentinel
1. Add the variant to `WrappingSelectItem["kind"]` in `../view/components/wrapping-select.ts`
2. Add a `ROW_INTENT_META` entry — compile fails until present (`Record<RowKind, …>` exhaustiveness)
3. Set `livesInMainList` + the auto-append flags so `sentinelsToAppend` synthesizes the row — consumed by `buildItemsForQuestion` in `../ask-user-question.ts`
4. Add a branch in `key-router.ts`'s answer builder if the row produces a new answer kind
5. Add a `tool/types.ts` `QuestionAnswer` field if the answer shape diverges
6. Add a serializer branch in the response envelope if the serialized form differs
</important>
