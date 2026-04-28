# Changelog

All notable changes to `@juicesharp/rpiv-ask-user-question` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.3] - 2026-04-28

### Fixed
- Publish manifest: `package.json` `files` array now includes `apply-action.ts`, `option-list-view.ts`, `preview-block-renderer.ts`, and `view-adapter.ts`. The 1.0.2 tarball omitted these refactor-introduced production modules, so Pi failed to load the extension with `Cannot find module './apply-action.js'` from `questionnaire-session.ts`.

### Changed
- Internal refactor: replaced flag-based row/answer discriminators with `kind`-tagged discriminated unions. `WrappingSelectItem` gains `kind: "option" | "other" | "chat" | "next"` (drops `isOther` / `isChat` / `isNext`); `QuestionAnswer` gains `kind: "option" | "custom" | "chat" | "multi"` (drops `wasCustom` / `wasChat`). Modeled after the existing `QuestionnaireAction` / `Effect` unions in this package — exhaustive-`switch` enforcement, no `default:`, no helper. Adding a new row affordance now requires a single union extension + compiler-enforced exhaustive switch updates rather than 8 lockstep edits across modules. No observable behavior change — all existing tests pass after fixture-shape rewrites only.

## [1.0.2] - 2026-04-28

### Changed
- Internal refactor: split `QuestionnaireSession` into a free-function selector module (`questionnaire-state.ts`), a pure `applyAction(state, action, ctx) → { state, effects }` reducer (`apply-action.ts`), and a `QuestionnaireViewAdapter` for component fan-out (`view-adapter.ts`). The slim runtime keeps the canonical state cell, the two-pass `notesVisible` dispatch loop, and an effect runner. No observable behavior change — all 754 existing tests pass without modification.
- Drop redundant `QuestionnaireDispatchState` type alias; consumers use the canonical `QuestionnaireDispatchSnapshot` directly.
- Unify hint copy via `HINT_PART_*` phrase tokens shared by `buildHintText()` and the existing `HINT_*` test-substring constants — single source of truth for the controls hint line.

## [1.0.1] - 2026-04-28

## [1.0.0] - 2026-04-28

## [0.13.0] - 2026-04-28

### Added
- Multi-question dialogs with a tab bar (`Tab` to switch).
- Preview pane: side-by-side or stacked, with per-option notes (`n` to add notes).
- Multi-select questions: checkboxes, `Space` to toggle, `Next` sentinel, Enter-as-toggle on rows, toggles persisted across tab switches.
- Submit tab with answer review and a Submit picker; warns about unanswered questions.
- Chat row available on every tab.
- Schema: `questions[]`, per-option `preview`, per-option `notes`.

### Changed
- Preview pane hidden entirely when no option carries a preview.
- Continuous numbering across options and the chat row.
- Controls hint reworked per tab (Space/n/Tab hints shown only when relevant).

### Fixed
- Dialog height stable across tab switches (Submit tab no longer collapses).
- Enter on a single multi-select question now submits.
- DOWN on the chat row exits to options (was a one-way trap).
- No doubled cursor when chat or notes are focused on multi-select tabs.
- Preview height cap matches the actual layout (side-by-side vs stacked).
- `package.json` `files` array now ships every published module.

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
