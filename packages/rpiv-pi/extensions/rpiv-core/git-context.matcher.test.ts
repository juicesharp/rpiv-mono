import { describe, expect, it } from "vitest";
import { isGitMutatingCommand } from "./git-context.ts";

describe("isGitMutatingCommand — positives", () => {
	const mutating = [
		"git checkout main",
		"git switch feature",
		"git commit -m 'x'",
		"git merge main",
		"git rebase main",
		"git pull",
		"git reset --hard HEAD",
		"git revert abc",
		"git cherry-pick abc",
		"git worktree add ../wt",
		"git am < patch",
		"git stash",
	];
	for (const cmd of mutating) {
		it(`matches: ${cmd}`, () => {
			expect(isGitMutatingCommand(cmd)).toBe(true);
		});
	}
	it("matches when chained with preceding command", () => {
		expect(isGitMutatingCommand("cd x && git commit")).toBe(true);
	});
});

describe("isGitMutatingCommand — negatives", () => {
	const nonMutating = [
		"git status",
		"git log",
		"git diff",
		"git rev-parse HEAD",
		"git config user.name",
		"gitmoji commit",
		"git --version",
	];
	for (const cmd of nonMutating) {
		it(`does NOT match: ${cmd}`, () => {
			expect(isGitMutatingCommand(cmd)).toBe(false);
		});
	}
	it("rejects empty string", () => {
		expect(isGitMutatingCommand("")).toBe(false);
	});
});
