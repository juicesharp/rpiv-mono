import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import {
	ASK_USER_ANSWER_EVENT,
	ASK_USER_ANSWER_RESULT_EVENT,
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserAnswerResultEventPayload,
	type AskUserPromptEventPayload,
} from "./events.js";

/**
 * The inbound `rpiv:ask-user:answer` event end to end, on Pi's real event bus
 * (`createEventBus`: listeners run synchronously inside `emit`, and a throwing
 * listener is logged, not propagated). `ui.custom` mirrors interactive mode's
 * `showExtensionCustom`: the factory runs synchronously inside `custom()`, and
 * `close` settles once.
 */

type Close = (result: unknown) => void;
type Component = { handleInput(data: string): void };

const CONFIRM = "tui.select.confirm";
const keybindings = { matches: (data: string, name: string) => data === name };
const tui = { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() };

const question = (header: string, multiSelect = false) => ({
	question: `${header}?`,
	header,
	multiSelect,
	options: [
		{ label: "A", description: "a" },
		{ label: "B", description: "b" },
	],
});

/** Interactive mode's `custom()`; `defer` holds the factory back, like a host that mounts later. */
function hostCustom(mounted: Component[], defer?: Array<() => void>) {
	return vi.fn(
		(factory: (...args: unknown[]) => unknown) =>
			new Promise((resolve) => {
				let closed = false;
				const close: Close = (result) => {
					if (closed) return;
					closed = true;
					resolve(result);
				};
				const mount = () => {
					const component = factory(tui, makeTheme(), keybindings, close) as Component;
					if (!closed) mounted.push(component);
				};
				if (defer) defer.push(mount);
				else mount();
			}),
	);
}

function harness(opts: { mode?: string; defer?: boolean; ui?: Record<string, unknown> } = {}) {
	const bus = createEventBus();
	const seen: Array<{ channel: string; data: unknown }> = [];
	for (const channel of [ASK_USER_PROMPT_EVENT, ASK_USER_BLOCKED_EVENT, ASK_USER_ANSWER_RESULT_EVENT]) {
		bus.on(channel, (data: unknown) => {
			seen.push({ channel, data });
		});
	}
	const { pi, captured } = createMockPi({ events: bus } as never);
	registerAskUserQuestionTool(pi);
	const tool = captured.tools.get("ask_user_question")!;
	const mounted: Component[] = [];
	const deferred: Array<() => void> = [];
	const custom = hostCustom(mounted, opts.defer ? deferred : undefined);
	const ctx = createMockCtx({
		hasUI: true,
		mode: opts.mode ?? "tui",
		ui: { custom, onTerminalInput: vi.fn(() => () => {}), ...opts.ui } as never,
	});
	const run = (toolCallId: string, questions: unknown[]) =>
		tool.execute?.(
			toolCallId,
			{ questions } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		) as Promise<{
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
		}>;
	const answer = (payload: unknown) => bus.emit(ASK_USER_ANSWER_EVENT, payload);
	const verdicts = () =>
		seen
			.filter((e) => e.channel === ASK_USER_ANSWER_RESULT_EVENT)
			.map((e) => e.data as AskUserAnswerResultEventPayload);
	const on = (channel: string) => seen.filter((e) => e.channel === channel).map((e) => e.data);
	return { bus, run, answer, verdicts, on, mounted, deferred, custom };
}

const pick = (toolCallId: string, index: number, extra: Record<string, unknown> = {}) => ({
	toolCallId,
	answers: [{ questionIndex: 0, optionIndexes: [index] }],
	...extra,
});

describe("rpiv:ask-user:answer — targeting by toolCallId", () => {
	it("prompt and blocked events carry the tool call id the answer names", async () => {
		const h = harness();
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(1));
		expect((h.on(ASK_USER_PROMPT_EVENT)[0] as AskUserPromptEventPayload).toolCallId).toBe("call-1");
		h.answer(pick("call-1", 1, { requestId: "r1" }));
		const result = await done;
		expect(result.content[0]!.text).toContain('"One?"="B"');
		expect(h.verdicts()).toEqual([{ ok: true, requestId: "r1", toolCallId: "call-1" }]);
		expect(h.on(ASK_USER_BLOCKED_EVENT)).toEqual([
			{ active: true, toolCallId: "call-1" },
			{ active: false, toolCallId: "call-1" },
		]);
	});

	it("answers the named questionnaire when several are open, whatever the mount order", async () => {
		const h = harness();
		const db = h.run("call-db", [question("Database")]);
		const deploy = h.run("call-deploy", [question("Deploy")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(2));

		h.answer(pick("call-db", 1)); // the OLDER one — the inline dialog under the overlay
		expect((await db).content[0]!.text).toContain('"Database?"="B"');
		h.answer(pick("call-deploy", 0));
		expect((await deploy).content[0]!.text).toContain('"Deploy?"="A"');
		expect(h.verdicts().map((v) => [v.ok, v.toolCallId])).toEqual([
			[true, "call-db"],
			[true, "call-deploy"],
		]);
	});

	it("is not_found for an unknown id, and leaves the open one untouched", async () => {
		const h = harness();
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(1));
		h.answer(pick("call-other", 0));
		expect(h.verdicts().at(-1)).toMatchObject({ ok: false, code: "not_found", toolCallId: "call-other" });
		h.answer(pick("call-1", 0));
		await done;
	});

	it("is not_found when nothing is open", () => {
		const h = harness();
		h.answer(pick("call-1", 0, { requestId: "idle" }));
		expect(h.verdicts()).toEqual([
			{
				ok: false,
				code: "not_found",
				reason: expect.any(String),
				requestId: "idle",
				toolCallId: "call-1",
			},
		]);
	});
});

