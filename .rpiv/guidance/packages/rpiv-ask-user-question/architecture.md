# rpiv-ask-user-question

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family. Listed in `siblings.ts`; peer-pinned by `rpiv-pi` as `"*"`. Used by `rpiv-pi` skills for developer checkpoints.

## Responsibility
Single-tool extension exposing `ask_user_question` — a TUI option selector with inline free-text input on every question type. The "Chat about this" escape hatch was removed; Esc is the only way to abandon without answering. Returns a structured questionnaire result.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): theme, markdown, dynamic border
- **`@earendil-works/pi-tui`** (peer): containers, input, key matching, width-correct text helpers
- **`@juicesharp/rpiv-i18n`** (optional peer): live-locale strings via `state/i18n-bridge.ts`; English-fallback shim when absent
- **`@juicesharp/rpiv-config`**: `loadJsonConfigWithLegacyFallback` — honors `XDG_CONFIG_HOME` with a one-way legacy `~/.config` fallback
- **`typebox`**: schema types (regular dependency — was a peer until #79 broke installers that don't materialise peers)

## Module Structure

```
.                       — Pi entry + tool registration, `config.ts` (collapseKey), `events.ts` ("./events" export), `rpc-fallback.ts` (RPC dialog walker), `reconcile.ts` (tool visibility)
tool/                   — Tool I/O surface: TypeBox schemas, params validator, result envelope, formatter.
                          Detailed: `.rpiv/guidance/packages/rpiv-ask-user-question/tool/architecture.md`
state/                  — Canonical state, pure reducer, key router, runtime session, row-intent metadata,
                          i18n-bridge. Detailed: `.rpiv/guidance/packages/rpiv-ask-user-question/state/architecture.md`
state/selectors/        — Pure projections: focus discriminant, derivations, per-component prop selectors.
                          Detailed: `.rpiv/guidance/packages/rpiv-ask-user-question/state/selectors/architecture.md`
view/                   — Chrome (DialogView), props adapter, binding registries, StatefulView<P> contract.
                          Detailed: `.rpiv/guidance/packages/rpiv-ask-user-question/view/architecture.md`
view/components/        — Per-component StatefulView renderers + the WrappingSelect primitive.
                          Detailed: `.rpiv/guidance/packages/rpiv-ask-user-question/view/components/architecture.md`
view/components/preview/ — PreviewPane facade + private helpers (renderers, layout, cache).
                          Detailed: `.rpiv/guidance/packages/rpiv-ask-user-question/view/components/preview/architecture.md`
locales/                — JSON translation maps loaded via i18n-bridge at module init.
```

## Row Kinds (`WrappingSelectItem`)

`{ kind: "option" | "other" | "next", label, description? }`. Sentinels (`other`, `next`) are protocol-driven; `option` is author-defined. Renderer, dispatcher, validator, and serializer all branch on `kind` uniformly — no subclassing, no per-kind boolean flags. `other` is the inline free-text row appended to every question type — `ROW_INTENT_META.other` sets both `autoAppendOnSingleSelect` (regardless of previews) and `autoAppendOnMultiSelect`; `next` commits multi-select. The component contract is `StatefulView<P> { setProps(p), invalidate() }`; the owning container is the single source of truth for focus and keystroke routing.

## Row-Intent Metadata (`ROW_INTENT_META`)

`Record<RowKind, RowIntentMeta>` is the single source of truth for per-kind behavior. Every behavior-bearing branch (auto-append, reserved-label validation, input-mode activation, multi-select toggle/submit gating, numbering offset) reads flags from this table — none duplicate the rule. `Record<RowKind, …>` makes the table compile-time exhaustive: adding a kind to the union force-fails until META has an entry.

## State Machine

`QuestionnaireState` is the single canonical shape — both the dispatcher and the view layer read it. The session owns the state cell and the input-buffer cell. `dispatch(data)` is the single entry: routes through `routeKey` (pure) → `reduce` (pure, returns `{state, Effect[]}`) → runtime executes effects → `propsAdapter.apply(state)` fans out to components. The reducer never touches a live component; per-`QuestionnaireAction` kind is dispatched via a `{ [K in Kind]: Handler<K> }` HANDLERS table (compile-time exhaustive); every IO is an `Effect` in a closed union (compiler-enforced exhaustive switch in `runEffect`).

## View Fan-Out

`QuestionnairePropsAdapter` drives every component setter from canonical state via two binding registries: `globalBindings` covers cross-tab components (dialog, optional submit picker, optional tab bar); `perTabBindings` covers per-tab kinds (option list, preview, optional multi-select). Each binding is `{ component | resolve, select }` — a pure selector returning props plus the target's `setProps`. Fan-out collapses to one global loop + one nested per-tab loop. The adapter also holds the headless shared `inlineInput`; its value/cursor are read per tick into the binding context so `selectOptionListProps` sees the live value. No component reaches into siblings; no lazy `setState` scattered through builders.

## Chrome-Mirror Layout

`DialogView` lays out chrome from a tab strategy: border, optional tab bar, heading, body, mid rows, footer, residual spacer. The body residual spacer enforces total-height equality across tabs by absorbing `(global − strategy)` rows — footer-row-count asymmetry is structural, not arithmetic.

## Preview Pane

`PreviewPane` is a thin composer over a per-question width-keyed markdown cache, a pure layout decider (side-by-side vs stacked + column widths), a pure bordered-box renderer, and the options selector. Layout mode is decided once and threaded through height + render — no width-derived re-derivation.

## Collapse Mode

The shortcut is configurable via the `collapseKey` config field (default `ctrl+]`; `"off"` disables; malformed specs fall back to the default). It dispatches `toggle_collapsed` (intercepted at the top of `routeKey`, works from every inner state) → flips `state.collapsed` and emits a `set_overlay_hidden` effect, which the session routes to `OverlayHandle.setHidden` — the overlay is fully hidden (chat scrolling and editor focus resume; Esc does not cancel while hidden). Because pi-tui delivers no input to a hidden overlay, `execute()` registers a raw terminal listener for the same key to re-expand — it defers when another overlay is focused. Source: `state/state.ts:35`, `state/key-router.ts:26-27,145-155`, `state/state-reducer.ts:256-258`, `state/questionnaire-session.ts:162-165`, `ask-user-question.ts:195-212`.

## Execution Modes & Load Resilience

`execute()` forks at the root: `ctx.mode === "rpc"` + `hasDialogUI` (VS Code pendant, Zed) routes to `runRpcQuestionnaire` (`rpc-fallback.ts`) — a sequential native select/input dialog walker feeding the same `buildQuestionnaireResponse` envelope (no preview pane, no tabs; free-text preserved on both variants). Non-interactive runs never see the tool: `reconcile.ts` (`registerAskUserQuestionReconciler`, wired in `index.ts`) strips/restores it from the active set against `ctx.hasUI`; the in-handler `ERROR_NO_UI` guard (`ask-user-question.ts:43,143`) remains as a backstop telling the model to re-ask in chat. The heavy view graph loads lazily via `loadQuestionnaireSession`, which guards jiti's poisoned graph cache (a failed load is cached unrecoverably; both failure shapes return an envelope naming the restart remedy — #107). `rpc-fallback` is deliberately statically imported: it pulls only types + the i18n bridge.

## Architectural Boundaries

- **NO width math via `string.length`** — always use width-correct helpers (`visibleWidth`, `wrapTextWithAnsi`)
- **NO inline user-facing strings in execute** — every token is a module-level const or sourced from `ROW_INTENT_META`
- **NO subclassing or per-kind boolean flags for special rows** — `kind` discriminator + `ROW_INTENT_META` are the single mechanism (enforced by a banned-flags test)
- **NO live-component reads from the reducer** — dispatch-time component values arrive via `ApplyContext`
- **Tool-result envelope** always built via the result-envelope helper; the questionnaire error type unifies validator and runtime
- **Side-band notes** — pre-answer notes live separately from `answers` so they don't make a question read as "answered"; merged at confirm
- **Partial-submit allowed** — Submit always submits; the warning header is the sole signal of incompleteness
- **State-shape unity** — `QuestionnaireState` is the single canonical shape; runtime context is held separately and never reaches view setProps consumers
- **Effects as a closed union** — adding an effect requires updating both the `Effect` union AND the runtime's switch (compiler-enforced)
- **Discriminated focus** — `selectActiveView` returns one of `"notes" | "options" | "submit"` from canonical state; replaces parallel boolean focus flags
- **Right/Left tab aliases** — both Tab/Shift+Tab and arrow keys map to the same `tab_switch` action

<important if="you are adding a new question type (e.g., new sentinel row)">
## Adding a Sentinel Row

1. Add the variant to the `WrappingSelectItem["kind"]` union
2. Add a `ROW_INTENT_META` entry — compile fails until present (exhaustive `Record<RowKind, …>`)
3. Set the append predicate flag(s) so the sentinel synthesizer emits the row — every current sentinel lives in the main list (`livesInMainList`)
4. Add a branch in the dispatcher's answer builder if the row produces an answer
5. Add a serializer branch if the answer's serialized form differs
6. Add a matching optional field to `QuestionAnswer` if the answer kind is new
</important>

<important if="you are customizing the selector UI">
## Customizing the Selector

- **Theme**: pass a different theme; route through `theme.fg`/`theme.bold` — never hardcode ANSI
- **Glyphs**: `private static readonly` constants on the relevant component
- **Dialog layout**: extend the tab strategy and declare `footerRowCount` accurately; the chrome wrapper enforces height equality
- **Keys**: add a keybinding constant in the dispatcher and dispatch via `kb.matches`. Free-text rows MUST guard against control sequences before forwarding to input
- **New component**: implement `StatefulView<P>`, register a `globalBinding` or `perTabBinding` with a pure selector — never call `setProps` from outside the adapter
</important>
