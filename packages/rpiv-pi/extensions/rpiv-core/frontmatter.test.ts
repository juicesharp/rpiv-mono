import { describe, expect, it } from "vitest";
import { parseFrontmatterBounds } from "./frontmatter.js";

describe("parseFrontmatterBounds", () => {
	it("returns bounds for well-formed frontmatter", () => {
		const content = ["---", "name: test", "---", "body"].join("\n");
		expect(parseFrontmatterBounds(content.split("\n"))).toEqual({ start: 0, end: 2 });
	});

	it("returns bounds when frontmatter has many lines", () => {
		const content = ["---", "name: test", "description: long", "tools: grep", "---", "body"].join("\n");
		expect(parseFrontmatterBounds(content.split("\n"))).toEqual({ start: 0, end: 4 });
	});

	it("returns bounds when content ends immediately after closing ---", () => {
		const content = ["---", "name: test", "---"].join("\n");
		expect(parseFrontmatterBounds(content.split("\n"))).toEqual({ start: 0, end: 2 });
	});

	it("returns null when content is empty", () => {
		expect(parseFrontmatterBounds("".split("\n"))).toBeNull();
	});

	it("returns null when there is no opening ---", () => {
		const content = "name: test\n---\nbody";
		expect(parseFrontmatterBounds(content.split("\n"))).toBeNull();
	});

	it("returns null when there is no closing ---", () => {
		const content = ["---", "name: test", "body"].join("\n");
		expect(parseFrontmatterBounds(content.split("\n"))).toBeNull();
	});

	it("returns null for single-line content with no ---", () => {
		expect(parseFrontmatterBounds("just text".split("\n"))).toBeNull();
	});

	it("returns null for content that is only opening ---", () => {
		expect(parseFrontmatterBounds("---".split("\n"))).toBeNull();
	});

	it("handles frontmatter with empty lines between keys", () => {
		const content = ["---", "name: test", "", "tools: grep", "---", "body"].join("\n");
		expect(parseFrontmatterBounds(content.split("\n"))).toEqual({ start: 0, end: 4 });
	});

	it("picks the first closing --- after the opening", () => {
		const content = ["---", "name: test", "---", "---", "body"].join("\n");
		expect(parseFrontmatterBounds(content.split("\n"))).toEqual({ start: 0, end: 2 });
	});
});
