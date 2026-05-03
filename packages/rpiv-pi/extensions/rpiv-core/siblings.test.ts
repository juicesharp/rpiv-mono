import { describe, expect, it } from "vitest";
import { LEGACY_SIBLINGS, SIBLINGS } from "./siblings.js";

describe("SIBLINGS registry", () => {
	it("contains 8 entries (pi-subagents at SIBLINGS[0] — tintinweb fork is the dispatch runtime)", () => {
		expect(SIBLINGS).toHaveLength(8);
	});

	it("lists @tintinweb/pi-subagents at SIBLINGS[0]", () => {
		expect(SIBLINGS[0]?.pkg).toBe("npm:@tintinweb/pi-subagents");
	});

	it("does NOT list nicobailon's unscoped pi-subagents (superseded in 0.14.0)", () => {
		expect(SIBLINGS.find((s) => s.pkg === "npm:pi-subagents")).toBeUndefined();
	});

	for (const s of SIBLINGS) {
		it(`${s.pkg} — self-match against settings.json line shape`, () => {
			expect(s.matches.test(s.pkg.replace(/^npm:/, ""))).toBe(true);
		});
		it(`${s.pkg} — case-insensitive match`, () => {
			expect(s.matches.test(s.pkg.toUpperCase().replace(/^NPM:/, ""))).toBe(true);
		});
	}

	it("rpiv-args does NOT match rpiv-args-extended (word boundary)", () => {
		const argsEntry = SIBLINGS.find((s) => s.pkg.endsWith("/rpiv-args"));
		expect(argsEntry).toBeDefined();
		expect(argsEntry?.matches.test("@juicesharp/rpiv-args-extended")).toBe(false);
	});

	it("rpiv-i18n does NOT match rpiv-i18n-utils (word boundary)", () => {
		const i18nEntry = SIBLINGS.find((s) => s.pkg.endsWith("/rpiv-i18n"));
		expect(i18nEntry).toBeDefined();
		expect(i18nEntry?.matches.test("@juicesharp/rpiv-i18n-utils")).toBe(false);
		expect(i18nEntry?.matches.test("@juicesharp/rpiv-i18n")).toBe(true);
	});

	it("every entry has non-empty pkg + provides", () => {
		for (const s of SIBLINGS) {
			expect(s.pkg.length).toBeGreaterThan(0);
			expect(s.provides.length).toBeGreaterThan(0);
		}
	});
});

describe("LEGACY_SIBLINGS registry", () => {
	it("lists nicobailon's pi-subagents for pruning (superseded by @tintinweb/pi-subagents in 0.14.0)", () => {
		const entry = LEGACY_SIBLINGS.find((l) => l.label === "pi-subagents");
		expect(entry).toBeDefined();
		expect(entry?.matches.test("npm:pi-subagents")).toBe(true);
		expect(entry?.matches.test("pi-subagents")).toBe(true);
	});

	it("pi-subagents legacy match does NOT catch @tintinweb/pi-subagents (active sibling)", () => {
		const piSubagents = LEGACY_SIBLINGS.find((l) => l.label === "pi-subagents");
		expect(piSubagents?.matches.test("@tintinweb/pi-subagents")).toBe(false);
	});

	it("pi-subagents legacy match does NOT catch pi-subagents-legacy (word boundary)", () => {
		const piSubagents = LEGACY_SIBLINGS.find((l) => l.label === "pi-subagents");
		expect(piSubagents?.matches.test("pi-subagents-legacy")).toBe(false);
	});
});
