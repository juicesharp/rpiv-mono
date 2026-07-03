import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { AskUserQuestionConfig } from "./config.js";

/**
 * Integration tests for the raw `ctx.ui.onTerminalInput` collapse listener.
 * The factory tests drive the component `handleInput` path (the fallback when
 * no raw listener is available); these drive the listener path that pi-tui
 * needs while the overlay is hidden, using the real QuestionnaireSession via
 * the `ctx.ui.custom` factory and a fake OverlayHandle.
 */

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

const CTRL_RBRACKET = "\x1d"; // GS byte — what terminals send for Ctrl+]
const ALT_O = "\x1bo"; // ESC-prefixed 'o' — legacy encoding for Alt+O

const params = {
	questions: [
		{
			question: "Pick one",
			header: "Choice",
			options: [{ label: "Alpha" }, { label: "Beta" }],
		},
	],
};

interface FakeHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(): void;
	isFocused(): boolean;
}

function makeHandle(over: { isFocused?: () => boolean } = {}): FakeHandle {
	let hidden = false;
	return {
		hide: () => {},
		focus: () => {},
		unfocus: () => {},
		setHidden: (h: boolean) => {
			hidden = h;
		},
		isHidden: () => hidden,
		// Mirrors pi-tui: a visible questionnaire overlay normally has focus;
		// a hidden one never does. Overridable for the other-overlay-on-top case.
		isFocused: over.isFocused ?? (() => !hidden),
	};
}

type RawListener = (data: string) => { consume?: boolean } | undefined;

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/**
 * Fake `ctx.ui` that mimics interactive-mode wiring: `onTerminalInput` captures
 * the raw listener, `custom` runs the real factory then hands out the overlay
 * handle via `onHandle`, and `script` drives the interaction before resolving.
 */
function driveWithListener(handle: FakeHandle, script: (done: (v: unknown) => void) => void) {
	const notify = vi.fn();
	const removeListener = vi.fn();
	const listenerRef: { current: RawListener | undefined } = { current: undefined };
	const onTerminalInput = vi.fn((h: RawListener) => {
		listenerRef.current = h;
		return removeListener;
	});
	const custom = vi.fn(
		(
			factory: (
				tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
				theme: typeof identityTheme,
				kb: undefined,
				done: (v: unknown) => void,
			) => unknown,
			options?: { onHandle?: (handle: FakeHandle) => void },
		) => {
			return new Promise((resolve) => {
				factory(
					{ requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } },
					identityTheme,
					undefined,
					resolve,
				);
				options?.onHandle?.(handle);
				script(resolve);
			});
		},
	);
	const ctx = { hasUI: true, ui: { custom, onTerminalInput, notify } } as never;
	return { ctx, notify, onTerminalInput, removeListener, listenerRef };
}

const home = process.env.HOME ?? "";
const configDir = join(home, ".config", "rpiv-ask-user-question");
const configPath = join(configDir, "config.json");

function writeCollapseKeyConfig(collapseKey: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify({ collapseKey } satisfies AskUserQuestionConfig));
}

afterEach(() => {
	if (existsSync(configPath)) rmSync(configPath);
});

describe("ask_user_question — raw terminal collapse listener", () => {
	it("hides via OverlayHandle.setHidden, notifies once, and unhides on the second press", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, notify, removeListener, listenerRef } = driveWithListener(handle, (done) => {
			// First press: hide + one-shot notification with the reopen key.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("press ctrl+] to reopen"), "info");
			// Second press: unhide, and the notification stays one-shot.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(false);
			// Third round-trip re-hides without a second announcement.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(notify).toHaveBeenCalledTimes(1);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		// execute's finally must tear the raw listener down once the tool resolves.
		expect(removeListener).toHaveBeenCalledTimes(1);
	});

	it("ignores non-matching keys", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, notify, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.("x")).toBeUndefined();
			expect(listenerRef.current?.(ALT_O)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(notify).not.toHaveBeenCalled();
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("leaves the key to another focused overlay (visible but unfocused questionnaire)", async () => {
		const tool = register();
		// e.g. `/btw` opened on top: the questionnaire is visible underneath but
		// not focused — the listener must not toggle it from under the top overlay.
		const handle = makeHandle({ isFocused: () => false });
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("honours a configured collapseKey (alt+o toggles, ctrl+] does not)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const handle = makeHandle();
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(listenerRef.current?.(ALT_O)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("does not register a listener when collapseKey is 'off'", async () => {
		writeCollapseKeyConfig("off");
		const tool = register();
		const handle = makeHandle();
		const { ctx, onTerminalInput } = driveWithListener(handle, (done) => {
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(onTerminalInput).not.toHaveBeenCalled();
	});
});
