import { DEFAULT_COLLAPSE_KEY, formatKeySpecForDisplay } from "../config.js";

/** Leaf: imports nothing from `view/`, so `dialog-builder` and `tab-content-strategy` never form a runtime cycle (#208). */

export const HINT_PART_ENTER = "Enter to select";
export const HINT_PART_NAV = "↑/↓ to navigate";
export const HINT_PART_NEW_LINE = "Shift+Enter for newline";
export const HINT_PART_CLEAR = "Ctrl+U to clear";
export const HINT_PART_TOGGLE = "Space to toggle";
export const HINT_PART_NOTES = "n to add notes";
export const HINT_PART_TAB = "Tab to switch questions";
export const HINT_PART_CANCEL = "Esc to cancel";
/**
 * Collapse/expand hint copy is templated on `KEY_PLACEHOLDER` because the
 * shortcut is configurable (`collapseKey`) and `rpiv-i18n`'s `tr` has no
 * interpolation — locale entries carry the same `{key}` placeholder and call
 * sites `.replace()` it with `formatKeySpecForDisplay(collapseKey)` after
 * lookup, so per-locale word order is preserved.
 */
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} to collapse`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} to expand`;
/** Default-key (`Ctrl+]`) rendering of the collapse template, for tests and default-config assertions. */
export const HINT_PART_COLLAPSE = HINT_PART_COLLAPSE_TEMPLATE.replace(
	KEY_PLACEHOLDER,
	formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY),
);
/**
 * `HINT_SINGLE` / `HINT_MULTI` are the resting core hint for NON-multiSelect
 * question tabs only: `buildHintText` drops `NOTES` while the notes editor is
 * open (`state.notesVisible`) or the "Type something." row is capturing text
 * (`state.inputMode`), and on multiSelect tabs it interleaves `TOGGLE` between
 * `NAV` and `NOTES`, so neither composite is a substring there — assert on
 * `HINT_PART_*` constants in those states instead. The collapse affordance is
 * appended AFTER cancel by `buildHintText` so the resting core stays a contiguous
 * prefix substring of the rendered line. On narrow terminals the collapse tail
 * clips with `…` (`OneLineClippedText`); the core is preserved.
 */
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTI = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_TAB, HINT_PART_CANCEL].join(
	" · ",
);
/**
 * Template for the single-line footer shown by `QuestionnaireSession` when
 * `state.collapsed === true`. Bypasses `buildHintText`; the session replaces
 * `KEY_PLACEHOLDER` with the configured key's display form.
 */
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";
