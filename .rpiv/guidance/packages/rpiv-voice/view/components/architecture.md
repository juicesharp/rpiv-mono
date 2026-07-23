# rpiv-voice / view / components

## Responsibility
Leaf renderers implementing `StatefulView<P>` from `../stateful-view.js`. Each owns a small `props` blob set via `setProps`, has no-op `handleInput`/`invalidate`, and returns pre-styled ANSI lines from `render(width)`. No state-store value imports — parents feed already-resolved props.

## Dependencies
- **`@earendil-works/pi-coding-agent`**: `Theme` (color/bold tokens), `DynamicBorder` (splash divider)
- **`@earendil-works/pi-tui`**: `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi` — width-correct primitives that respect SGR sequences
- **Local**: `RecordingStatus` (type-only, from `state/state.ts`), `STATUS_META`, `t` (i18n bridge), `StatefulView`. **No runtime `state.ts` imports** — props are the only data ingress

## Module Structure
```
equalizer-view.ts        — Traveling-wave bar lattice driven by smoothed RMS (visual audio meter)
splash-view.ts           — Pre-mic chrome: divider + spinner + phase label, with download-progress decoration
status-bar-view.ts       — Single-line "glyph timer  hint · hint" chrome with pulsing recording dot
transcript-view.ts       — Rolling committed text + dim partial transcript, wrapped to width
settings-field-view.ts   — One row (pointer + label + value + optional hint) for readonly/toggle fields
settings-form-view.ts    — Thin vertical concatenator over an injected ReadonlyArray<SettingsFieldView>
```

## Idiomatic Component Pattern
```ts
export class TranscriptView implements StatefulView<TranscriptViewProps> {
    private props: TranscriptViewProps = { text: "", partial: "", placeholder: "Listening..." };
    constructor(private readonly theme: Theme) {}
    setProps(p: TranscriptViewProps): void { this.props = p; }
    handleInput(_d: string): void {}                 // no-op: input is routed by VoiceSession
    invalidate(): void {}                            // no-op: host loop calls requestRender(), not components
    render(width: number): string[] {
        // assemble styled string, then wrapTextWithAnsi(src, width) for paragraphs
        // or truncateToWidth(line, width, "…", false) for single-line chrome
    }
}
```
`invalidate()` is a no-op everywhere — these views don't request redraws; the props-adapter does.

## Theme / Glyph Conventions
- Glyphs, color-key names, and separator strings live as **module-level `const`s** (never `private static readonly` class members) so they can be diffed without touching class semantics
- Status glyphs are sourced from `state/status-intent.ts` — the view never invents its own status iconography
- Styling goes through `theme.fg(key, text)` / `theme.bold(text)` so theme variants stay swappable — sole exception is the equalizer's truecolor gradient, which emits raw SGR (see below)

## Equalizer View
Renders a smoothed audio-level visualization that **freezes when not recording** (no phase advance or level smoothing — `setProps` gates both on `status === "recording"`; `render` still rebuilds rows each call, repainted dim). The architectural rules:
- View receives raw RMS via props; smoothing + perceptual scaling live inside the component (not in state)
- Lattice geometry, smoothing coefficients, noise model, and color gradient are **tuning** — they shape look, not contract
- Truecolor path with discrete-palette fallback — the view must render on themes that don't expose RGB

## Width-Correct Helpers (used extensively)
- `truncateToWidth(line, width, "…", false)` — single-line chrome (splash/status-bar/settings-field)
- `visibleWidth(head)` — sizing the remaining value column in settings-field
- `wrapTextWithAnsi(src, width)` — transcript paragraph wrapping
- Equalizer is the only exception: builds raw ASCII columns then wraps each row in a single SGR pair (visible width = string width by construction)

## Testing Pattern (contract-based, not snapshot)
Component tests assert against the **tagged-theme contract** — they check for presence of theme-key tags and substrings, never byte-for-byte output. This keeps tests stable across theme tweaks, glyph swaps, and width changes while still pinning the rendering contract (what tokens appear, in what order).
