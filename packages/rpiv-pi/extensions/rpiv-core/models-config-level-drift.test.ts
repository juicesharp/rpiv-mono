/**
 * Cross-package thinking-level drift test — the single mechanism pinning the
 * three hand-maintained vocabulary copies to pi-ai's thinking-level universe:
 *
 *   1. rpiv-pi       THINKING_LEVEL_VALUES / MODEL_THINKING_LEVEL_VALUES (canonical)
 *   2. rpiv-advisor  EFFORT_ORDINAL (the ordinal minEffort thresholds rank against)
 *   3. rpiv-workflow ModelSelection["thinking"] (the embedder-facing contract)
 *
 * The zero-cross-imports contract between sibling packages is a RUNTIME rule;
 * the imports below are test-only (the advisor value import reaches
 * messages.ts, which is pure declarations; the workflow copy is imported
 * type-only), so the shipped import graph is untouched. `.js` extensions are
 * required — the single tsconfig program resolves these relative paths.
 */

import type { ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { EFFORT_ORDINAL } from "../../../rpiv-advisor/advisor/messages.js";
import type { ModelSelection } from "../../../rpiv-workflow/host.js";
import { type MODEL_THINKING_LEVEL_VALUES, THINKING_LEVEL_VALUES } from "./models-config.js";

// Type probes — bidirectional-extends idiom (cf. host.test.ts `Satisfies`).
// Each pair fails to compile when the two universes drift in either direction.
type Satisfies<Concrete, Port> = Concrete extends Port ? true : false;

const _gradedForward: Satisfies<(typeof THINKING_LEVEL_VALUES)[number], ThinkingLevel> = true;
const _gradedReverse: Satisfies<ThinkingLevel, (typeof THINKING_LEVEL_VALUES)[number]> = true;
const _persistableForward: Satisfies<(typeof MODEL_THINKING_LEVEL_VALUES)[number], ModelThinkingLevel> = true;
const _persistableReverse: Satisfies<ModelThinkingLevel, (typeof MODEL_THINKING_LEVEL_VALUES)[number]> = true;
const _ordinalElements: Satisfies<(typeof EFFORT_ORDINAL)[number], ThinkingLevel> = true;
const _workflowForward: Satisfies<NonNullable<ModelSelection["thinking"]>, ModelThinkingLevel> = true;
const _workflowReverse: Satisfies<ModelThinkingLevel, NonNullable<ModelSelection["thinking"]>> = true;
void _gradedForward;
void _gradedReverse;
void _persistableForward;
void _persistableReverse;
void _ordinalElements;
void _workflowForward;
void _workflowReverse;

describe("thinking-level vocabulary lockstep", () => {
	// Sentinel for the compile-time probes above: reaching this test at all
	// means every bidirectional-extends pair held.
	it("all three copies match pi-ai's thinking-level universe (compile-time probes)", () => {
		expect(true).toBe(true);
	});

	// The ordinal's element type can't express completeness or ORDER — the
	// ranking minEffort compares against — so pin both at runtime against the
	// canonical graded array (itself compile-pinned to pi-ai in models-config.ts).
	it("advisor EFFORT_ORDINAL lists the canonical graded levels in canonical order", () => {
		expect([...EFFORT_ORDINAL]).toEqual([...THINKING_LEVEL_VALUES]);
	});
});
