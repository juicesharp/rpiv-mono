/**
 * rpiv-ask-user-question — Pi extension. Registers the `ask_user_question`
 * tool: a structured option selector with a free-text "Other" fallback.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { initI18n } from "./i18n.js";

export default function (pi: ExtensionAPI) {
	initI18n(pi);
	registerAskUserQuestionTool(pi);
}
