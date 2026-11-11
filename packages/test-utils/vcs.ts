import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One working-copy path per status class, in the shared `XY` vocabulary. */
export const EXPECTED_VCS_STATUS_ENTRIES: ReadonlyArray<{ xy: string; path: string }> = [
	{ xy: " M", path: "modified.ts" },
	{ xy: "??", path: "added.ts" },
	{ xy: " D", path: "deleted.ts" },
	{ xy: " R", path: "new.ts" },
];

/** True when `jj` answers on PATH. */
export function hasJj(): boolean {
	try {
		execFileSync("jj", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

/**
 * Seed `cwd` as a jj workspace whose working copy carries exactly the paths in
 * `EXPECTED_VCS_STATUS_ENTRIES`: `modified.ts` changed, `added.ts` new,
 * `deleted.ts` removed, and `old.ts` renamed to `new.ts`.
 */
export function seedJjStatusWorkspace(cwd: string): void {
	const jj = (...args: string[]) => execFileSync("jj", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
	jj("git", "init");
	// Repo-level identity: the helper's `author:` line reads `jj config get
	// user.name`, which must resolve without any user-level jj config.
	jj("config", "set", "--repo", "user.name", "Test User");
	jj("config", "set", "--repo", "user.email", "test@example.com");
	writeFileSync(join(cwd, "modified.ts"), "one\n");
	writeFileSync(join(cwd, "deleted.ts"), "gone\n");
	writeFileSync(join(cwd, "old.ts"), "renamed\n");
	jj("describe", "-m", "baseline");
	jj("new");
	writeFileSync(join(cwd, "modified.ts"), "two\n");
	rmSync(join(cwd, "deleted.ts"));
	rmSync(join(cwd, "old.ts"));
	writeFileSync(join(cwd, "new.ts"), "renamed\n");
	writeFileSync(join(cwd, "added.ts"), "new\n");
	jj("status");
}
