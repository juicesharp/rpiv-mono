import { describe, expect, it, vi } from "vitest";
import { makeTestTui } from "../test-fixtures.js";
import { createOverlayCompletion } from "./overlay-completion.js";

const result = { answers: [], cancelled: true };
const component = () => ({ render: () => [], invalidate: () => {} });

describe("overlay completion compatibility", () => {
	it.each(["stack-pop", "identity-aware"])("completes once without disturbing other overlays (%s)", (host) => {
		const tui = makeTestTui();
		const own = tui.showOverlay(component());
		own.setHidden(true);
		const otherComponent = component();
		const other = tui.showOverlay(otherComponent);
		const done = vi.fn(() => (host === "stack-pop" ? tui.hideOverlay() : own.hide()));
		const complete = createOverlayCompletion({ tui, getHandle: () => own, done });
		complete(result);
		complete(result);
		expect(done).toHaveBeenCalledOnce();
		expect(Reflect.get(tui, "overlayStack")).toEqual([expect.objectContaining({ component: otherComponent })]);
		expect(other.isFocused()).toBe(true);
		other.hide();
		expect(Reflect.get(tui, "overlayStack")).toEqual([]);
	});

	it("removes the compatibility guard when the host completion throws", () => {
		const tui = makeTestTui();
		const own = tui.showOverlay(component());
		const otherComponent = component();
		tui.showOverlay(otherComponent);
		const complete = createOverlayCompletion({
			tui,
			getHandle: () => own,
			done: () => {
				throw new Error("host failed");
			},
		});
		expect(() => complete(result)).toThrow("host failed");
		expect(Reflect.get(tui, "overlayStack")).toEqual([expect.objectContaining({ component: otherComponent })]);
	});
});
