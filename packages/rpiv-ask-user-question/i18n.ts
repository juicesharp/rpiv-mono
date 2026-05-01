import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Params = Record<string, string | number>;
type Translate = (key: string, fallback: string, params?: Params) => string;

let translate: Translate = (_key, fallback, params) => format(fallback, params);

function format(text: string, params?: Params): string {
	if (!params) return text;
	return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? `{${key}}`));
}

export function t(key: string, fallback: string, params?: Params): string {
	return translate(key, fallback, params);
}

const bundles = [
	{
		locale: "ja",
		namespace: "rpiv-ask-user-question",
		messages: {
			"tool.label": "ユーザーに質問する",
			"tool.promptSnippet":
				"要件が曖昧なときは、最大 {maxQuestions} 個の構造化質問（各 {minOptions}-{maxOptions} 個の選択肢）をユーザーに尋ねる",
			"tool.guideline.when":
				"ユーザーの依頼が未指定で、具体的な判断なしには進めない場合は ask_user_question を使用してください。1回の呼び出しで最大 {maxQuestions} 個の質問を尋ねられます。",
			"tool.guideline.options":
				'各質問には必ず {minOptions}-{maxOptions} 個の選択肢が必要です。各選択肢には簡潔な label（1-5語）と、その選択の意味やトレードオフを説明する description が必要です。ユーザーは追加でカスタム回答を入力する（単一選択の質問には "Type something." 行が自動追加されます）か、"Chat about this" を選んで質問票をやめ、自由形式の会話に戻れます。',
			"tool.guideline.multi":
				'複数回答が有効な場合は multiSelect: true を設定してください。これにより "Type something." 行は抑制されます。選択肢により豊かな横並び文脈（モックアップ、コード断片、図、設定など）が必要な場合は options[].preview markdown 文字列を指定してください（単一選択のみ）。注意: 単一選択の質問で空でない preview が1つでもあると、横並びレイアウトにインライン自由入力の余地がないため "Type something." 行も抑制されます。"Chat about this" は escape hatch として残ります。特定の選択肢を推奨する場合は、それを最初の選択肢にし、label の末尾に "(Recommended)" を付けてください。',
			"tool.guideline.noStack":
				"これは Claude Code の AskUserQuestion tool を置き換えます。ask_user_question の呼び出しを連続で積み重ねないでください。確認質問は1回の呼び出しにまとめてください。",
		},
	},
	{
		locale: "zh-TW",
		namespace: "rpiv-ask-user-question",
		messages: {
			"tool.label": "詢問使用者問題",
			"tool.promptSnippet":
				"需求不明確時，向使用者詢問最多 {maxQuestions} 個結構化問題（每題 {minOptions}-{maxOptions} 個選項）",
			"tool.guideline.when":
				"當使用者需求未明確，而且沒有具體決策就無法繼續時，請使用 ask_user_question。每次呼叫最多可詢問 {maxQuestions} 個問題。",
			"tool.guideline.options":
				'每個問題必須有 {minOptions}-{maxOptions} 個選項。每個選項都需要簡短 label（1-5 個詞）以及說明該選擇含義或取捨的 description。使用者也可以輸入自訂答案（單選問題會自動加入 "Type something." 這一列），或選擇 "Chat about this" 放棄問卷並回到自由對話。',
			"tool.guideline.multi":
				'當多個答案都有效時，請設定 multiSelect: true；這會隱藏 "Type something." 這一列。當某個選項需要更豐富的並排上下文（mockup、程式碼片段、圖表、設定範例）時，請提供 options[].preview markdown 字串（僅限單選）。注意：單選問題只要有任何非空 preview，也會隱藏 "Type something." 這一列（並排版面沒有空間放 inline 自訂文字）；"Chat about this" 仍保留為 escape hatch。若你推薦特定選項，請把它放在第一個選項，並在 label 結尾加上 "(Recommended)"。',
			"tool.guideline.noStack":
				"這會取代 Claude Code 的 AskUserQuestion tool。不要連續堆疊多次 ask_user_question 呼叫；請把所有釐清問題合併在一次呼叫中。",
		},
	},
	{
		locale: "es",
		namespace: "rpiv-ask-user-question",
		messages: {
			"tool.label": "Preguntar al usuario",
			"tool.promptSnippet":
				"Pregunta al usuario hasta {maxQuestions} preguntas estructuradas ({minOptions}-{maxOptions} opciones cada una) cuando los requisitos sean ambiguos",
			"tool.guideline.when":
				"Usa ask_user_question cuando la petición del usuario esté poco especificada y no puedas avanzar sin decisiones concretas; puedes hacer hasta {maxQuestions} preguntas por invocación.",
			"tool.guideline.options":
				'Cada pregunta DEBE tener {minOptions}-{maxOptions} opciones. Cada opción requiere una etiqueta breve (1-5 palabras) y una descripción que explique qué significa la elección o sus trade-offs. El usuario también puede escribir una respuesta personalizada (la fila "Type something." se añade automáticamente a preguntas de selección única) o elegir "Chat about this" para abandonar el cuestionario y continuar en conversación libre.',
			"tool.guideline.multi":
				'Usa multiSelect: true cuando varias respuestas sean válidas; esto oculta la fila "Type something.". Proporciona un string markdown en options[].preview cuando una opción se beneficie de contexto lado a lado más rico (mockups, snippets de código, diagramas, configs), solo para selección única. NOTA: cualquier preview no vacío en una pregunta de selección única también oculta la fila "Type something." (no hay espacio para texto personalizado inline en el layout lado a lado); "Chat about this" sigue siendo la vía de escape. Si recomiendas una opción específica, ponla primero y añade "(Recommended)" al final de la etiqueta.',
			"tool.guideline.noStack":
				"Esto reemplaza la herramienta AskUserQuestion de Claude Code. No encadenes varias llamadas ask_user_question seguidas; agrupa todas las preguntas aclaratorias en una sola invocación.",
		},
	},
];

export function initI18n(pi: ExtensionAPI): void {
	const events = pi.events;
	if (!events) return;
	for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
	events.emit("pi-core/i18n/requestApi", {
		namespace: "rpiv-ask-user-question",
		callback(api: { t?: Translate } | undefined) {
			if (typeof api?.t === "function") translate = api.t;
		},
	});
}
