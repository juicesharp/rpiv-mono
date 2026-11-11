import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { TabBar } from "./components/tab-bar.ts";

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
