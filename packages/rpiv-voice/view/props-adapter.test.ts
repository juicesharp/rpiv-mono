import { describe, expect, it, vi } from "vitest";

import type { BindingContext } from "../state/selectors/contract.ts";
import { initialVoiceState, type VoiceState } from "../state/state.ts";
import type { BoundGlobalBinding } from "./component-binding.ts";
import { VoiceOverlayPropsAdapter } from "./props-adapter.ts";

const DRAFT = { hallucinationFilterEnabled: true, equalizerEnabled: false };
const BASE = initialVoiceState(DRAFT);

function fakeBinding() {
	const b = {
		applied: 0,
		invalidated: 0,
		apply: vi.fn((_state: VoiceState, _ctx: BindingContext) => {
			b.applied++;
		}),
		invalidate: vi.fn(() => {
			b.invalidated++;
		}),
	} satisfies BoundGlobalBinding & { applied: number; invalidated: number };
	return b;
}

describe("VoiceOverlayPropsAdapter", () => {
	it("calls apply on every binding with the voice state and context", () => {
		const b1 = fakeBinding();
		const b2 = fakeBinding();
		const requestRender = vi.fn();
		const adapter = new VoiceOverlayPropsAdapter({
			tui: { requestRender },
			bindings: [b1, b2],
		});

		adapter.apply(BASE);

		expect(b1.apply).toHaveBeenCalledOnce();
		expect(b2.apply).toHaveBeenCalledOnce();
		// Both receive the same state + context
		const [state1, ctx1] = b1.apply.mock.calls[0];
		expect(state1).toBe(BASE);
		expect(ctx1.activeView).toBe("dictation");
	});

	it("calls requestRender after applying all bindings", () => {
		const requestRender = vi.fn();
		const adapter = new VoiceOverlayPropsAdapter({
			tui: { requestRender },
			bindings: [],
		});

		adapter.apply(BASE);
		expect(requestRender).toHaveBeenCalledOnce();
	});

	it("requestRender is called even when bindings array is empty", () => {
		const requestRender = vi.fn();
		const adapter = new VoiceOverlayPropsAdapter({
			tui: { requestRender },
			bindings: [],
		});

		adapter.apply(BASE);
		expect(requestRender).toHaveBeenCalledOnce();
	});

	it("computes activeView from voice state (dictation screen)", () => {
		const binding = fakeBinding();
		const requestRender = vi.fn();
		const adapter = new VoiceOverlayPropsAdapter({
			tui: { requestRender },
			bindings: [binding],
		});

		adapter.apply(BASE);
		const [, ctx] = binding.apply.mock.calls[0];
		expect(ctx.activeView).toBe("dictation");
	});

	it("computes activeView from voice state (settings screen)", () => {
		const binding = fakeBinding();
		const requestRender = vi.fn();
		const adapter = new VoiceOverlayPropsAdapter({
			tui: { requestRender },
			bindings: [binding],
		});

		adapter.apply({ ...BASE, currentScreen: "settings" });
		const [, ctx] = binding.apply.mock.calls[0];
		expect(ctx.activeView).toBe("settings");
	});

	it("invalidate fans out to all bindings", () => {
		const b1 = fakeBinding();
		const b2 = fakeBinding();
		const adapter = new VoiceOverlayPropsAdapter({
			tui: { requestRender: vi.fn() },
			bindings: [b1, b2],
		});

		adapter.invalidate();
		expect(b1.invalidate).toHaveBeenCalledOnce();
		expect(b2.invalidate).toHaveBeenCalledOnce();
	});
});
