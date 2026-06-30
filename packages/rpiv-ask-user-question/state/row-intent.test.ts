import { describe, expect, it } from "vitest";
import type { QuestionData } from "../tool/types.js";
import {
	LABELS_BY_KIND,
	RESERVED_LABEL_SET,
	ROW_INTENT_META,
	type RowKind,
	SENTINEL_KINDS,
	sentinelsToAppend,
} from "./row-intent.js";

const ALL_KINDS: readonly RowKind[] = ["option", "other", "next"];

describe("row-intent META exhaustiveness", () => {
	it("has an entry for every RowKind", () => {
		for (const k of ALL_KINDS) {
			expect(ROW_INTENT_META[k]).toBeDefined();
		}
	});

	it("only `option` has empty label; sentinels carry user-facing labels", () => {
		expect(ROW_INTENT_META.option.label).toBe("");
		expect(ROW_INTENT_META.other.label).toBe("Type something.");
		expect(ROW_INTENT_META.next.label).toBe("Next");
	});

	it("`option` is the only non-reserved kind", () => {
		expect(ROW_INTENT_META.option.reserved).toBe(false);
		for (const k of SENTINEL_KINDS) expect(ROW_INTENT_META[k].reserved).toBe(true);
	});

	it("every sentinel lives in the main list", () => {
		for (const k of SENTINEL_KINDS) {
			expect(ROW_INTENT_META[k].livesInMainList).toBe(true);
		}
		expect(ROW_INTENT_META.option.livesInMainList).toBe(true);
	});

	it("`next` is the only kind excluded from numbering", () => {
		expect(ROW_INTENT_META.next.numbered).toBe(false);
		expect(ROW_INTENT_META.option.numbered).toBe(true);
		expect(ROW_INTENT_META.other.numbered).toBe(true);
	});

	it("`other` is the only kind that activates inputMode", () => {
		expect(ROW_INTENT_META.other.activatesInputMode).toBe(true);
		for (const k of ["option", "next"] as const) {
			expect(ROW_INTENT_META[k].activatesInputMode).toBe(false);
		}
	});

	it("`next` is the only multi-select toggle blocker / auto-submitter", () => {
		expect(ROW_INTENT_META.next.blocksMultiToggle).toBe(true);
		expect(ROW_INTENT_META.next.autoSubmitsInMulti).toBe(true);
		for (const k of ["option", "other"] as const) {
			expect(ROW_INTENT_META[k].blocksMultiToggle).toBe(false);
			expect(ROW_INTENT_META[k].autoSubmitsInMulti).toBe(false);
		}
	});
});

describe("LABELS_BY_KIND", () => {
	it("matches META labels for sentinel kinds only", () => {
		expect(LABELS_BY_KIND.other).toBe(ROW_INTENT_META.other.label);
		expect(LABELS_BY_KIND.next).toBe(ROW_INTENT_META.next.label);
	});
});

describe("RESERVED_LABEL_SET", () => {
	it("contains 'Other' plus every reserved sentinel label", () => {
		expect(RESERVED_LABEL_SET.has("Other")).toBe(true);
		expect(RESERVED_LABEL_SET.has("Type something.")).toBe(true);
		expect(RESERVED_LABEL_SET.has("Next")).toBe(true);
	});

	it("does NOT contain non-reserved or unrelated labels", () => {
		expect(RESERVED_LABEL_SET.has("")).toBe(false);
		expect(RESERVED_LABEL_SET.has("Submit")).toBe(false);
	});
});

describe("sentinelsToAppend walker", () => {
	const baseSingle: QuestionData = {
		question: "Q?",
		header: "H",
		options: [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
		],
	};
	const baseMulti: QuestionData = { ...baseSingle, multiSelect: true };

	it("appends `other` for single-select regardless of preview", () => {
		expect(sentinelsToAppend(baseSingle)).toEqual(["other"]);
	});

	it("`other` now appends on multi-select too (autoAppendOnMultiSelect === true)", () => {
		expect(ROW_INTENT_META.other.autoAppendOnMultiSelect).toBe(true);
	});

	it("appends `other` + `next` for multi-select (other no longer suppressed)", () => {
		expect(sentinelsToAppend(baseMulti)).toEqual(["other", "next"]);
	});
});
