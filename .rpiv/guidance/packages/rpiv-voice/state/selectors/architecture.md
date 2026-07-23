# rpiv-voice / state / selectors

## Responsibility
Pure projections from `VoiceState` to per-component view-prop shapes. Where the reducer owns state transitions, selectors own state→view shape mapping and are the only place i18n / display formatting is resolved per render tick.

## Dependencies
- **`../state.js`** (`VoiceState`, `ScreenKind`)
- **`../../view/stateful-view.js`** (`ActiveView` — type-only)
- **`../../view/components/*`** (type-only prop shapes: `StatusBarViewProps`, `TranscriptViewProps`, `EqualizerViewProps`, `SettingsFieldViewProps`)
- **`../i18n-bridge.js`** (`t`, `getActiveLocale`)
- **`../screen-intent.js`** (`SCREEN_META`, `FooterHintKey`)

## Boundary Contract
- Inputs: `(state: VoiceState, ctx: BindingContext)` — read-only
- Outputs: typed `*ViewProps` from `../../view/components/*` or a discriminant string union
- No IO, no mutation, no command-layer imports. Cross-layer constants get **duplicated**, not imported (e.g. `LANGUAGE_DISPLAY_BY_CODE` in `projections.ts` mirrors the code list of `WHISPER_SUPPORTED_LANGUAGES` from `voice-command.ts`; the endonym display map itself exists only here — selectors stay leaf-level)
- Only side-channel reads: `getActiveLocale`, `t` from `../i18n-bridge` (resolved at projection time so locale flips propagate without rebuilding views)

## Module Structure
```
contract.ts       — Types only: BindingContext, PerScreenBindingContext, GlobalSelector<P>, PerScreenSelector<P>
focus.ts          — Active-view discriminant: selectActiveView(state) → "dictation" | "settings"
derivations.ts    — Pure helpers not tied to a component (e.g. clipToTerminalHeight with MIN_RENDER_ROWS, MAX_HEIGHT_RATIO)
projections.ts    — Per-component selectStatusBarProps / selectTranscriptProps / selectEqualizerProps / select{HallucinationFilter,Equalizer,MicReadonly,LanguageReadonly}FieldProps + local hintLabel resolver over FooterHintKey
```

## Active-View Discriminant
```ts
export function selectActiveView(state: VoiceState): ActiveView {
    return state.currentScreen === "settings" ? "settings" : "dictation";
}
```
Maps `currentScreen` (`ScreenKind` — itself exactly `"dictation" | "settings"`) onto the view layer's identical `ActiveView` union — a layer-boundary type translation, not a narrowing.

## Per-Component Selector Pattern
```ts
export const selectTranscriptProps: GlobalSelector<TranscriptViewProps> = (state, _ctx) => ({
    text: state.transcript,
    partial: state.partialTranscript,
    placeholder: t("transcript.placeholder", "Listening..."),  // i18n resolved at projection time
});
```
- Arrow constant typed via `GlobalSelector<P>` / `PerScreenSelector<P>` — never inline parameter types
- Destructures only what it needs from `state`; ignores `ctx` when global
- Return type is the view component's exported `*ViewProps`

## Memoization
**None.** Selectors allocate fresh objects every call (e.g., `selectStatusBarProps` builds a new `hints` array). No `reselect`/memo wrapper — projections are cheap, called per frame. Stable layout is achieved by design: `hint` stays present regardless of focus so the settings body height doesn't jitter — the field hides its own hint when inactive (see the comment at `projections.ts:75-78`; `active` itself does track `settingsFocus`).

## Consumption
`BindingContext` (in `contract.ts`) references `ActiveView` from `../../view/stateful-view.js` — the binding registry lives in `view/`. `VoiceOverlayPropsAdapter.apply()` (`view/props-adapter.ts:21`) builds `{ activeView: selectActiveView(state) }` and passes it into each binding per render tick; all eight registered bindings are `globalBinding(...)` (`state/voice-session.ts:95-102`), so `kind` is never supplied — `PerScreenSelector`/`PerScreenBindingContext` are currently unconsumed types. Screen-tree choice does not go through `selectActiveView`: `OverlayView.render` reads `state.currentScreen === "settings"` directly (`view/overlay-view.ts:66`); the props adapter is `selectActiveView`'s sole consumer.

## Conventions
- Naming: `select<Component>Props` for component projections; settings rows use `select<Field>FieldProps` (e.g. `selectHallucinationFilterFieldProps`, `selectMicReadonlyFieldProps`) — there is no `selectSettings*Props`; `select<Concept>` for discriminants (`selectActiveView`)
- Type aliases (`GlobalSelector<P>`, `PerScreenSelector<P>`) — never inline `(state, ctx)` signatures
- Reads confined to `state` and `ctx`; the only external reads allowed are the i18n bridge (`t`, `getActiveLocale`)
- Cross-layer constants get duplicated, not imported, to keep selectors leaf-level
