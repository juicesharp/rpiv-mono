import { describe, expect, it } from "vitest";
import { initialVoiceState } from "../state.ts";
import { draftFromConfig } from "../state-reducer.ts";
import { selectActiveView } from "./focus.ts";

const base = initialVoiceState(draftFromConfig({}));

describe("selectActiveView", () => {
	it("returns 'dictation' on the default state", () => {
		expect(selectActiveView(base)).toBe("dictation");
	});

	it("returns 'settings' when on the settings screen", () => {
		expect(selectActiveView({ ...base, currentScreen: "settings" })).toBe("settings");
	});
});
