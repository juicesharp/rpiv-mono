import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { formatOverlayTaskLine } from "./format.js";

const recordingTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	strikethrough: (text: string) => `<strike>${text}</strike>`,
} as unknown as Theme;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: 1,
		subject: "quiet task",
		status: "pending",
		...overrides,
	};
}

describe("formatOverlayTaskLine — semantic color hierarchy", () => {
	it("keeps pending subjects primary while rendering IDs quietly", () => {
		expect(formatOverlayTaskLine(task(), recordingTheme, true)).toBe(
			"<dim>○</dim> <dim>#1</dim> <text>quiet task</text>",
		);
	});

	it("emphasizes the current task while muting its supporting metadata", () => {
		expect(
			formatOverlayTaskLine(
				task({ status: "in_progress", activeForm: "Working", blockedBy: [2, 3] }),
				recordingTheme,
				true,
			),
		).toBe(
			"<warning>◐</warning> <dim>#1</dim> <accent>quiet task</accent> <muted>(Working)</muted> <muted>⛓ #2,#3</muted>",
		);
	});

	it("mutes and strikes completed subjects", () => {
		expect(formatOverlayTaskLine(task({ status: "completed" }), recordingTheme, false)).toBe(
			"<success>✓</success> <strike><muted>quiet task</muted></strike>",
		);
	});
});
