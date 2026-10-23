import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLoadedSiblingSources } from "./loaded-siblings.ts";

const ARGS_MARKER = "@juicesharp/rpiv-args:loaded";
const slots = globalThis as Record<symbol, unknown>;

const host = (tools: unknown[], commands: unknown[]) => ({
	getAllTools: () => tools as never,
	getCommands: () => commands as never,
});

describe("readLoadedSiblingSources (#216)", () => {
	// The marker is process-global: start and finish each test without it.
	beforeEach(() => {
		delete slots[Symbol.for(ARGS_MARKER)];
	});
	afterEach(() => {
		delete slots[Symbol.for(ARGS_MARKER)];
	});

	it("collects tool paths and EXTENSION command paths only", () => {
		const snapshot = readLoadedSiblingSources(
			host(
				[{ name: "todo", sourceInfo: { path: "/kit/@juicesharp/rpiv-todo/index.ts" } }],
				[
					{ name: "wf", source: "extension", sourceInfo: { path: "/kit/@juicesharp/rpiv-workflow/index.ts" } },
					{ name: "notes", source: "skill", sourceInfo: { path: "/u/skills/rpiv-advisor-notes/SKILL.md" } },
					{ name: "p", source: "prompt", sourceInfo: { path: "/u/prompts/rpiv-web-tools.md" } },
				],
			),
		);
		expect(snapshot.extensionPaths).toEqual([
			"/kit/@juicesharp/rpiv-todo/index.ts",
			"/kit/@juicesharp/rpiv-workflow/index.ts",
		]);
	});

	it("tolerates entries without sourceInfo", () => {
		const snapshot = readLoadedSiblingSources(host([{ name: "x" }], [{ name: "y", source: "extension" }]));
		expect(snapshot.extensionPaths).toEqual([]);
	});

	it("a host that throws yields an empty snapshot (settings-only fallback)", () => {
		const snapshot = readLoadedSiblingSources({
			getAllTools: () => {
				throw new Error("no runtime");
			},
			getCommands: () => [],
		});
		expect(snapshot.extensionPaths).toEqual([]);
	});

	it("reads the rpiv-args presence marker from globalThis", () => {
		expect(readLoadedSiblingSources(host([], [])).markers.has(ARGS_MARKER)).toBe(false);
		slots[Symbol.for(ARGS_MARKER)] = true;
		expect(readLoadedSiblingSources(host([], [])).markers.has(ARGS_MARKER)).toBe(true);
	});
});
