import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { TabBar } from "./components/tab-bar.js";
import {
	COLLAPSED_HINT,
	collapsedHintFor,
	collapseHintFor,
	expandHintFor,
	formatCollapseKey,
} from "./dialog-builder.js";

const theme = makeTheme() as unknown as Theme;

describe("DialogView — topFixed / bottomFixed magic-constant invariants", () => {
	it("DynamicBorder renders exactly 1 row (topFixed assumes 1)", () => {
		const border = new DynamicBorder((s) => theme.fg("accent", s));
		expect(border.render(80).length).toBe(1);
	});

	it("TabBar renders exactly 2 rows (topFixed assumes 2 when isMulti)", () => {
		const bar = new TabBar(theme);
		bar.setProps({
			tabs: [
				{ label: "H1", active: true, answered: false },
				{ label: "H2", active: false, answered: false },
			],
			submit: { active: false, allAnswered: false },
		});
		expect(bar.render(80).length).toBe(2);
	});
});

describe("collapse-key hint interpolation (#72)", () => {
	it("formatCollapseKey capitalizes each +-separated part", () => {
		expect(formatCollapseKey("ctrl+]")).toBe("Ctrl+]");
		expect(formatCollapseKey("alt+o")).toBe("Alt+O");
		expect(formatCollapseKey("ctrl+shift+h")).toBe("Ctrl+Shift+H");
	});

	it("collapseHintFor / expandHintFor interpolate the configured key", () => {
		expect(collapseHintFor("ctrl+]")).toBe("Ctrl+] to collapse");
		expect(collapseHintFor("alt+o")).toBe("Alt+O to collapse");
		expect(expandHintFor("alt+o")).toBe("Alt+O to expand");
	});

	it("collapsedHintFor interpolates the key and keeps the default when off", () => {
		expect(collapsedHintFor("alt+o")).toBe("Alt+O to expand · Esc to cancel");
		expect(collapsedHintFor("off")).toBe(COLLAPSED_HINT);
	});
});
