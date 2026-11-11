import type { ActiveView } from "../../view/stateful-view.ts";
import type { VoiceState } from "../state.ts";

export function selectActiveView(state: VoiceState): ActiveView {
	return state.currentScreen === "settings" ? "settings" : "dictation";
}
