import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

import { SplashView } from "./splash-view.js";

const tagged = {
	...makeTheme({
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	}),
	boxSharp: { horizontal: "─" },
} as unknown as Theme;
const WIDTH = 80;

function renderLast(view: SplashView): string {
	const lines = view.render(WIDTH);
	return lines[lines.length - 1] ?? "";
}

describe("SplashView download progress rendering", () => {
	it("appends percent and byte counter when Content-Length is known", () => {
		const view = new SplashView(tagged);
		view.setProps({
			phase: {
				kind: "downloading",
				message: "Downloading…",
				percent: 42,
				bytesReceived: 1024 * 1024 * 80,
				totalBytes: 1024 * 1024 * 200,
			},
			frame: 0,
		});
		const line = renderLast(view);
		expect(line).toContain("Downloading…");
		expect(line).toContain("42%");
		expect(line).toContain("80.0 MB");
		expect(line).toContain("200.0 MB");
	});

	it("falls back to a bare byte counter when totalBytes is unknown", () => {
		const view = new SplashView(tagged);
		view.setProps({
			phase: {
				kind: "downloading",
				message: "Downloading…",
				bytesReceived: 1024 * 1024 * 12,
				// no totalBytes / percent
			},
			frame: 0,
		});
		const line = renderLast(view);
		expect(line).toContain("12.0 MB");
		expect(line).not.toContain("%");
	});

	it("renders the bare label before the first byte arrives", () => {
		const view = new SplashView(tagged);
		view.setProps({
			phase: { kind: "downloading", message: "Downloading…" },
			frame: 0,
		});
		const line = renderLast(view);
		expect(line).toContain("Downloading…");
		expect(line).not.toContain("%");
		expect(line).not.toContain("MB");
	});

	it("does not decorate non-downloading phases", () => {
		const view = new SplashView(tagged);
		view.setProps({
			phase: { kind: "extracting", message: "Extracting model files…" },
			frame: 0,
		});
		const line = renderLast(view);
		expect(line).toContain("Extracting model files…");
		expect(line).not.toContain("%");
		expect(line).not.toContain("MB");
	});
});
