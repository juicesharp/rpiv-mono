/** Optional bridge. Load once alongside the questionnaire and Herdr's managed integration. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function herdrQuestionnaireAdapter(pi: ExtensionAPI): void {
	let outstanding = 0;
	const unsubscribe = pi.events.on("rpiv:ask-user:blocked", (payload: unknown) => {
		if (!payload || typeof payload !== "object" || !("active" in payload)) return;
		if (payload.active === true) {
			outstanding++;
			pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
		} else if (payload.active === false && outstanding > 0) {
			outstanding--;
			pi.events.emit("herdr:blocked", { active: false });
		}
	});

	pi.on("session_shutdown", () => {
		unsubscribe();
		// Release only this adapter's contributions, never another tool's waiting state.
		while (outstanding > 0) {
			outstanding--;
			pi.events.emit("herdr:blocked", { active: false });
		}
	});
}
