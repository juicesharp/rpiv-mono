import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = fileURLToPath(new URL("./review-range.mjs", import.meta.url));

let tempDirs: string[] = [];

const git = (cwd: string, args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

const write = (root: string, path: string, contents: string) => {
	const fullPath = join(root, path);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, contents, "utf-8");
};

const createRepo = () => {
	const root = mkdtempSync(join(tmpdir(), "rpiv-review-range-"));
	tempDirs.push(root);
	git(root, ["init", "-b", "main"]);
	return root;
};

const runHelper = (cwd: string, scope: string) =>
	execFileSync("node", [helperPath, scope], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

const valueFor = (output: string, key: string) => {
	const prefix = `${key}:`;
	const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
	return line?.slice(prefix.length).trim() ?? "";
};

const changedFiles = (output: string) =>
	(output.split("---changed-files---")[1] ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

const noteFor = (output: string) => valueFor(output, "note");

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("review-range tree scopes", () => {
	it("resolves folder scopes to tracked files only", () => {
		const repo = createRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		write(repo, "src/nested/b.ts", "export const b = 2;\n");
		write(repo, "src/untracked.ts", "export const nope = 3;\n");
		git(repo, ["add", "src/a.ts", "src/nested/b.ts"]);

		const output = runHelper(repo, "--folder src");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "tree_path")).toBe("src");
		expect(valueFor(output, "null_tree")).toMatch(/^[0-9a-f]{40,64}$/);
		expect(changedFiles(output)).toEqual(["src/a.ts", "src/nested/b.ts"]);
	});

	it("includes staged-but-uncommitted files in folder scopes", () => {
		const repo = createRepo();
		git(repo, ["config", "user.email", "test@example.com"]);
		git(repo, ["config", "user.name", "Test User"]);
		git(repo, ["config", "commit.gpgsign", "false"]);
		write(repo, "src/committed.ts", "export const committed = 1;\n");
		git(repo, ["add", "src/committed.ts"]);
		git(repo, ["commit", "-m", "init"]);
		write(repo, "src/staged-only.ts", "export const staged = 2;\n");
		git(repo, ["add", "src/staged-only.ts"]);

		const output = runHelper(repo, "--folder src");

		expect(valueFor(output, "strategy")).toBe("tree");
		// The index is the single source of truth: the SKILL.md patch command
		// (git diff --cached <null_tree>) must cover exactly this file set.
		expect(changedFiles(output)).toEqual(["src/committed.ts", "src/staged-only.ts"]);
	});

	it("keeps comma-separated file paths with spaces intact", () => {
		const repo = createRepo();
		write(repo, "src/name with spaces.ts", "export const spaced = true;\n");
		write(repo, "src/other.ts", "export const other = true;\n");
		git(repo, ["add", "src/name with spaces.ts", "src/other.ts"]);

		const output = runHelper(repo, "--file src/name with spaces.ts,src/other.ts");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "files_list")).toBe("src/name with spaces.ts,src/other.ts");
		expect(changedFiles(output)).toEqual(["src/name with spaces.ts", "src/other.ts"]);
	});

	it("accepts equals-form file scopes", () => {
		const repo = createRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		git(repo, ["add", "src/a.ts"]);

		const output = runHelper(repo, "--file=src/a.ts");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "files_list")).toBe("src/a.ts");
		expect(changedFiles(output)).toEqual(["src/a.ts"]);
	});

	it("keeps a single file path with spaces intact without requiring a comma", () => {
		const repo = createRepo();
		write(repo, "src/name with spaces.ts", "export const spaced = true;\n");
		git(repo, ["add", "src/name with spaces.ts"]);

		const output = runHelper(repo, "--file src/name with spaces.ts");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "files_list")).toBe("src/name with spaces.ts");
		expect(changedFiles(output)).toEqual(["src/name with spaces.ts"]);
	});

	it("deduplicates repeated file scopes while preserving first-seen order", () => {
		const repo = createRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		write(repo, "src/b.ts", "export const b = 2;\n");
		git(repo, ["add", "src/a.ts", "src/b.ts"]);

		const output = runHelper(repo, "--file src/b.ts,src/a.ts,src/b.ts");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "files_list")).toBe("src/b.ts,src/a.ts");
		expect(changedFiles(output)).toEqual(["src/b.ts", "src/a.ts"]);
	});

	it("rejects file scopes with any untracked path instead of silently narrowing", () => {
		const repo = createRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		git(repo, ["add", "src/a.ts"]);

		const output = runHelper(repo, "--file src/a.ts,src/missing.ts");

		expect(valueFor(output, "strategy")).toBe("unrecognised");
		expect(valueFor(output, "note")).toContain("src/missing.ts");
		expect(changedFiles(output)).toEqual([]);
	});

	it("deduplicates repeated missing paths in error notes", () => {
		const repo = createRepo();

		const output = runHelper(repo, "--file missing.ts,missing.ts");

		expect(valueFor(output, "strategy")).toBe("unrecognised");
		expect(noteFor(output)).toBe("file scope contains untracked path(s): missing.ts");
		expect(changedFiles(output)).toEqual([]);
	});

	it("rejects empty flag values with descriptive notes", () => {
		const repo = createRepo();

		const folderOutput = runHelper(repo, "--folder=");
		const fileOutput = runHelper(repo, "--file=");

		expect(valueFor(folderOutput, "strategy")).toBe("unrecognised");
		expect(noteFor(folderOutput)).toBe("--folder scope requires a path");
		expect(valueFor(fileOutput, "strategy")).toBe("unrecognised");
		expect(noteFor(fileOutput)).toBe("--file scope requires at least one path");
	});

	it("rejects file scopes that resolve to multiple tracked files", () => {
		const repo = createRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		write(repo, "src/b.ts", "export const b = 2;\n");
		git(repo, ["add", "src/a.ts", "src/b.ts"]);

		const output = runHelper(repo, "--file src");

		expect(valueFor(output, "strategy")).toBe("unrecognised");
		expect(noteFor(output)).toBe("file scope path(s) must resolve to exactly one tracked file: src");
		expect(changedFiles(output)).toEqual([]);
	});

	it("protects folder pathspecs that look like git flags", () => {
		const repo = createRepo();
		write(repo, "--help/a.ts", "export const a = 1;\n");
		git(repo, ["add", "--", "--help/a.ts"]);

		const output = runHelper(repo, "--folder --help");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "tree_path")).toBe("--help");
		expect(changedFiles(output)).toEqual(["--help/a.ts"]);
	});

	it("keeps colon-prefixed scopes as compatibility aliases", () => {
		const repo = createRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		git(repo, ["add", "src/a.ts"]);

		const output = runHelper(repo, "folder:src");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "tree_path")).toBe("src");
		expect(changedFiles(output)).toEqual(["src/a.ts"]);
	});

	it("keeps file: legacy alias working", () => {
		const repo = createRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		git(repo, ["add", "src/a.ts"]);

		const output = runHelper(repo, "file:src/a.ts");

		expect(valueFor(output, "strategy")).toBe("tree");
		expect(valueFor(output, "files_list")).toBe("src/a.ts");
		expect(changedFiles(output)).toEqual(["src/a.ts"]);
	});
});
