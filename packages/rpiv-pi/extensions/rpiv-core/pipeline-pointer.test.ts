import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { FLAG_DEBUG, MSG_TYPE_PIPELINE_INDEX } from "./constants.js";
import { BUNDLED_SKILLS_DIR } from "./paths.js";
import { injectPipelinePointer, PIPELINE_POINTER } from "./pipeline-pointer.js";

/** Bundled skills with whether their frontmatter carries `disable-model-invocation: true`. */
function bundledSkills(): Array<{ name: string; hidden: boolean }> {
	return readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(BUNDLED_SKILLS_DIR, d.name, "SKILL.md")))
		.map((d) => ({
			name: d.name,
			hidden: /^disable-model-invocation:\s*true\s*$/m.test(
				readFileSync(join(BUNDLED_SKILLS_DIR, d.name, "SKILL.md"), "utf-8"),
			),
		}));
}

/**
 * Skill-name tokens the pointer mentions. Splitting on anything outside
 * [a-z0-9:-] keeps `design-slice` whole and turns `/skill:design` into
 * `skill:design`, whose prefix is then stripped — so `design` matching here
 * cannot be a false positive from `design-slice`.
 */
function pointerTokens(): Set<string> {
	return new Set(
		PIPELINE_POINTER.toLowerCase()
			.split(/[^a-z0-9:-]+/)
			.map((t) => t.replace(/^skill:/, "")),
	);
}

describe("injectPipelinePointer", () => {
	it("sends the pointer as a hidden message with its own customType", () => {
		const { pi } = createMockPi();
		injectPipelinePointer(pi);
		expect(pi.sendMessage).toHaveBeenCalledExactlyOnceWith({
			customType: MSG_TYPE_PIPELINE_INDEX,
			content: PIPELINE_POINTER,
			display: false,
		});
	});

	it("displays the message when the debug flag is set", () => {
		const { pi, captured } = createMockPi();
		captured.flags.set(FLAG_DEBUG, true);
		injectPipelinePointer(pi);
		expect(vi.mocked(pi.sendMessage).mock.calls[0]?.[0]).toMatchObject({ display: true });
	});
});

describe("PIPELINE_POINTER ↔ skill frontmatter sync (issue #77 tiers)", () => {
	const skills = bundledSkills();
	const tokens = pointerTokens();

	it("sanity: bundled skills were enumerated and both tiers exist", () => {
		expect(skills.length).toBeGreaterThan(0);
		expect(skills.some((s) => s.hidden)).toBe(true);
		expect(skills.some((s) => !s.hidden)).toBe(true);
	});

	it("every disable-model-invocation skill is routable via the pointer", () => {
		const missing = skills.filter((s) => s.hidden && !tokens.has(s.name)).map((s) => s.name);
		expect(missing).toEqual([]);
	});

	it("no model-visible skill is duplicated into the pointer", () => {
		const duplicated = skills.filter((s) => !s.hidden && tokens.has(s.name)).map((s) => s.name);
		expect(duplicated).toEqual([]);
	});
});
