# Changelog

All notable changes to `@juicesharp/rpiv-ask-user-question` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `WrappingSelect` keeps numbered prefixes (`❯ N. label`) but the chat row's number is now continuous with the active tab — the host calls `chatList.setNumbering(items.length, items.length + 1)` on every tab switch, so chat reads as `(N+1). Chat about this` instead of always `1.`.
- New `WrappingSelect.setNumbering(offset, total)` method to mutate numbering in place without rebuilding the component.
- `PreviewPane`'s options list now reserves a numbering slot for the chat row (`totalItemsForNumbering = items.length + 1`) so the number column width is consistent whether or not chat is focused.
- In multi-question mode, the inner header badge inside the dialog body is suppressed — the tab bar already shows the per-tab header. This was the root cause of "Submit Tab is one line shorter than question tab" + dialog jumping on tab-switch.
- Footer of question tabs now renders as `border + blank + chat row + blank + controls hint + blank` (empty lines on either side of the chat row, plus a trailing blank line below the controls hint for breathing room).
- Controls hint copy reworked: `Enter to select · ↑/↓ to navigate [· Space to toggle] [· n to add notes] [· Tab to switch questions] · Esc to cancel`.
- Side-by-side preview layout: options column is now hard-capped at 40 cols (`PREVIEW_LEFT_COLUMN_MAX_WIDTH`); preview block uses fixed top + left padding (`PREVIEW_PADDING_TOP=1`, `PREVIEW_PADDING_LEFT=1`) instead of horizontal centering, so content starts at a stable offset regardless of length.
- Stacked (narrow) preview layout: an empty row (`STACKED_GAP_ROWS`) now separates the options block from the preview block.

### Fixed
- Submit Tab no longer collapses the dialog: its container mirrors the question-tab chrome line-for-line (border + tabBar + Spacer + headerSlot + Spacer + FixedHeightBox(summary) + Spacer + border + 5 footer-placeholder Spacers) so total height matches across tab switches across with/without/mixed-header fixtures.
- `MultiSelectOptions` rows now use a 2-space gap between the checkbox glyph and the option label (was 1 space) so the label visually separates from the checkbox at narrow widths.
- Chat row hides its `N. ` index prefix on multi-select tabs (since multi-select option rows show checkboxes, not numbers) via the new `WrappingSelect.setShowNumbering(boolean)` setter, driven from the host's `applySelection()` based on the active tab's `multiSelect` flag.
- Submit Tab footer (chat row + controls hint) is suppressed entirely — the in-body line carries `SUBMIT_READY` (or the missing-questions warning) instead. `SUBMIT_HINT_READY` is no longer rendered on the Submit Tab.
- Pressing Enter on a SINGLE multi-select question now correctly submits the dialog. Previously the host saved the answer (`multi_confirm`) but never submitted because the action carried no `autoAdvanceTab`, leaving the user stuck. `multi_confirm` now mirrors the single-select `confirm` lifecycle: advance to the next tab in multi-question mode, or submit when single-question.
- Doubled cursor on multi-select tabs when chat / notes have focus: `MultiSelectOptions` now exposes `setFocused(boolean)` (matching `WrappingSelect`'s contract). The host pushes the same focus state into every multi-select renderer in `applySelection()`, so the active-row `❯` pointer hides while the chat row / notes input is focused.
- `PreviewPane` now hides the preview pane entirely when no option in the question carries a `preview` string (rather than padding `MAX_PREVIEW_HEIGHT` rows of "No preview available"). The placeholder is still rendered for individual unpreviewed options when at least one option in the question has a preview.
- Chat row is no longer a one-way trap on DOWN: pressing DOWN while `chatFocused` now emits `focus_options` (matching the existing UP-while-chatFocused → `focus_options` behavior).
- `package.json` `files` array now includes `fixed-height-box.ts` and `multi-select-options.ts`, both of which are imported by `dialog-builder.ts` but were missing from the published artifact.

## [0.12.7] - 2026-04-26

### Fixed
- Inline "Other" free-text input now clips to terminal width, preventing crashes on narrow terminals (e.g. Arch + Ghostty) where the row could overflow by a column or two and trip pi's safety check.

## [0.12.6] - 2026-04-26

## [0.12.5] - 2026-04-24

## [0.12.4] - 2026-04-24

## [0.12.3] - 2026-04-24

## [0.12.2] - 2026-04-24

## [0.12.1] - 2026-04-24

## [0.12.0] - 2026-04-24

## [0.11.7] - 2026-04-23

## [0.11.6] - 2026-04-22

## [0.11.5] - 2026-04-22

## [0.11.4] - 2026-04-21

## [0.11.3] - 2026-04-21

## [0.11.2] - 2026-04-21

## [0.11.1] - 2026-04-20

## [0.11.0] - 2026-04-20

### Added
- `dispatchQuestionInput(index, item, ctx)` extracted from the selector's `keyBinding` handler and `buildDialogContainer(mainItems, ctx, initialIndex, onKey)` exported so the dispatch matrix (edit / skip / finalize / single-select / multi-select toggle+Enter) and dialog wiring can be unit-tested directly. Bodies and TUI semantics unchanged — additive `export` only.

## [0.10.0] - 2026-04-20

### Added
- Five pure helpers are now exported from `ask-user-question.ts` for direct unit testing: `buildMainItems`, `itemAt`, `wrapIndex`, `buildResponse`, `buildToolResult`. Signatures and bodies unchanged — additive `export` keyword only.

## [0.9.1] - 2026-04-20

## [0.9.0] - 2026-04-19

## [0.8.3] - 2026-04-19

## [0.8.2] - 2026-04-19

## [0.8.1] - 2026-04-19

## [0.8.0] - 2026-04-19

## [0.7.0] - 2026-04-18

## [0.6.1] - 2026-04-18

## [0.6.0] — 2026-04-18

### Changed
- Consolidated into the `juicesharp/rpiv-mono` monorepo. Version aligned to the rpiv-pi family lockstep starting point. No runtime behavior change from `0.1.4`.
