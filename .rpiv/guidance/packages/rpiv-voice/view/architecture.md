# rpiv-voice / view

## Responsibility
Orchestration above leaf components: composes per-screen child layouts, swaps between dictation/settings while preserving chrome position, and fans canonical `VoiceState` out to leaf `StatefulView`s via bindings — mirrors AUQ's view/ split. Components below this layer never read state directly.

## Dependencies
- **`@earendil-works/pi-tui`**: `Component`, `Container` primitives
- **`../state/state.js`**: `VoiceState` shape
- **`../state/selectors/{contract,focus,derivations}.js`**: `BindingContext`, `GlobalSelector`, `selectActiveView`, `clipToTerminalHeight`
- No `audio/` reach-in; view stays state-only

## Module Structure
```
stateful-view.ts            — StatefulView<P> interface + ActiveView union
component-binding.ts        — ComponentBinding<P> spec + globalBinding() factory producing BoundGlobalBinding
props-adapter.ts            — VoiceOverlayPropsAdapter: iterates bindings, calls component.setProps, then tui.requestRender()
screen-content-strategy.ts  — DictationScreenStrategy / SettingsScreenStrategy: each returns ordered Component[]
overlay-view.ts             — Top-level StatefulView; renders both strategies, height-equalizes bodies, clips to terminal height
components/                  — Leaf renderers (see .rpiv/guidance/packages/rpiv-voice/view/components/architecture.md)
```

## StatefulView<P> Contract
```ts
export interface StatefulView<P> extends Component {
    setProps(props: P): void;
}
```
Extends pi-tui `Component` (`render`, `handleInput`, `invalidate`); adds a single `setProps(P)` writer. Mirrors AUQ's pattern — `focused` lives on `P` only where needed.

## Binding Entry Shape
```ts
export interface ComponentBinding<P> {
    readonly component: StatefulView<P>;
    readonly select: GlobalSelector<P>;
    readonly predicate?: (state: VoiceState, ctx: BindingContext) => boolean;  // gate visibility/application
}
```
Global bindings only — no per-screen registry. Visibility is controlled by an optional `predicate(state, ctx)` which short-circuits `apply` when false.

## PropsAdapter Fan-Out
```ts
apply(state: VoiceState): void {
    const ctx: BindingContext = { activeView: selectActiveView(state) };
    for (const b of this.bindings) b.apply(state, ctx);  // each calls component.setProps(select(state, ctx))
    this.tui.requestRender();                            // exactly one redraw per state update
}
```
Bindings are the single registry; fan-out is one-to-many; canonical state crosses into components only through this path.

## Screen Content Strategy (analogous to AUQ tab-content-strategy)
Strategy keyed by `kind: "dictation" | "settings"`. Each strategy returns the ordered child list `[body, divider, equalizer, statusBar]` for the overlay container. The bottom chrome (divider + equalizer + statusBar) is **shared** across strategies so it stays pinned across screen flips.

## Overlay Chrome Layout (`overlay-view.ts`)
- Body region varies by screen; bottom chrome row count = 9 with equalizer enabled, 2 without
- Tracks `targetBodyHeight` as a **high-water mark across both strategies**, top-pads the active strategy with empty rows so chrome never jumps on screen flip
- Top-clips to terminal height via `clipToTerminalHeight` (`MIN_RENDER_ROWS = 4`, `MAX_HEIGHT_RATIO = 0.85`)
- Uses pi-tui `Container` for vertical stacking; horizontal composition is delegated to components themselves

```ts
private renderStrategy(strategy: ScreenContentStrategy, width: number): string[] {
    const container = new Container();
    for (const child of strategy.children()) container.addChild(child);
    return container.render(width);
}
```

## Architectural Boundaries
- **NO `setProps` outside `VoiceOverlayPropsAdapter.apply()`** — bindings are the only ingress to component props
- **Components never read state directly** — they only receive props through `setProps`
- **Selectors live in `state/selectors/`** and produce typed props; components stay dumb renderers
- **`requestRender()` invoked exactly once** per state update, after all bindings apply
- **Strategies are pure factories** of `Component[]` — they hold no state and own no inputs
- **Height equalization is overlay-owned**, not component-owned — leaves don't know about cross-screen layout
- **`predicate` gates props per binding**; absence of a predicate means always-on

<important if="you are adding a new view component to the voice overlay">
## Adding a Component
1. Implement the leaf in `view/components/<name>-view.ts` with `class Foo implements StatefulView<FooProps>` — `setProps`/`render(w)`; `handleInput`/`invalidate` can be no-ops
2. Add a projection in `state/selectors/projections.ts` (`selectFooProps: GlobalSelector<FooProps>`)
3. Register a `globalBinding({ component: foo, select: selectFooProps, predicate? })` in the screen wiring
4. If the component lives in a specific screen, add it to that strategy's `children()` array in `screen-content-strategy.ts`
5. If footer-hint capacity changes, update `SCREEN_META.footerHints` in `state/screen-intent.ts`
</important>
