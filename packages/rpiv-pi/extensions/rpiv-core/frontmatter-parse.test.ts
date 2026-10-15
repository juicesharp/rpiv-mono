import { parseFrontmatter as piParseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

// The local copy exists so the built-in workflows load without Pi; it must stay
// indistinguishable from the function it replaced.
const cases: Record<string, string> = {
	plain: "---\ntitle: x\nstatus: done\n---\n\n# Body\n",
	crlf: "---\r\ntitle: x\r\n---\r\nbody\r\n",
	cr: "---\rtitle: x\r---\rbody",
	bom: "﻿---\nk: 1\n---\nb",
	nested: "---\na:\n  b: [1, 2]\n---\n",
	empty: "---\n---\nbody",
	noFence: "# just a body\n",
	unterminated: "---\nk: v\nno close\n",
	dashesInBody: "---\nk: v\n---\nline\n---\nmore",
	emptyString: "",
};

describe("parseFrontmatter matches Pi's", () => {
	for (const [name, input] of Object.entries(cases)) {
		it(name, () => {
			expect(parseFrontmatter(input)).toEqual(piParseFrontmatter(input));
		});
	}

	it("throws on invalid YAML, as Pi's does", () => {
		const bad = "---\nk: [unclosed\n---\n";
		expect(() => piParseFrontmatter(bad)).toThrow();
		expect(() => parseFrontmatter(bad)).toThrow();
	});
});
