import type { QuestionnaireResult } from "./tool/types.js";

/**
 * Inline row budget. A component in Pi's editor slot only receives a width, and the
 * host clips the slot from the bottom when the dock outgrows the screen, so the inline
 * dialog caps itself — the same idiom Pi's own editor uses in that slot
 * (`max(5, floor(rows * 0.3))`). The floor keeps the dialog chrome plus a few option
 * rows; past the cap, `DialogView`'s scroll-to-focus partition takes over.
 */
export const INLINE_ROW_RATIO = 0.7;
export const INLINE_MIN_ROWS = 12;

/** Maps the terminal's row count to the rows the dialog may render. */
export type RowBudget = (terminalRows: number) => number;

/** The whole of `terminal.rows`: the overlay, and any host that already allocates the dialog's rows. */
export const fullRowBudget: RowBudget = (terminalRows) => terminalRows;

/**
 * Marker a host sets on `tui.terminal` when it reports the rows it has allocated to the
 * questionnaire as `terminal.rows` (rpiv-pi's lane console `cappedTui`). The inline cap
 * exists to leave the transcript room in Pi's editor slot; applying it to an allocation
 * would shrink an already-sized band a second time. A registry symbol, so hosts need no
 * import from this package.
 */
export const HOST_ALLOCATED_ROWS = Symbol.for("rpiv-ask-user-question:host-allocated-rows");

function hostAllocatesRows(terminal: object): boolean {
	return (terminal as Record<symbol, unknown>)[HOST_ALLOCATED_ROWS] === true;
}

/** The presentation's budget, unless the host has already allocated the rows itself. */
export function rowBudgetForHost(terminal: object, budget: RowBudget): RowBudget {
	return hostAllocatesRows(terminal) ? fullRowBudget : budget;
}

/**
 * Resolved by an inline mount that gives the editor slot up (see `mustYieldInlineSlot`);
 * `execute()` remounts as an overlay on seeing it. Compared by identity — a valid cancel
 * result, so it is harmless should it ever escape.
 */
export const YIELD_TO_OVERLAY: QuestionnaireResult = Object.freeze({
	answers: [],
	cancelled: true,
}) as QuestionnaireResult;

/**
 * True when an inline mount would land underneath an overlay already on screen (e.g. an
 * open `/btw`). pi-tui hands focus to the newly mounted editor-slot component while
 * that overlay keeps painting over it, so keys — Esc included — would reach a question
 * the user cannot see. Stacking as an overlay instead keeps the question visible and
 * focused, and pi-tui returns focus to the other overlay when it closes. A host that
 * allocates the rows itself (rpiv-pi lane console) owns its geometry and is left alone.
 */
export function mustYieldInlineSlot(tui: { terminal: object; hasOverlay?: () => boolean }): boolean {
	return !hostAllocatesRows(tui.terminal) && typeof tui.hasOverlay === "function" && tui.hasOverlay();
}

export const inlineRowBudget: RowBudget = (terminalRows) =>
	Math.min(terminalRows, Math.max(INLINE_MIN_ROWS, Math.floor(terminalRows * INLINE_ROW_RATIO)));

export interface Presentation {
	/** True → focused overlay (`ctx.ui.custom` overlay options); false → Pi's editor slot. */
	overlay: boolean;
	/**
	 * Overlay only: collapse may fully hide it (`OverlayHandle.setHidden`, reopened by the
	 * raw collapse listener). False when stacked over another overlay — see
	 * `STACKED_OVERLAY_PRESENTATION`.
	 */
	hideOnCollapse?: boolean;
	rowBudget: RowBudget;
	/** Frees the inline slot; present only when this presentation claimed it. Call once, on teardown. */
	release?: () => void;
}

// Pi runs tool calls in parallel by default and has a single editor slot: a second
// inline mount would replace the first, whose `custom()` promise would never settle.
// Overlays stack safely, so a questionnaire that finds the slot taken degrades to one
// instead of waiting — waiting could stall on a lane's parked question indefinitely.
let inlineSlotHeld = false;

function claimInlineSlot(): (() => void) | undefined {
	if (inlineSlotHeld) return undefined;
	inlineSlotHeld = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		inlineSlotHeld = false;
	};
}

export const OVERLAY_PRESENTATION: Presentation = Object.freeze({
	overlay: true,
	rowBudget: fullRowBudget,
	hideOnCollapse: true,
});

/**
 * The overlay a question stacks as when another overlay (e.g. `/btw`) is already open.
 * Collapse keeps it visible as the one-row hint instead of hiding it: Pi closes an
 * overlay-mode `ui.custom` with `hideOverlay()`, which pops the TOPMOST overlay — a
 * hidden questionnaire above `/btw` would be popped when `/btw` closes, stranding `/btw`
 * on screen and leaving the questionnaire's promise unsettled (the agent hangs). The
 * visible row keeps focus, so the overlay below stays readable but is closed after the
 * question.
 */
export const STACKED_OVERLAY_PRESENTATION: Presentation = Object.freeze({
	overlay: true,
	rowBudget: fullRowBudget,
	hideOnCollapse: false,
});

/**
 * Inline in Pi's editor slot — where Pi's own select/input/editor prompts mount, so the
 * transcript keeps scrolling while a question is open (#253). The overlay is only the
 * fallback when another questionnaire already holds the slot.
 */
export function resolvePresentation(): Presentation {
	const release = claimInlineSlot();
	return release ? { overlay: false, rowBudget: inlineRowBudget, release } : OVERLAY_PRESENTATION;
}
