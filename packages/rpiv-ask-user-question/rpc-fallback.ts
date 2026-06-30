/**
 * RPC / non-TUI fallback for `ask_user_question`.
 *
 * Why this exists: the canonical TUI path (`ctx.ui.custom()`) renders an
 * interactive tabbed overlay dialog that requires a real terminal. In RPC
 * mode (e.g. the VSCode pendant embeds pi via the JSON-over-stdio protocol),
 * `ctx.hasUI` is `true` but `ctx.ui.custom()` returns `undefined` (see
 * pi-coding-agent docs/rpc.md → "Extension UI Protocol"), which the shared
 * `buildQuestionnaireResponse` collapses into DECLINE_MESSAGE — so the model
 * saw "User declined to answer questions" even though the user was never
 * shown a prompt.
 *
 * This fallback uses `ctx.ui.select()` / `ctx.ui.input()`, which ARE
 * functional in RPC mode via the `extension_ui_request` /
 * `extension_ui_response` sub-protocol (the pendant renders them natively).
 * It walks the questions sequentially and builds a `QuestionnaireResult`
 * with the same answer shapes the TUI produces, so the shared
 * `buildQuestionnaireResponse` envelope is identical.
 *
 * Trade-off vs the TUI: no side-by-side preview pane and no multi-tab
 * review — option descriptions and previews are folded into the prompt
 * title, and multi-select is a single free-text "comma-separated numbers"
 * input. Single-select keeps a real native dropdown.
 */

import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./tool/types.js";

/** Sentinel labels — must match `state/row-intent.ts` `other.label` / `chat.label`. */
const TYPE_SOMETHING = "Type something.";
const CHAT_ABOUT_THIS = "Chat about this.";

/**
 * Minimal structural slice of ExtensionContext we need. Kept structural so
 * this module has no hard type dependency on the pi package's ctx shape
 * (jiti transpiles without type-checking; this only documents intent).
 */
type RpcCtx = {
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
	};
};

/** Parse the leading "N." index from a formatted option string. Returns 0-based index or null. */
function parseLeadingIndex(value: string | undefined | null, count: number): number | null {
	if (!value) return null;
	const m = value.match(/^\s*(\d+)/);
	if (!m) return null;
	const i = parseInt(m[1], 10) - 1;
	return i >= 0 && i < count ? i : null;
}

/** Build the single-select option strings: "N. label — description" plus the two sentinels. */
function buildSingleSelectOptions(question: QuestionParams["questions"][number]): { options: string[]; nReal: number } {
	const options = question.options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`);
	const nReal = question.options.length;
	options.push(`${nReal + 1}. ${TYPE_SOMETHING}`);
	options.push(`${nReal + 2}. ${CHAT_ABOUT_THIS}`);
	return { options, nReal };
}

/** Compact preview block appended to the title so the user can still read previews in RPC. */
function buildPreviewBlock(question: QuestionParams["questions"][number]): string {
	const withPreview = question.options.filter((o) => typeof o.preview === "string" && o.preview.length > 0);
	if (withPreview.length === 0) return "";
	const blocks = question.options
		.map((o, i) =>
			typeof o.preview === "string" && o.preview.length > 0
				? `--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, 600)}`
				: "",
		)
		.filter(Boolean);
	return blocks.length ? `\n\n${blocks.join("\n\n")}` : "";
}

/**
 * Run the questionnaire in RPC / non-TUI mode. Sequential; returns the
 * collected answers. `cancelled: true` only on dismissal or "Chat about this"
 * is NOT set — chat records a `kind: "chat"` answer (matching TUI semantics
 * so the envelope emits the chat-continuation message, not DECLINE).
 */
export async function runRpcQuestionnaire(ctx: RpcCtx, params: QuestionParams): Promise<QuestionnaireResult> {
	const answers: QuestionAnswer[] = [];

	for (let qi = 0; qi < params.questions.length; qi++) {
		const q = params.questions[qi];
		const header = q.header ? `[${q.header}] ` : "";

		if (q.multiSelect) {
			// multi-select: no native multi-pick in RPC; use free-text input.
			const list = q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`).join("\n");
			const title =
				`${header}${q.question}\n\n${list}\n\n` +
				`Enter the numbers of all that apply, comma-separated (e.g. "1,3"). ` +
				`Type "chat" to talk it over instead.`;
			const val = await ctx.ui.input(title, "1,3");
			if (val == null) {
				// dismissed / cancelled mid-questionnaire
				return { answers, cancelled: true };
			}
			const trimmed = val.trim();
			if (/^chat\b/i.test(trimmed) || trimmed.toLowerCase() === "chat") {
				answers.push({
					questionIndex: qi,
					question: q.question,
					kind: "chat",
					answer: CHAT_ABOUT_THIS,
				});
				return { answers, cancelled: false };
			}
			const selected: string[] = [];
			for (const part of trimmed.split(/[,\s]+/)) {
				const idx = parseLeadingIndex(part, q.options.length);
				if (idx != null) {
					const label = q.options[idx].label;
					if (!selected.includes(label)) selected.push(label);
				}
			}
			answers.push({
				questionIndex: qi,
				question: q.question,
				kind: "multi",
				answer: null,
				selected,
			});
			continue;
		}

		// single-select: native dropdown via ctx.ui.select()
		const { options: selectOpts, nReal } = buildSingleSelectOptions(q);
		const title = `${header}${q.question}${buildPreviewBlock(q)}`;
		const val = await ctx.ui.select(title, selectOpts);
		if (val == null) {
			// dismissed / cancelled mid-questionnaire
			return { answers, cancelled: true };
		}
		const idx = parseLeadingIndex(val, nReal + 2);
		if (idx == null) {
			// unexpected value — treat as dismissed
			return { answers, cancelled: true };
		}
		if (idx < nReal) {
			const o = q.options[idx];
			answers.push({
				questionIndex: qi,
				question: q.question,
				kind: "option",
				answer: o.label,
				preview: typeof o.preview === "string" && o.preview.length > 0 ? o.preview : undefined,
			});
		} else if (idx === nReal) {
			// "Type something." → free-text follow-up
			const custom = await ctx.ui.input(`${header}${q.question}\n\nType your answer:`, "");
			if (custom == null) {
				return { answers, cancelled: true };
			}
			answers.push({
				questionIndex: qi,
				question: q.question,
				kind: "custom",
				answer: custom,
			});
		} else {
			// "Chat about this." → record chat answer, stop (abandon to free-form chat)
			answers.push({
				questionIndex: qi,
				question: q.question,
				kind: "chat",
				answer: CHAT_ABOUT_THIS,
			});
			return { answers, cancelled: false };
		}
	}

	return { answers, cancelled: false };
}
