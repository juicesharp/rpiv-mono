import type { RecordingStatus } from "./state.ts";

export interface StatusIntentMeta {
	glyph: string;
	glyphColorKey: "error" | "warning";
	label: string;
	gatesSttPipeline: boolean;
}

export const STATUS_META: Record<RecordingStatus, StatusIntentMeta> = {
	recording: {
		glyph: "●",
		glyphColorKey: "error",
		label: "Recording",
		gatesSttPipeline: false,
	},
	paused: {
		glyph: "⏸",
		glyphColorKey: "warning",
		label: "Paused",
		gatesSttPipeline: true,
	},
};
