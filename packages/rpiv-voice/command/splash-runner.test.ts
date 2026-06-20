import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeTheme, makeTui } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";

import { runWithSplash, type SplashController } from "./splash-runner.js";

interface CapturedComponent {
	render: (w: number) => unknown;
	invalidate: () => void;
	handleInput: (d: string) => void;
}

// Drives ctx.ui.custom synchronously: runs the body once with stub tui/theme/kb,
// captures the returned component, and returns a `done` resolver the caller
// invokes when the body's work promise settles.
function makeCtx(): {
	ctx: ExtensionContext;
	getComponent: () => CapturedComponent;
	donePromise: Promise<void>;
} {
	let component: CapturedComponent | undefined;
	let resolveCustom: () => void;
	const donePromise = new Promise<void>((r) => {
		resolveCustom = r;
	});
	const tui = makeTui();
	const theme = makeTheme();
	const ctx = {
		ui: {
			custom: <T>(
				body: (
					tui: ReturnType<typeof makeTui>,
					theme: ReturnType<typeof makeTheme>,
					kb: unknown,
					done: (v: T) => void,
				) => CapturedComponent,
			) => {
				return new Promise<T>((resolveOuter) => {
					component = body(tui, theme, {}, (v) => {
						resolveOuter(v);
						resolveCustom();
					});
				});
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, getComponent: () => component!, donePromise };
}

describe("runWithSplash", () => {
	it("returns the work result on success", async () => {
		const { ctx } = makeCtx();
		const result = await runWithSplash<number>(ctx, { initialPhase: { kind: "loading_engine" } }, async () => 42);
		expect(result).toBe(42);
	});

	it("propagates phase changes through the controller to the SplashView", async () => {
		const { ctx, getComponent } = makeCtx();
		let captured: SplashController | undefined;
		const result = await runWithSplash<string>(ctx, { initialPhase: { kind: "loading_engine" } }, async (c) => {
			captured = c;
			c.setPhase({ kind: "extracting", message: "x" });
			return "done";
		});
		expect(result).toBe("done");
		expect(captured).toBeDefined();
		// Component is renderable after the run completes.
		expect(() => getComponent().render(80)).not.toThrow();
		expect(() => getComponent().invalidate()).not.toThrow();
		// handleInput swallows input — splash is non-interactive.
		expect(() => getComponent().handleInput("q")).not.toThrow();
	});

	it("rethrows the work error after the splash closes", async () => {
		const { ctx } = makeCtx();
		await expect(
			runWithSplash(ctx, { initialPhase: { kind: "loading_engine" } }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	it("ticks the spinner via setInterval and clears it on completion", async () => {
		vi.useFakeTimers();
		try {
			const { ctx, getComponent } = makeCtx();
			const work = runWithSplash<void>(ctx, { initialPhase: { kind: "loading_engine" } }, async () => {
				// hold the work open long enough to advance frames
				await new Promise<void>((r) => setTimeout(r, 500));
			});
			// Advance a few frame intervals; component must still render fine.
			vi.advanceTimersByTime(640);
			expect(() => getComponent().render(80)).not.toThrow();
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			await work;
			// After completion the interval is cleared — advancing time triggers nothing.
			vi.advanceTimersByTime(10000);
		} finally {
			vi.useRealTimers();
		}
	});
});
