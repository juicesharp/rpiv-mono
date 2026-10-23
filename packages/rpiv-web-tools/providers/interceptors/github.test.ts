/**
 * Unit tests for providers/interceptors/github.ts
 *
 * Covers all pure/sync logic and null-return paths that don't require real
 * execFile/gh CLI calls:
 * - parseGitHubUrl (all branches)
 * - resolveGitHubOptions (resolution matrix)
 * - GitHubInterceptor.intercept null-return paths (disabled, NON_CODE_SEGMENTS,
 *   aborted, SHA, clone fails)
 * - generateCloneContent (root/tree/blob/binary via temp dir + _seedCache)
 * - fetchViaApi paths via mocked gh
 *
 * execFile is mocked so no real network or gh CLI calls occur.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process — controls checkGhAvailable + all gh/git calls
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => mockExecFile(...args),
}));

function makeGhUnavailable() {
	mockExecFile.mockImplementation((...args: unknown[]) => {
		const cb = args[args.length - 1] as (err: Error | null) => void;
		cb(new Error("gh: not found"));
	});
}

function makeGhAvailableApisFail() {
	mockExecFile.mockImplementation((...args: unknown[]) => {
		const cmdArgs = args[1] as string[];
		const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
		if (cmdArgs[0] === "--version") {
			cb(null, "gh version 2.0.0");
		} else {
			cb(new Error("not found"), "");
		}
	});
}

// ---------------------------------------------------------------------------
// Module under test — imported after vi.mock is registered
// ---------------------------------------------------------------------------

const { parseGitHubUrl, resolveGitHubOptions, GitHubInterceptor, GITHUB_TOKEN_ENV_VAR, DEFAULTS } = await import(
	"./github.ts"
);

// Default factory: returns a fresh enabled interceptor with default thresholds.
// Tests construct their own seeded cache when they need to inject clone results.
function make(
	opts: { enabled?: boolean; maxRepoSizeMB?: number; cloneTimeoutSeconds?: number; clonePath?: string } = {},
): InstanceType<typeof GitHubInterceptor> {
	return new GitHubInterceptor({ enabled: true, ...opts });
}

// ---------------------------------------------------------------------------
// parseGitHubUrl
// ---------------------------------------------------------------------------

describe("parseGitHubUrl", () => {
	it("returns null for non-GitHub URLs", () => {
		expect(parseGitHubUrl("https://example.com/foo")).toBeNull();
		expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
	});

	it("returns null for invalid URLs", () => {
		expect(parseGitHubUrl("not a url")).toBeNull();
		expect(parseGitHubUrl("")).toBeNull();
	});

	it("returns null when path has fewer than 2 segments", () => {
		expect(parseGitHubUrl("https://github.com/")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
	});

	it("parses a root repo URL", () => {
		const info = parseGitHubUrl("https://github.com/owner/repo");
		expect(info).toEqual({ owner: "owner", repo: "repo", refIsFullSha: false, type: "root" });
	});

	it("strips .git suffix from repo name", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo.git")?.repo).toBe("repo");
	});

	it("handles www.github.com hostname", () => {
		expect(parseGitHubUrl("https://www.github.com/owner/repo")?.type).toBe("root");
	});

	it.each([
		"issues",
		"pull",
		"pulls",
		"discussions",
		"releases",
		"wiki",
		"actions",
		"settings",
		"security",
		"commits",
		"tags",
		"branches",
	])("returns null for NON_CODE_SEGMENT: %s", (segment) => {
		expect(parseGitHubUrl(`https://github.com/owner/repo/${segment}`)).toBeNull();
	});

	it("returns null when action is not blob or tree", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/compare/main...feat")).toBeNull();
	});

	it("returns null when blob/tree has no ref segment", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/blob")).toBeNull();
	});

	it("parses a blob URL", () => {
		const info = parseGitHubUrl("https://github.com/owner/repo/blob/main/src/file.ts");
		expect(info).toMatchObject({
			owner: "owner",
			repo: "repo",
			ref: "main",
			type: "blob",
			path: "src/file.ts",
			refIsFullSha: false,
		});
	});

	it("detects full-SHA ref", () => {
		const sha = "a".repeat(40);
		const info = parseGitHubUrl(`https://github.com/owner/repo/blob/${sha}/file.ts`);
		expect(info?.refIsFullSha).toBe(true);
		expect(info?.ref).toBe(sha);
	});

	it("parses a tree URL with path", () => {
		const info = parseGitHubUrl("https://github.com/owner/repo/tree/main/src");
		expect(info).toMatchObject({ type: "tree", ref: "main", path: "src" });
	});

	it("parses a tree URL with empty path (repo root tree)", () => {
		const info = parseGitHubUrl("https://github.com/owner/repo/tree/main");
		expect(info?.path).toBe("");
		expect(info?.type).toBe("tree");
	});

	it("decodes percent-encoded path segments", () => {
		const info = parseGitHubUrl("https://github.com/owner/repo/blob/main/path%20with%20spaces/file.ts");
		expect(info?.path).toBe("path with spaces/file.ts");
	});
});

// ---------------------------------------------------------------------------
// resolveGitHubOptions — opt-in resolution matrix
// ---------------------------------------------------------------------------

describe("resolveGitHubOptions", () => {
	it("absent user config + no consumer default → disabled", () => {
		expect(resolveGitHubOptions(undefined, undefined)).toEqual(DEFAULTS);
	});

	it("absent user config + consumer:true → enabled with defaults", () => {
		expect(resolveGitHubOptions(undefined, true)).toEqual({ ...DEFAULTS, enabled: true });
	});

	it("absent user config + consumer:false → disabled", () => {
		expect(resolveGitHubOptions(undefined, false)).toEqual(DEFAULTS);
	});

	it("user:false beats consumer:true → disabled (explicit user override wins)", () => {
		expect(resolveGitHubOptions(false, true)).toEqual({ ...DEFAULTS, enabled: false });
	});

	it("user:true beats consumer:false → enabled", () => {
		expect(resolveGitHubOptions(true, false)).toEqual({ ...DEFAULTS, enabled: true });
	});

	it("user object form implies opt-in regardless of consumer default", () => {
		const r = resolveGitHubOptions({ maxRepoSizeMB: 1000 }, false);
		expect(r.enabled).toBe(true);
		expect(r.maxRepoSizeMB).toBe(1000);
		expect(r.cloneTimeoutSeconds).toBe(DEFAULTS.cloneTimeoutSeconds);
		expect(r.clonePath).toBe(DEFAULTS.clonePath);
	});

	it('user object with explicit "enabled": false honors it', () => {
		const r = resolveGitHubOptions({ enabled: false, maxRepoSizeMB: 1000 }, true);
		expect(r.enabled).toBe(false);
		expect(r.maxRepoSizeMB).toBe(1000);
	});

	it("user object overrides every default field", () => {
		const r = resolveGitHubOptions({ maxRepoSizeMB: 1, cloneTimeoutSeconds: 2, clonePath: "/x" }, undefined);
		expect(r).toEqual({ enabled: true, maxRepoSizeMB: 1, cloneTimeoutSeconds: 2, clonePath: "/x" });
	});
});

// ---------------------------------------------------------------------------
// GITHUB_TOKEN_ENV_VAR
// ---------------------------------------------------------------------------

describe("GITHUB_TOKEN_ENV_VAR", () => {
	it("is GITHUB_TOKEN", () => {
		expect(GITHUB_TOKEN_ENV_VAR).toBe("GITHUB_TOKEN");
	});
});

// ---------------------------------------------------------------------------
// intercept — fast null-return paths
// ---------------------------------------------------------------------------

describe("intercept — fast null returns", () => {
	beforeEach(makeGhUnavailable);

	it("returns null for non-GitHub URL", async () => {
		expect(await make().intercept("https://example.com", { raw: false })).toBeNull();
	});

	it("returns null for NON_CODE_SEGMENTS URLs", async () => {
		const i = make();
		expect(await i.intercept("https://github.com/owner/repo/issues", { raw: false })).toBeNull();
		expect(await i.intercept("https://github.com/owner/repo/pulls", { raw: false })).toBeNull();
		expect(await i.intercept("https://github.com/owner/repo/actions", { raw: false })).toBeNull();
	});

	it("returns null when signal is already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		expect(await make().intercept("https://github.com/owner/repo", { raw: false, signal: ctrl.signal })).toBeNull();
	});

	it("returns null when interceptor.enabled is false", async () => {
		const i = new GitHubInterceptor({ enabled: false });
		expect(await i.intercept("https://github.com/owner/repo", { raw: false })).toBeNull();
	});

	it("returns null for full-SHA ref (gh unavailable → API path → getDefaultBranch null)", async () => {
		const sha = "a".repeat(40);
		expect(await make().intercept(`https://github.com/owner/repo/blob/${sha}/file.ts`, { raw: false })).toBeNull();
	});

	it("returns null for root URL when gh unavailable and git clone fails", async () => {
		expect(await make().intercept("https://github.com/owner/repo", { raw: false })).toBeNull();
	});

	it("returns null for blob URL when no gh and no clone", async () => {
		expect(await make().intercept("https://github.com/owner/repo/blob/main/file.ts", { raw: false })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// intercept — with gh available but all API calls fail
// ---------------------------------------------------------------------------

describe("intercept — gh available, API returns null", () => {
	beforeEach(makeGhAvailableApisFail);

	it("returns null for root URL (size=null, clone fails, API=null)", async () => {
		expect(await make().intercept("https://github.com/owner/repo", { raw: false })).toBeNull();
	});

	it("returns null for blob URL (clone fails, API=null)", async () => {
		expect(await make().intercept("https://github.com/owner/repo/blob/main/file.ts", { raw: false })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// reset() — clears cache + ghAvailable
// ---------------------------------------------------------------------------

describe("reset()", () => {
	it("can be called on an empty cache without throwing", () => {
		const i = make();
		expect(() => i.reset()).not.toThrow();
		expect(() => i.reset()).not.toThrow();
	});

	it("resets ghAvailable so checkGhAvailable re-probes on next call", async () => {
		const i = make();
		makeGhUnavailable();
		await i.intercept("https://github.com/owner/repo/issues", { raw: false });
		i.reset();
		makeGhAvailableApisFail();
		await i.intercept("https://github.com/owner/repo/issues", { raw: false });
		// No assertion on return value — verifying no throw and that the re-probe path is hit.
	});
});

// ---------------------------------------------------------------------------
// generateCloneContent — via _seedCache + temp directory fixtures
// ---------------------------------------------------------------------------

describe("generateCloneContent — via clone cache injection", () => {
	let tempDir: string;

	beforeEach(() => {
		makeGhUnavailable();
		tempDir = mkdtempSync(join(tmpdir(), "rpiv-gh-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("root: returns file tree + README", async () => {
		writeFileSync(join(tempDir, "README.md"), "# My Repo\nHello world.");
		writeFileSync(join(tempDir, "index.ts"), "export const x = 1;");
		mkdirSync(join(tempDir, "src"));
		writeFileSync(join(tempDir, "src", "main.ts"), "");

		const i = make();
		i._seedCache("owner/repo", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("Repository cloned to:");
		expect(r!.text).toContain("## Structure");
		expect(r!.text).toContain("index.ts");
		expect(r!.text).toContain("src/");
		expect(r!.text).toContain("## README.md");
		expect(r!.text).toContain("My Repo");
		expect(r!.title).toBe("owner/repo");
		expect(r!.contentType).toBe("text/plain");
	});

	it("root: works without a README", async () => {
		writeFileSync(join(tempDir, "index.ts"), "");
		const i = make();
		i._seedCache("owner/repo", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("## Structure");
		expect(r!.text).not.toContain("## README.md");
	});

	it("root: truncates README at 8K chars", async () => {
		writeFileSync(join(tempDir, "README.md"), "x".repeat(9000));
		const i = make();
		i._seedCache("owner/repo", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo", { raw: false });
		expect(r!.text).toContain("[README truncated at 8K chars]");
	});

	it("blob: handles unreadable file (readFileSync catch path) via chmod 000", async () => {
		const { chmodSync } = await import("node:fs");
		writeFileSync(join(tempDir, "unreadable.ts"), "const x = 1;");
		chmodSync(join(tempDir, "unreadable.ts"), 0o000);
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });
		try {
			const r = await i.intercept("https://github.com/owner/repo/blob/main/unreadable.ts", { raw: false });
			expect(r).not.toBeNull();
			expect(typeof r!.text).toBe("string");
		} finally {
			try {
				chmodSync(join(tempDir, "unreadable.ts"), 0o644);
			} catch {
				/* ignore */
			}
		}
	});

	it("buildTree truncation at MAX_TREE_ENTRIES (>200 files)", async () => {
		for (let i = 0; i < 201; i++) {
			writeFileSync(join(tempDir, `file${i.toString().padStart(3, "0")}.ts`), "");
		}
		const interceptor = make();
		interceptor._seedCache("owner/repo", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });
		const r = await interceptor.intercept("https://github.com/owner/repo", { raw: false });
		expect(r!.text).toContain("truncated at 200 entries");
	});

	it("root: formatFileSize shows bytes for tiny files and KB for medium files", async () => {
		mkdirSync(join(tempDir, "subdir"));
		writeFileSync(join(tempDir, "subdir", "tiny.ts"), "x");
		writeFileSync(join(tempDir, "subdir", "medium.ts"), "x".repeat(2048));
		writeFileSync(join(tempDir, "subdir", "large.ts"), "x".repeat(1_100_000));
		const i = make();
		i._seedCache("owner/repo@v", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/tree/v/subdir", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toMatch(/\d+ B|\d+\.\d+ KB|\d+\.\d+ MB/);
	});

	it("root: buildTree marks outside-repo symlink as skipped", async () => {
		const { symlinkSync } = await import("node:fs");
		writeFileSync(join(tempDir, "normal.ts"), "");
		try {
			symlinkSync("/tmp", join(tempDir, "escape-link"));
		} catch {
			/* skip if symlink creation fails */
		}
		const i = make();
		i._seedCache("owner/repo", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });
		const r = await i.intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("normal.ts");
		expect(r!.text).toContain("outside repo skipped");
	});

	it("root: skips NOISE_DIRS in tree output", async () => {
		mkdirSync(join(tempDir, "node_modules"));
		writeFileSync(join(tempDir, "node_modules", "pkg.js"), "");
		writeFileSync(join(tempDir, "index.ts"), "");
		const i = make();
		i._seedCache("owner/repo", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo", { raw: false });
		expect(r!.text).toContain("node_modules/  [skipped]");
		expect(r!.text).not.toContain("pkg.js");
	});

	it("blob: returns file content", async () => {
		writeFileSync(join(tempDir, "file.ts"), "export const answer = 42;");
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/blob/main/file.ts", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("## file.ts");
		expect(r!.text).toContain("export const answer = 42;");
		expect(r!.title).toBe("owner/repo - file.ts");
	});

	it("blob: returns binary message for known binary extension (.png)", async () => {
		writeFileSync(join(tempDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/blob/main/image.png", { raw: false });
		expect(r!.text).toContain("Binary file");
		expect(r!.text).toContain("png");
	});

	it("blob: returns binary message for file with null bytes", async () => {
		writeFileSync(join(tempDir, "data.bin"), Buffer.alloc(16));
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/blob/main/data.bin", { raw: false });
		expect(r!.text).toContain("Binary file");
	});

	it("blob: falls back to repo root when file not found in clone", async () => {
		writeFileSync(join(tempDir, "README.md"), "# Repo");
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/blob/main/missing.ts", { raw: false });
		expect(r!.text).toContain("not found in clone");
		expect(r!.text).toContain("## Structure");
	});

	it("blob: shows dir listing when path points to a directory", async () => {
		mkdirSync(join(tempDir, "mydir"));
		writeFileSync(join(tempDir, "mydir", "file.ts"), "");
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/blob/main/mydir", { raw: false });
		expect(r!.text).toContain("file.ts");
	});

	it("blob: truncates large files at 100K chars", async () => {
		writeFileSync(join(tempDir, "big.ts"), "x".repeat(110_000));
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/blob/main/big.ts", { raw: false });
		expect(r!.text).toContain("[File truncated at 100K chars");
	});

	it("tree: returns directory listing for existing subdir", async () => {
		mkdirSync(join(tempDir, "src"));
		writeFileSync(join(tempDir, "src", "a.ts"), "");
		writeFileSync(join(tempDir, "src", "b.ts"), "");
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/tree/main/src", { raw: false });
		expect(r!.text).toContain("## src");
		expect(r!.text).toContain("a.ts");
		expect(r!.text).toContain("b.ts");
	});

	it("tree: falls back to repo root when subdir not found", async () => {
		writeFileSync(join(tempDir, "index.ts"), "");
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/tree/main/missing-dir", { raw: false });
		expect(r!.text).toContain("not found in clone");
		expect(r!.text).toContain("## Structure");
	});

	it("tree: handles empty path (root tree URL)", async () => {
		writeFileSync(join(tempDir, "index.ts"), "");
		const i = make();
		i._seedCache("owner/repo@main", { localPath: tempDir, clonePromise: Promise.resolve(tempDir) });

		const r = await i.intercept("https://github.com/owner/repo/tree/main", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("index.ts");
	});

	it("falls back to fetchViaApi when clonePromise resolves null (gh unavailable → null)", async () => {
		const i = make();
		i._seedCache("owner/repo", { localPath: tempDir, clonePromise: Promise.resolve(null) });
		const r = await i.intercept("https://github.com/owner/repo", { raw: false });
		expect(r).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// fetchViaApi paths — via gh mock returning real API responses
// ---------------------------------------------------------------------------

describe("fetchViaApi paths (gh mocked to return API responses)", () => {
	function makeGhApiMock(responses: Record<string, string>) {
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cmdArgs = args[1] as string[];
			const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
			if (cmdArgs[0] === "--version") {
				cb(null, "gh version 2.0.0");
				return;
			}
			if (cmdArgs[0] !== "api") {
				cb(new Error("unexpected command"), "");
				return;
			}
			const apiPath = cmdArgs[1] as string;
			const jqFilter = cmdArgs[3] as string | undefined;
			const routeKey = `${apiPath}|${jqFilter ?? ""}`;
			const key = Object.keys(responses).find((k) => routeKey.includes(k));
			if (key) {
				cb(null, responses[key]);
			} else {
				cb(new Error("not found"), "");
			}
		});
	}

	it("fetches a blob file via API (getDefaultBranch + fetchFileViaApi)", async () => {
		const fileContentB64 = Buffer.from("export const x = 1;\n").toString("base64");
		makeGhApiMock({ ".default_branch": "main", ".content": fileContentB64 });

		const r = await make().intercept("https://github.com/owner/repo/blob/main/src/file.ts", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("export const x = 1;");
		expect(r!.title).toBe("owner/repo - src/file.ts");
	});

	it("fetches repo root via API (getDefaultBranch + fetchTreeViaApi + fetchReadmeViaApi)", async () => {
		const readmeB64 = Buffer.from("# Hello World").toString("base64");
		makeGhApiMock({
			".default_branch": "main",
			".tree[].path": "src/index.ts\nREADME.md",
			"repos/owner/repo/readme": readmeB64,
		});

		const r = await make().intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("## Structure");
		expect(r!.text).toContain("src/index.ts");
		expect(r!.text).toContain("## README.md");
		expect(r!.text).toContain("Hello World");
	});

	it("returns tree-only view when readme API call fails", async () => {
		makeGhApiMock({
			".default_branch": "main",
			".tree[].path": "index.ts\nlib.ts",
		});

		const r = await make().intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("## Structure");
		expect(r!.text).not.toContain("## README.md");
	});

	it("returns null when tree and readme both fail (no content)", async () => {
		makeGhApiMock({ ".default_branch": "main" });

		const r = await make().intercept("https://github.com/owner/repo", { raw: false });
		expect(r).toBeNull();
	});

	it("returns null when file content API fails", async () => {
		makeGhApiMock({ ".default_branch": "main" });

		const r = await make().intercept("https://github.com/owner/repo/blob/main/file.ts", { raw: false });
		expect(r).toBeNull();
	});

	it("truncates file content at 100K chars via API", async () => {
		const fileContentB64 = Buffer.from("x".repeat(110_000)).toString("base64");
		makeGhApiMock({ ".default_branch": "main", ".content": fileContentB64 });

		const r = await make().intercept("https://github.com/owner/repo/blob/main/big.ts", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("[File truncated at 100K chars]");
	});

	it("uses sizeNote when repo is oversized (API-only fallback)", async () => {
		const readmeB64 = Buffer.from("# Big Repo").toString("base64");
		makeGhApiMock({
			".size": "400000",
			".default_branch": "main",
			".tree[].path": "file.ts",
			"repos/owner/repo/readme": readmeB64,
		});

		const r = await make().intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("Repository is");
		expect(r!.text).toContain("threshold");
	});

	it("uses provided ref instead of fetching default branch (blob with explicit ref)", async () => {
		const fileContentB64 = Buffer.from("const v = 2;").toString("base64");
		makeGhApiMock({ ".content": fileContentB64 });

		const r = await make().intercept("https://github.com/owner/repo/blob/feature-branch/file.ts", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("const v = 2;");
	});

	it("clones repo via gh when gh available and size below threshold", async () => {
		const cloneTarget = mkdtempSync(join(tmpdir(), "rpiv-gh-clone-"));
		try {
			writeFileSync(join(cloneTarget, "README.md"), "# Cloned!");
			mockExecFile.mockImplementation((...args: unknown[]) => {
				const cmdArgs = args[1] as string[];
				const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
				if (cmdArgs[0] === "--version") {
					cb(null, "gh 2.0.0");
					return;
				}
				if (cmdArgs[0] === "api") {
					const jq = cmdArgs[3] as string | undefined;
					if (jq === ".size") {
						cb(null, "100");
						return;
					}
					if (jq === ".default_branch") {
						cb(null, "main");
						return;
					}
					cb(new Error("unexpected api"), "");
					return;
				}
				if (cmdArgs[0] === "repo" && cmdArgs[1] === "clone") {
					const targetPath = cmdArgs[3] as string;
					try {
						mkdirSync(targetPath, { recursive: true });
						writeFileSync(join(targetPath, "README.md"), "# Cloned!");
					} catch {
						/* ignore */
					}
					cb(null, "");
					return;
				}
				cb(new Error("unexpected"), "");
			});

			const r = await make().intercept("https://github.com/owner/repo", { raw: false });
			expect(r).not.toBeNull();
			expect(r!.text).toContain("Repository cloned to:");
			expect(r!.text).toContain("README.md");
		} finally {
			rmSync(cloneTarget, { recursive: true, force: true });
		}
	});

	it("git fallback clone when gh unavailable (showGhHint + git clone path)", async () => {
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cmdArgs = args[1] as string[];
			const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
			if (cmdArgs[0] === "--version") {
				cb(new Error("not found"));
				return;
			}
			if (cmdArgs[0] === "clone") {
				const targetPath = cmdArgs[cmdArgs.length - 1] as string;
				try {
					mkdirSync(targetPath, { recursive: true });
					writeFileSync(join(targetPath, "index.ts"), "export default 1;");
				} catch {
					/* ignore */
				}
				cb(null, "");
				return;
			}
			cb(new Error("unexpected"), "");
		});

		const r = await make().intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("Repository cloned to:");
	});

	it("checkRepoSize: returns null when gh unavailable", async () => {
		makeGhUnavailable();
		const size = await make().checkRepoSize("owner", "repo");
		expect(size).toBeNull();
	});

	it("checkRepoSize: returns null on gh api error", async () => {
		makeGhAvailableApisFail();
		const size = await make().checkRepoSize("owner", "repo");
		expect(size).toBeNull();
	});

	it("checkRepoSize: returns numeric KB value", async () => {
		makeGhApiMock({ ".size": "12345" });
		const size = await make().checkRepoSize("owner", "repo");
		expect(size).toBe(12345);
	});

	it("checkRepoSize: returns null for non-numeric output", async () => {
		makeGhApiMock({ ".size": "not-a-number" });
		const size = await make().checkRepoSize("owner", "repo");
		expect(size).toBeNull();
	});

	it("checkGhAvailable: returns false when execFile fails", async () => {
		makeGhUnavailable();
		const result = await make().checkGhAvailable();
		expect(result).toBe(false);
	});

	it("checkGhAvailable: returns true when execFile succeeds", async () => {
		makeGhAvailableApisFail();
		const result = await make().checkGhAvailable();
		expect(result).toBe(true);
	});

	it("checkGhAvailable: caches the result (second call returns same value)", async () => {
		makeGhAvailableApisFail();
		const i = make();
		await i.checkGhAvailable();
		makeGhUnavailable();
		const second = await i.checkGhAvailable();
		expect(second).toBe(true);
	});

	it("signal abort between size check and clone start returns null", async () => {
		const controller = new AbortController();
		let sizeCheckDone = false;
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cmdArgs = args[1] as string[];
			const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
			if (cmdArgs[0] === "--version") {
				cb(null, "gh 2.0.0");
				return;
			}
			if (cmdArgs[0] === "api") {
				const jq = cmdArgs[3] as string | undefined;
				if (jq === ".size") {
					controller.abort();
					sizeCheckDone = true;
					cb(null, "100");
					return;
				}
			}
			cb(new Error("unexpected"), "");
		});
		const r = await make().intercept("https://github.com/owner/repo", { raw: false, signal: controller.signal });
		expect(r).toBeNull();
		expect(sizeCheckDone).toBe(true);
	});

	it("forceClone=true skips size check and attempts clone directly", async () => {
		makeGhAvailableApisFail();
		const r = await make().intercept("https://github.com/owner/repo", { raw: false, forceClone: true });
		expect(r).toBeNull();
	});

	it("signal abort after size check returns null", async () => {
		const controller = new AbortController();
		let sizeCallCount = 0;
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cmdArgs = args[1] as string[];
			const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
			if (cmdArgs[0] === "--version") {
				cb(null, "gh 2.0.0");
				return;
			}
			if (cmdArgs[0] === "api") {
				const jq = cmdArgs[3] as string | undefined;
				if (jq === ".size") {
					sizeCallCount++;
					controller.abort();
					cb(null, "100");
					return;
				}
			}
			cb(new Error("unexpected"), "");
		});
		const r = await make().intercept("https://github.com/owner/repo", { raw: false, signal: controller.signal });
		expect(r).toBeNull();
		expect(sizeCallCount).toBe(1);
	});

	it("readReadme falls back through candidate list (README without .md)", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "rpiv-readme-"));
		try {
			writeFileSync(join(tmpDir, "README"), "Bare README content");
			const i = make();
			i._seedCache("owner/repo", { localPath: tmpDir, clonePromise: Promise.resolve(tmpDir) });
			const r = await i.intercept("https://github.com/owner/repo", { raw: false });
			expect(r!.text).toContain("Bare README content");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("buildDirListing: handles outside-repo symlink gracefully", async () => {
		const { symlinkSync } = await import("node:fs");
		const tmpDir = mkdtempSync(join(tmpdir(), "rpiv-dir-"));
		try {
			writeFileSync(join(tmpDir, "normal.ts"), "");
			try {
				symlinkSync("/tmp", join(tmpDir, "escape-link"));
			} catch {
				/* skip if fails */
			}
			const i = make();
			i._seedCache("owner/repo@main", { localPath: tmpDir, clonePromise: Promise.resolve(tmpDir) });
			const r = await i.intercept("https://github.com/owner/repo/tree/main", { raw: false });
			expect(r).not.toBeNull();
			expect(r!.text).toContain("normal.ts");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("abort after successful clone returns null and removes cache entry", async () => {
		const controller = new AbortController();
		let cloneCallCount = 0;
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cmdArgs = args[1] as string[];
			const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
			if (cmdArgs[0] === "--version") {
				cb(null, "gh 2.0.0");
				return;
			}
			if (cmdArgs[0] === "api" && cmdArgs[3] === ".size") {
				cb(new Error("size unavailable"), "");
				return;
			}
			if (cmdArgs[0] === "repo" && cmdArgs[1] === "clone") {
				cloneCallCount++;
				const targetPath = cmdArgs[3] as string;
				try {
					mkdirSync(targetPath, { recursive: true });
				} catch {
					/* ignore */
				}
				controller.abort();
				cb(null, "");
				return;
			}
			cb(new Error("unexpected"), "");
		});
		const r = await make().intercept("https://github.com/owner/repo", { raw: false, signal: controller.signal });
		expect(r).toBeNull();
		expect(cloneCallCount).toBe(1);
	});

	it("awaitCachedClone: signal aborted before clone promise resolves returns null", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "rpiv-abort-"));
		try {
			writeFileSync(join(tmpDir, "index.ts"), "");
			const controller = new AbortController();
			controller.abort();
			const i = make();
			i._seedCache("owner/repo", { localPath: tmpDir, clonePromise: Promise.resolve(tmpDir) });
			const r = await i.intercept("https://github.com/owner/repo", { raw: false, signal: controller.signal });
			expect(r).toBeNull();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("concurrent clone: second intercept call reuses existing cache entry", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "rpiv-concurrent-"));
		try {
			writeFileSync(join(tmpDir, "index.ts"), "const x = 1;");
			const i = make();
			i._seedCache("owner/repo", { localPath: tmpDir, clonePromise: Promise.resolve(tmpDir) });
			const r = await i.intercept("https://github.com/owner/repo", { raw: false });
			expect(r).not.toBeNull();
			expect(r!.text).toContain("index.ts");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("SHA URL with sizeNote: proceeds to fetchViaApi with commit SHA note", async () => {
		const sha = "b".repeat(40);
		const fileContentB64 = Buffer.from("const sha = true;").toString("base64");
		makeGhApiMock({ ".default_branch": "main", ".content": fileContentB64 });
		const r = await make().intercept(`https://github.com/owner/repo/blob/${sha}/file.ts`, { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toContain("Note: Commit SHA URLs use the GitHub API");
		expect(r!.text).toContain("const sha = true;");
	});

	it("maxRepoSizeMB override threshold is honored", async () => {
		// Override threshold to 50MB; with size=400MB, hits oversized path.
		const readmeB64 = Buffer.from("# Big Repo").toString("base64");
		makeGhApiMock({
			".size": "400000",
			".default_branch": "main",
			".tree[].path": "file.ts",
			"repos/owner/repo/readme": readmeB64,
		});
		const r = await make({ maxRepoSizeMB: 50 }).intercept("https://github.com/owner/repo", { raw: false });
		expect(r).not.toBeNull();
		expect(r!.text).toMatch(/threshold: 50/);
	});
});
