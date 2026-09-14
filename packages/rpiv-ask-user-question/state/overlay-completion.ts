import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { QuestionnaireResult } from "../tool/types.js";

/** Identity-scoped completion for both stack-pop and identity-aware Pi hosts. */
export function createOverlayCompletion({
	tui,
	getHandle,
	done,
}: {
	tui: Pick<TUI, "showOverlay">;
	getHandle: () => OverlayHandle | undefined;
	done: (result: QuestionnaireResult) => void;
}): (result: QuestionnaireResult) => void {
	let completed = false;
	return (result) => {
		if (completed) return;
		completed = true;
		// Pi 0.80.6 and 0.85.1 synchronously pop the stack top in custom UI's done().
		// A non-rendering, non-focusing guard absorbs that pop after we remove our
		// actual overlay by identity. Do not await between pushing the guard and
		// completing the host. Finally also removes it on identity-aware hosts.
		// This protects other overlays even if completion occurs before onHandle.
		const guard = tui.showOverlay(
			{ render: () => [], invalidate: () => {} },
			{
				nonCapturing: true,
				visible: () => false,
			},
		);
		try {
			getHandle()?.hide();
			done(result);
		} finally {
			guard.hide();
		}
	};
}
