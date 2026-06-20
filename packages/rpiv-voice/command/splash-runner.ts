import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SPLASH_FRAME_INTERVAL_MS,
	SPLASH_FRAMES,
	type SplashPhase,
	SplashView,
} from "../view/components/splash-view.js";

export interface SplashController {
	setPhase(phase: SplashPhase): void;
}

export interface SplashRunnerConfig {
	initialPhase: SplashPhase;
}

export async function runWithSplash<T>(
	ctx: ExtensionContext,
	config: SplashRunnerConfig,
	work: (controller: SplashController) => Promise<T>,
): Promise<T> {
	let workResult: T | undefined;
	let workError: unknown;

	// Render inline (replace the editor) rather than as a bottom-anchored overlay.
	// Bottom-anchored overlays force pi-tui to pad the chat buffer to the full
	// terminal height, which pushes short chat content to the very top of the
	// screen and leaves a large gap above the overlay. Inline mode keeps the
	// component in the chat flow — it appears exactly where the editor was.
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const splash = new SplashView(theme);
		let phase: SplashPhase = config.initialPhase;
		let frame = 0;
		splash.setProps({ phase, frame });

		const tick = setInterval(() => {
			frame = (frame + 1) % SPLASH_FRAMES.length;
			splash.setProps({ phase, frame });
			tui.requestRender();
		}, SPLASH_FRAME_INTERVAL_MS);

		const controller: SplashController = {
			setPhase(next: SplashPhase) {
				phase = next;
				splash.setProps({ phase, frame });
				tui.requestRender();
			},
		};

		work(controller).then(
			(result) => {
				workResult = result;
				clearInterval(tick);
				done(undefined);
			},
			(err) => {
				workError = err;
				clearInterval(tick);
				done(undefined);
			},
		);

		return {
			render: (w: number) => splash.render(w),
			invalidate: () => splash.setProps({ phase, frame }),
			handleInput: (_d: string) => {},
		};
	});

	if (workError) throw workError;
	return workResult as T;
}
