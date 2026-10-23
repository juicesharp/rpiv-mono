import { describe, expect, it } from "vitest";
import type { RecordingStatus } from "./state.ts";
import { STATUS_META } from "./status-intent.ts";

describe("STATUS_META", () => {
	it("has an entry for every RecordingStatus", () => {
		const kinds: RecordingStatus[] = ["recording", "paused"];
		for (const k of kinds) expect(STATUS_META[k]).toBeDefined();
	});

	it("only 'paused' gates the STT pipeline", () => {
		expect(STATUS_META.recording.gatesSttPipeline).toBe(false);
		expect(STATUS_META.paused.gatesSttPipeline).toBe(true);
	});
});
