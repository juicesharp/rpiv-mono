import type { AskUserQuestionConfig } from "./config.js";
import { loadConfig, resolveJevConfig } from "./config.js";

/** Mutable session-local switch shared by the command, tool, and reconciler. */
export interface AutoAnswerState {
	enabled: boolean;
}

export function createAutoAnswerState(config: AskUserQuestionConfig = loadConfig()): AutoAnswerState {
	return { enabled: resolveJevConfig(config).autoAnswer };
}
