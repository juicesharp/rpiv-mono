/**
 * Tests for `BUNDLED_SKILL_NAMES` enumeration — Q39 of the 2026-05-23
 * review. The eager IIFE swallowed `readdirSync` failures into an empty
 * Set with no diagnostic, leaving `validateDag` to reject every skill
 * node as "unknown bundled skill" and the user with no hint that the
 * directory listing itself failed (stripped install, EACCES on the
 * skills dir, race against an unzip).
 *
 * Tests exercise the extracted `loadBundledSkillNames(dir)` helper so
 * the failure path can be driven deterministically; the module-load
 * IIFE just calls the helper against `BUNDLED_SKILLS_DIR`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledSkillNames } from "./paths.js";

describe("loadBundledSkillNames", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("returns the set of subdirectory names when the dir is readable", () => {
		const tmp = mkdtempSync(join(tmpdir(), "rpiv-paths-"));
		try {
			mkdirSync(join(tmp, "skill-a"));
			mkdirSync(join(tmp, "skill-b"));
			writeFileSync(join(tmp, "not-a-dir.txt"), "");
			expect(loadBundledSkillNames(tmp)).toEqual(new Set(["skill-a", "skill-b"]));
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("returns an empty set without throwing on a missing dir", () => {
		expect(loadBundledSkillNames("/nonexistent/rpiv-pi-skills-dir")).toEqual(new Set());
	});

	it("logs a [rpiv-pi]-prefixed warning that names the unreadable dir", () => {
		// The defect being repro'd: today the IIFE swallows the error into
		// `catch {}`, so the user sees no signal that enumeration failed and
		// every downstream "unknown bundled skill" error is unattributable.
		loadBundledSkillNames("/nonexistent/rpiv-pi-skills-dir");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [msg] = warnSpy.mock.calls[0]!;
		expect(msg).toMatch(/^\[rpiv-pi\]/);
		expect(msg).toContain("/nonexistent/rpiv-pi-skills-dir");
	});
});
