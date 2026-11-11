import { describe, expect, it, vi } from "vitest";

import type { BindingContext } from "../state/selectors/contract.ts";
import type { VoiceState } from "../state/state.ts";
import { initialVoiceState } from "../state/state.ts";
import { globalBinding } from "./component-binding.ts";
import type { StatefulView } from "./stateful-view.ts";

const DRAFT = { hallucinationFilterEnabled: true, equalizerEnabled: false };
const BASE = initialVoiceState(DRAFT);
const CTX: BindingContext = { activeView: "dictation" };

function fakeView<P>(): StatefulView<P> & { lastProps: P | undefined } {
	return {
		lastProps: undefined as P | undefined,
		setProps(props: P) {
			this.lastProps = props;
		},
		handleInput() {},
		invalidate: vi.fn(),
		render: () => [],
	};
}

describe("globalBinding", () => {
	it("applies selector output to the component", () => {
		const view = fakeView<{ transcript: string }>();
		const select = (state: VoiceState) => ({ transcript: state.transcript });
		const binding = globalBinding({ component: view, select });

		binding.apply({ ...BASE, transcript: "hello" }, CTX);
		expect(view.lastProps).toEqual({ transcript: "hello" });
	});

	it("skips apply when predicate returns false", () => {
		const view = fakeView<{ transcript: string }>();
		const select = (state: VoiceState) => ({ transcript: state.transcript });
		const predicate = () => false;
		const binding = globalBinding({ component: view, select, predicate });

		view.lastProps = { transcript: "existing" };
		binding.apply({ ...BASE, transcript: "new" }, CTX);
		expect(view.lastProps).toEqual({ transcript: "existing" });
	});

	it("applies when predicate returns true", () => {
		const view = fakeView<{ transcript: string }>();
		const select = (state: VoiceState) => ({ transcript: state.transcript });
		const predicate = () => true;
		const binding = globalBinding({ component: view, select, predicate });

		binding.apply({ ...BASE, transcript: "visible" }, CTX);
		expect(view.lastProps).toEqual({ transcript: "visible" });
	});

	it("forwards binding context to the predicate and selector", () => {
		const view = fakeView<string>();
		const select = (_state: VoiceState, ctx: BindingContext) => ctx.activeView;
		const predicate = (_state: VoiceState, ctx: BindingContext) => ctx.activeView === "settings";
		const binding = globalBinding({ component: view, select, predicate });

		// predicate says no → skip
		binding.apply(BASE, { activeView: "dictation" });
		expect(view.lastProps).toBeUndefined();

		// predicate says yes → apply
		binding.apply(BASE, { activeView: "settings" });
		expect(view.lastProps).toBe("settings");
	});

	it("invalidate forwards to the component", () => {
		const view = fakeView<unknown>();
		const binding = globalBinding({
			component: view,
			select: () => ({}),
		});

		binding.invalidate();
		expect(view.invalidate).toHaveBeenCalledOnce();
	});
});
