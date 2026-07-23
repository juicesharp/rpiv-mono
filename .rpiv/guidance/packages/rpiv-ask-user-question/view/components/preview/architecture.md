# rpiv-ask-user-question / view / components / preview

## Responsibility
Render-only sub-system that turns a `QuestionData.options[i].preview` markdown string into a bordered, width-fitted preview block and composes it next to (side-by-side) or below (stacked) the option list. Driven exclusively by `setProps` from the canonical state adapter — never reads keystrokes or state directly. While `inputMode` is set (user typing on the custom-answer row), the preview is suppressed and the option list gets the full pane width.

## Dependencies
- **`@earendil-works/pi-tui`**: `Markdown`, `MarkdownTheme`, `Component`, `visibleWidth`, `truncateToWidth` (no `wrapTextWithAnsi` — `Markdown.render(width)` wraps)
- **`@earendil-works/pi-coding-agent`**: `Theme` (`theme.fg("accent"|"dim"|"muted", ...)`)
- **Internal**: `../../../state/i18n-bridge.js` (`t`), `../../../tool/types.js` (`QuestionData`), `../wrapping-select.js` (`WrappingSelectItem`), `../option-list-view.js` (`OptionListView`), `../../stateful-view.js` (`StatefulView`)

## Module Structure
```
markdown-content-cache.ts   — Per-question Map<optionIndex, Markdown> with single cachedWidth; lazy + width-keyed invalidation
preview-block-renderer.ts   — Owns the cache; computes blockHeight; renderBlock = bordered box + blank + affordance row (height-stable)
preview-box-renderer.ts     — Pure 4-sided border + 1-col padding; computeBoxDimensions; stripFenceMarkers (drops literal ``` lines)
preview-layout-decider.ts   — Pure decideLayout, adaptiveLeftWidth, crossTabMaxLeftWidth, columnWidths, bodyWidths
preview-pane.ts             — Thin StatefulView<PreviewPaneProps> composer; re-exports public surface for tests
```

## Pipeline (input → output)
1. Raw markdown enters via `QuestionData.options[i].preview`; cached in `previewTexts`
2. Cache key = `(optionIndex, innerWidth)` — `innerWidth` change drops **all** `Markdown` renders
3. Block render: `cache.bodyFor()` → `Markdown.render(innerWidth)` → `stripFenceMarkers`
4. Box wrap: `computeBoxDimensions` then `renderBorderedBox` with `accent` color and optional "✂ ── N lines hidden ──" indicator
5. Layout decide: `decideLayout(terminalWidth, paneWidth) → "side-by-side" | "stacked"`
6. Output: stacked = `[optionsLines, "", boxLines, "", affordance]`; side-by-side = row-zipped `left + gap + paddedRight`

## Width-Keyed Cache
```ts
bodyFor(optionIndex: number, innerWidth: number): string[] {
    if (this.cachedWidth !== innerWidth) {
        for (const md of this.markdownCache.values()) md.invalidate();  // every render is now stale
        this.cachedWidth = innerWidth;
    }
    let md = this.markdownCache.get(optionIndex);
    if (!md) { md = new Markdown(text, 0, 0, this.markdownTheme); this.markdownCache.set(optionIndex, md); }
    return stripFenceMarkers(md.render(innerWidth));
}
```
**Why width-keyed**: `Markdown.render(width)` re-wraps on every width change (different line breaks, padded trailing spaces). The cache holds the `Markdown` instance (reusable), but `cachedWidth !== innerWidth` invalidates every stored render. `maxNaturalHeight` measures every option at the same `previewWidth` — width-keyed reuse avoids N markdown re-renders per tick.

## Layout Decider (pure)
```ts
export function decideLayout(terminalWidth: number, paneWidth: number): PreviewLayoutMode {
    return terminalWidth >= PREVIEW_MIN_WIDTH && paneWidth >= PREVIEW_MIN_WIDTH ? "side-by-side" : "stacked";
}
export function columnWidths(paneWidth: number, adaptiveLeft: number) {
    const gap = PREVIEW_COLUMN_GAP;
    const leftWidth  = Math.min(adaptiveLeft, Math.max(1, paneWidth - gap - 1));
    const rightWidth = Math.max(1, paneWidth - leftWidth - gap);
    return { leftWidth, rightWidth, gap };
}
```
`crossTabMaxLeftWidth` numbers every tab with `totalForNumbering = items.length` — the +1 slot single-select tabs once reserved for the chat row went away with the `Chat about this` escape hatch, which can narrow the adaptive left column at digit-count boundaries (9/99 options).

## Box Renderer (width-correct)
```ts
const dashSpan     = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD);
const contentInner = Math.max(1, dashSpan - 2 * BORDER_INNER_PADDING_HORIZONTAL);
const pad          = " ".repeat(BORDER_INNER_PADDING_HORIZONTAL);
const top          = colorFn(`┌${"─".repeat(dashSpan)}┐`);
for (const line of lines) {
    const padded = truncateToWidth(line, contentInner, "", true);  // right-pad to inner width
    out.push(`${colorFn("│")}${pad}${padded}${pad}${colorFn("│")}`);
}
```

## setProps + render
```ts
setProps(props: PreviewPaneProps): void { this.props = props; }
render(width: number): string[] {
    if (this.question.multiSelect === true) return this.optionListView.render(width);
    if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width);
    if (this.props.inputMode) return this.optionListView.render(width);  // typing on the custom-answer row
    const mode = decideLayout(this.getTerminalWidth(), width);
    return mode === "side-by-side" ? this.renderSideBySide(width, mode) : [
        ...this.optionListView.render(width), ...Array(STACKED_GAP_ROWS).fill(""),
        ...this.previewBlock.renderBlock(width, this.props.selectedIndex, mode, this.props.focused, this.props.notesVisible),
    ];
}
```
**`inputMode` bypass**: `PreviewPaneProps` is `{ notesVisible, selectedIndex, focused, inputMode }` — `inputMode` is true while the "Type something." custom-answer row is accepting input (`state.inputMode`, surfaced by `selectPreviewPaneProps`). That row sits at index `options.length`, out of bounds for any option's preview, so the pane renders the option list at the **full pane width** — no left-column split, no preview block. All four members (`render`, `focusedItemRowRange`, `naturalHeight`, `maxNaturalHeight`) apply the identical guard, preserving the `naturalHeight === render().length` and `maxNaturalHeight >= naturalHeight` parity invariants; side-by-side + preview resume verbatim when `inputMode` clears on nav-away.

## Composition with Options List (side-by-side)
`renderSideBySide` splits via `columnWidths(width, adaptiveLeft)`, renders `optionListView.render(leftWidth)` and `renderPaddedPreviewLines(rightWidth, mode)`, then row-zips: `truncateToWidth(left, leftWidth, "") + spacePad + gap + right`, finally `truncateToWidth(joined, width, "")`. `adaptiveLeft` is injected via `setGlobalLeftWidth` (cross-tab `crossTabLeftWidthWithDonation`) so the seam stays stable on tab switch.

## Architectural Boundaries
- **Width measurement via `visibleWidth`/`truncateToWidth`** (8 call sites) — `.length` never *measures width* of user/markdown content; remaining `.length` uses are array lengths, the `raw.length > 0` emptiness check in `markdown-content-cache.ts`, and the hidden-lines indicator (`✂`/`─` are single-width BMP glyphs, so length == visible width there)
- **Render-only** — NO keystroke handling and NO direct state reads; `setProps` from the canonical adapter is the sole input
- **Pure helpers stay pure** — `decideLayout`, `columnWidths`, `renderBorderedBox`, `computeBoxDimensions` take every input as an argument; no theme or state reach-in
- **Guard chain is uniform** — `multiSelect` → `hasAnyPreview()` → `inputMode` bypasses are applied identically by all four public members, preserving `naturalHeight === render().length`

<important if="you are modifying preview rendering, sizing, or layout in this directory">
## Checklist
1. Keep the guard chain identical across `render`, `focusedItemRowRange`, `naturalHeight`, `maxNaturalHeight` — the parity invariants depend on it
2. Measure content-derived widths with `visibleWidth`/`truncateToWidth` — never `string.length`
3. Route any `innerWidth`-derivation change through the width-keyed cache (`cachedWidth` invalidation) or stale `Markdown` renders leak
4. Update the co-located `*.test.ts` files (`preview-pane`, `preview-block-renderer`, `preview-layout-decider`) alongside
</important>
