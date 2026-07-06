import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

import { AccentDivider } from "./accent-divider.js";

const theme = {
	...makeTheme({ fg: (color: string, text: string) => `<${color}>${text}</${color}>` }),
	boxSharp: { horizontal: "─" },
} as unknown as Theme;

describe("AccentDivider", () => {
	it("renders an accent-colored divider from the injected theme", () => {
		const divider = new AccentDivider(theme);

		expect(divider.render(3)).toEqual(["<accent>───</accent>"]);
	});

	it("invalidates cached width-aware output", () => {
		const divider = new AccentDivider(theme);

		expect(divider.render(2)).toEqual(["<accent>──</accent>"]);
		divider.invalidate();
		expect(divider.render(4)).toEqual(["<accent>────</accent>"]);
	});
});