describe("rpiv:ask-user:answer — when an answer counts", () => {
	it("accepts an answer sent from the prompt listener, before the dialog mounts — no dialog is shown", async () => {
		const h = harness();
		h.bus.on(ASK_USER_PROMPT_EVENT, (p: unknown) => {
			h.answer(pick((p as AskUserPromptEventPayload).toolCallId!, 1));
		});
		const result = await h.run("call-1", [question("One")]);
		expect(result.content[0]!.text).toContain('"One?"="B"');
		expect(h.verdicts()).toEqual([{ ok: true, toolCallId: "call-1" }]);
		expect(h.custom).not.toHaveBeenCalled();
		// Still one closing bracket for the prompt, so every mirror of it can dismiss.
		expect(h.on(ASK_USER_BLOCKED_EVENT)).toEqual([
			{ active: true, toolCallId: "call-1" },
			{ active: false, toolCallId: "call-1" },
		]);
	});

	it("a host that mounts late closes the dialog on sight with the earlier answer", async () => {
		const h = harness({ defer: true });
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.deferred).toHaveLength(1));
		h.answer(pick("call-1", 0));
		expect((await done).content[0]!.text).toContain('"One?"="A"');
		h.deferred[0]!(); // the host mounts now: the factory closes at once
		expect(h.mounted).toHaveLength(0);
	});

	it("first answer wins: a second inbound answer is refused, not reported as applied", async () => {
		const h = harness();
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(1));
		h.answer(pick("call-1", 0, { requestId: "first" }));
		h.answer(pick("call-1", 1, { requestId: "second" }));
		expect((await done).content[0]!.text).toContain('"One?"="A"');
		expect(h.verdicts().map((v) => [v.requestId, v.ok, v.code])).toEqual([
			["first", true, undefined],
			["second", false, "not_found"],
		]);
	});

	it("first answer wins: after the user answers in the terminal, an inbound answer is refused", async () => {
		const h = harness();
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(1));
		h.mounted[0]!.handleInput(CONFIRM); // the user picks the focused option, A
		h.answer(pick("call-1", 1));
		expect((await done).content[0]!.text).toContain('"One?"="A"');
		expect(h.verdicts()).toEqual([
			{ ok: false, code: "not_found", reason: expect.any(String), toolCallId: "call-1" },
		]);
	});
});

describe("rpiv:ask-user:answer — payloads", () => {
	it("every malformed payload still gets a verdict, and the dialog stays open", async () => {
		const err = vi.spyOn(console, "error");
		const h = harness();
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(1));
		const bad: unknown[] = [
			undefined,
			"nope",
			[],
			{ answers: [] },
			{ toolCallId: 7 },
			{ toolCallId: "call-1", requestId: 5, answers: [] },
			{ toolCallId: "call-1", answers: "nope" },
			{ toolCallId: "call-1", answers: [null] },
			{ toolCallId: "call-1", answers: [{ questionIndex: 0, optionIndexes: 1 }] },
			{ toolCallId: "call-1", answers: [{ questionIndex: 0, optionIndexes: [0], notes: { a: 1 } }] },
			{ toolCallId: "call-1", cancel: "yes" },
		];
		for (const payload of bad) h.answer(payload);
		expect(h.verdicts()).toHaveLength(bad.length);
		expect(new Set(h.verdicts().map((v) => v.code))).toEqual(new Set(["invalid_payload"]));
		expect(err).not.toHaveBeenCalled();
		h.answer(pick("call-1", 0));
		expect((await done).content[0]!.text).toContain('"One?"="A"');
		err.mockRestore();
	});

	it("cancel declines the questionnaire, as Esc does", async () => {
		const h = harness();
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(1));
		h.answer({ toolCallId: "call-1", cancel: true, globalNote: "nobody is around" });
		const result = await done;
		expect(result.content[0]!.text).toBe("User declined to answer questions");
		expect(result.details).toEqual({ answers: [], cancelled: true, globalNote: "nobody is around" });
	});

	it("globalNote and per-question notes reach the model like the TUI's", async () => {
		const h = harness();
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.mounted).toHaveLength(1));
		h.answer({
			toolCallId: "call-1",
			answers: [{ questionIndex: 0, optionIndexes: [1], notes: " keep it small " }],
			globalNote: "ship today",
		});
		const text = (await done).content[0]!.text;
		expect(text).toContain('"One?"="B". user notes: keep it small.');
		expect(text).toContain("global note: ship today.");
	});
});

describe("rpiv:ask-user:answer — hosts", () => {
	it("an RPC host's own dialogs cannot be answered: unsupported_host", async () => {
		let resolveSelect: (v: string | undefined) => void = () => {};
		const h = harness({
			mode: "rpc",
			ui: {
				select: vi.fn(() => new Promise((r) => (resolveSelect = r))),
				input: vi.fn(),
				notify: vi.fn(),
			},
		});
		const done = h.run("call-1", [question("One")]);
		await vi.waitFor(() => expect(h.on(ASK_USER_BLOCKED_EVENT)).toHaveLength(1));
		h.answer(pick("call-1", 0));
		expect(h.verdicts().at(-1)).toMatchObject({ ok: false, code: "unsupported_host", toolCallId: "call-1" });
		resolveSelect(undefined);
		await done;
	});
});
