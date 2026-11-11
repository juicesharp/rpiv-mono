import { execFile } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, sep as pathSep, resolve as resolvePath } from "node:path";
import { readConfig } from "../config.ts";
import type { FetchResponse } from "../types.ts";
import type { UrlInterceptor } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_TOKEN_ENV_VAR = "GITHUB_TOKEN";

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".webp",
	".svg",
	".tiff",
	".tif",
	".mp3",
	".mp4",
	".avi",
	".mov",
	".mkv",
	".flv",
	".wmv",
	".wav",
	".ogg",
	".webm",
	".flac",
	".aac",
	".zip",
	".tar",
	".gz",
	".bz2",
	".xz",
	".7z",
	".rar",
	".zst",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".o",
	".a",
	".lib",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".sqlite",
	".db",
	".sqlite3",
	".pyc",
	".pyo",
	".class",
	".jar",
	".war",
	".iso",
	".img",
	".dmg",
]);

const NOISE_DIRS = new Set([
	"node_modules",
	"vendor",
	".next",
	"dist",
	"build",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	"target",
	".gradle",
	".idea",
	".vscode",
]);

const NON_CODE_SEGMENTS = new Set([
	"issues",
	"pull",
	"pulls",
	"discussions",
	"releases",
	"wiki",
	"actions",
	"settings",
	"security",
	"projects",
	"graphs",
	"compare",
	"commits",
	"tags",
	"branches",
	"stargazers",
	"watchers",
	"network",
	"forks",
	"milestone",
	"labels",
	"packages",
	"codespaces",
	"contribute",
	"community",
	"sponsors",
	"invitations",
	"notifications",
	"insights",
]);

// ---------------------------------------------------------------------------
// GitHub URL parsing
// ---------------------------------------------------------------------------

export interface GitHubUrlInfo {
	owner: string;
	repo: string;
	ref?: string;
	refIsFullSha: boolean;
	path?: string;
	type: "root" | "blob" | "tree";
}

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	const host = parsed.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;

	const segments = parsed.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
	if (segments.length < 2) return null;

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");

	if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

	if (segments.length === 2) {
		return { owner, repo, refIsFullSha: false, type: "root" };
	}

	const action = segments[2];
	if (action !== "blob" && action !== "tree") return null;
	if (segments.length < 4) return null;

	const ref = segments[3];
	const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
	const pathParts = segments.slice(4);
	const path = pathParts.length > 0 ? pathParts.join("/") : "";

	return { owner, repo, ref, refIsFullSha, path, type: action as "blob" | "tree" };
}

// ---------------------------------------------------------------------------
// Resolved options + opt-in resolution
// ---------------------------------------------------------------------------

export interface GitHubInterceptorOptions {
	enabled?: boolean;
	maxRepoSizeMB?: number;
	cloneTimeoutSeconds?: number;
	clonePath?: string;
}

export interface ResolvedGitHubOptions {
	enabled: boolean;
	maxRepoSizeMB: number;
	cloneTimeoutSeconds: number;
	clonePath: string;
}

export const DEFAULTS: ResolvedGitHubOptions = {
	enabled: false,
	maxRepoSizeMB: 350,
	cloneTimeoutSeconds: 30,
	clonePath: join(tmpdir(), "pi-github-repos"),
};

// Two-tier opt-in: user config (~/.config/rpiv-web-tools/config.json under
// `interceptors.github`) wins over the consumer programmatic default passed
// to registerWebTools. Object form implies opt-in; `enabled: false` inside
// an object is redundant but accepted. Boolean `false` at any tier turns
// the interceptor off regardless of any object overrides at lower tiers.
export function resolveGitHubOptions(
	userConfig: boolean | GitHubInterceptorOptions | undefined,
	consumerDefault: boolean | undefined,
): ResolvedGitHubOptions {
	if (userConfig === false) return { ...DEFAULTS, enabled: false };
	if (userConfig === true) return { ...DEFAULTS, enabled: true };
	if (userConfig && typeof userConfig === "object") {
		const enabled = userConfig.enabled ?? true;
		return {
			enabled,
			maxRepoSizeMB: userConfig.maxRepoSizeMB ?? DEFAULTS.maxRepoSizeMB,
			cloneTimeoutSeconds: userConfig.cloneTimeoutSeconds ?? DEFAULTS.cloneTimeoutSeconds,
			clonePath: userConfig.clonePath ?? DEFAULTS.clonePath,
		};
	}
	if (consumerDefault === true) return { ...DEFAULTS, enabled: true };
	return { ...DEFAULTS };
}

// Read the github interceptor stanza off the canonical web-tools config.
// Returns undefined when `interceptors.github` is unset. Delegates schema
// validation + fail-soft handling to `readConfig` so the orchestrator and the
// interceptor see the exact same parsed object — no parallel readers, no
// divergent error formats.
export function readUserGitHubConfig(): boolean | GitHubInterceptorOptions | undefined {
	return readConfig().interceptors?.github as boolean | GitHubInterceptorOptions | undefined;
}

// ---------------------------------------------------------------------------
// Cached clone bookkeeping
// ---------------------------------------------------------------------------

export interface CachedClone {
	localPath: string;
	clonePromise: Promise<string | null>;
}

function cacheKey(owner: string, repo: string, ref?: string): string {
	return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function cloneDir(clonePath: string, owner: string, repo: string, ref?: string): string {
	const dirName = ref ? `${repo}@${ref}` : repo;
	return join(clonePath, owner, dirName);
}

// ---------------------------------------------------------------------------
// GitHubInterceptor — the only non-test-only consumer of all the state above
// ---------------------------------------------------------------------------

export class GitHubInterceptor implements UrlInterceptor {
	readonly name = "github";

	private readonly options: ResolvedGitHubOptions;
	private ghAvailable: boolean | null = null;
	private ghHintShown = false;
	private readonly cloneCache: Map<string, CachedClone>;

	constructor(opts: GitHubInterceptorOptions & { cloneCache?: Map<string, CachedClone> } = {}) {
		const { cloneCache, ...rest } = opts;
		this.options = resolveGitHubOptions(rest, undefined);
		this.cloneCache = cloneCache ?? new Map();
	}

	get resolvedOptions(): ResolvedGitHubOptions {
		return this.options;
	}

	async intercept(
		url: string,
		opts: { raw: boolean; signal?: AbortSignal; forceClone?: boolean },
	): Promise<FetchResponse | null> {
		return this.fetchGitHub(url, opts.signal, opts.forceClone);
	}

	/** @internal — exposed for direct unit testing of the gh-availability probe. */
	async checkGhAvailable(): Promise<boolean> {
		if (this.ghAvailable !== null) return this.ghAvailable;
		return new Promise((resolve) => {
			execFile("gh", ["--version"], { timeout: 5000 }, (err) => {
				this.ghAvailable = !err; // c8 ignore next
				resolve(this.ghAvailable as boolean);
			});
		});
	}

	/** @internal — exposed for direct unit testing of the repo-size probe. */
	async checkRepoSize(owner: string, repo: string): Promise<number | null> {
		if (!(await this.checkGhAvailable())) return null;
		return new Promise((resolve) => {
			execFile("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".size"], { timeout: 10000 }, (err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				const kb = parseInt(stdout.trim(), 10);
				resolve(Number.isNaN(kb) ? null : kb);
			});
		});
	}

	/**
	 * Injects an entry into the clone cache — for testing generateCloneContent
	 * without running a real git clone. Never call in production.
	 * @internal
	 */
	_seedCache(key: string, entry: CachedClone): void {
		this.cloneCache.set(key, entry);
	}

	/**
	 * Clears the in-memory clone cache and removes all cloned directories.
	 * Also resets the gh-availability probe so the next intercept re-checks.
	 * @internal
	 */
	reset(): void {
		for (const entry of this.cloneCache.values()) {
			try {
				rmSync(entry.localPath, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		}
		this.cloneCache.clear();
		this.ghAvailable = null;
		this.ghHintShown = false;
	}

	private showGhHint(): void {
		if (!this.ghHintShown) {
			this.ghHintShown = true;
			console.error("[rpiv-web-tools] Install `gh` CLI for better GitHub repo access including private repos.");
		}
	}

	private async getDefaultBranch(owner: string, repo: string): Promise<string | null> {
		if (!(await this.checkGhAvailable())) return null;
		return new Promise((resolve) => {
			execFile(
				"gh",
				["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"],
				{ timeout: 10000 },
				(err, stdout) => {
					if (err) {
						resolve(null);
						return;
					}
					resolve(stdout.trim() || null);
				},
			);
		});
	}

	private async fetchTreeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
		if (!(await this.checkGhAvailable())) return null;
		return new Promise((resolve) => {
			execFile(
				"gh",
				["api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"],
				{ timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
				(err, stdout) => {
					if (err) {
						resolve(null);
						return;
					}
					const paths = stdout.trim().split("\n").filter(Boolean);
					if (paths.length === 0) {
						resolve(null);
						return;
					}
					const truncated = paths.length > MAX_TREE_ENTRIES;
					const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
					resolve(truncated ? `${display}\n... (${paths.length} total entries)` : display);
				},
			);
		});
	}

	private async fetchReadmeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
		if (!(await this.checkGhAvailable())) return null;
		return new Promise((resolve) => {
			execFile(
				"gh",
				["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
				{ timeout: 10000 },
				(err, stdout) => {
					if (err) {
						resolve(null);
						return;
					}
					try {
						const decoded = Buffer.from(stdout.trim(), "base64").toString("utf-8");
						resolve(
							decoded.length > 8192 ? `${decoded.slice(0, 8192)}\n\n[README truncated at 8K chars]` : decoded,
						);
					} catch {
						resolve(null);
					}
				},
			);
		});
	}

	private async fetchFileViaApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
		if (!(await this.checkGhAvailable())) return null;
		return new Promise((resolve) => {
			execFile(
				"gh",
				["api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"],
				{ timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
				(err, stdout) => {
					if (err) {
						resolve(null);
						return;
					}
					try {
						resolve(Buffer.from(stdout.trim(), "base64").toString("utf-8"));
					} catch {
						resolve(null);
					}
				},
			);
		});
	}

	private async fetchViaApi(
		_url: string,
		owner: string,
		repo: string,
		info: GitHubUrlInfo,
		sizeNote?: string,
	): Promise<FetchResponse | null> {
		const ref = info.ref || (await this.getDefaultBranch(owner, repo));
		if (!ref) return null;

		const lines: string[] = [];
		if (sizeNote) {
			lines.push(sizeNote);
			lines.push("");
		}

		if (info.type === "blob" && info.path) {
			const content = await this.fetchFileViaApi(owner, repo, info.path, ref);
			if (!content) return null;

			lines.push(`## ${info.path}`);
			if (content.length > MAX_INLINE_FILE_CHARS) {
				lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
				lines.push("\n[File truncated at 100K chars]");
			} else {
				lines.push(content);
			}

			const title = `${owner}/${repo} - ${info.path}`;
			return { text: lines.join("\n"), title, contentType: "text/plain" };
		}

		const [tree, readme] = await Promise.all([
			this.fetchTreeViaApi(owner, repo, ref),
			this.fetchReadmeViaApi(owner, repo, ref),
		]);

		if (!tree && !readme) return null;

		if (tree) {
			lines.push("## Structure");
			lines.push(tree);
			lines.push("");
		}
		if (readme) {
			lines.push("## README.md");
			lines.push(readme);
			lines.push("");
		}
		lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");

		const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
		return { text: lines.join("\n"), title, contentType: "text/plain" };
	}

	private execClone(
		args: string[],
		localPath: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<string | null> {
		return new Promise((resolve) => {
			const child = execFile(args[0], args.slice(1), { timeout: timeoutMs }, (err) => {
				if (err) {
					try {
						rmSync(localPath, { recursive: true, force: true });
					} catch {
						// ignore cleanup errors
					}
					resolve(null);
					return;
				}
				resolve(localPath);
			});
			if (signal) {
				const onAbort = () => child.kill();
				signal.addEventListener("abort", onAbort, { once: true });
				child.on("exit", () => signal.removeEventListener("abort", onAbort));
			}
		});
	}

	private async cloneRepo(
		owner: string,
		repo: string,
		ref: string | undefined,
		signal?: AbortSignal,
	): Promise<string | null> {
		const localPath = cloneDir(this.options.clonePath, owner, repo, ref);
		try {
			rmSync(localPath, { recursive: true, force: true });
		} catch {
			// ignore
		}

		const timeoutMs = this.options.cloneTimeoutSeconds * 1000;
		const hasGh = await this.checkGhAvailable();

		if (hasGh) {
			const args = ["gh", "repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
			if (ref) args.push("--branch", ref);
			return this.execClone(args, localPath, timeoutMs, signal);
		}

		this.showGhHint();
		const gitUrl = `https://github.com/${owner}/${repo}.git`;
		const args = ["git", "clone", "--depth", "1", "--single-branch"];
		if (ref) args.push("--branch", ref);
		args.push(gitUrl, localPath);
		return this.execClone(args, localPath, timeoutMs, signal);
	}

	private async awaitCachedClone(
		cached: CachedClone,
		url: string,
		owner: string,
		repo: string,
		info: GitHubUrlInfo,
		signal?: AbortSignal,
	): Promise<FetchResponse | null> {
		if (signal?.aborted) return null;
		const result = await cached.clonePromise;
		if (signal?.aborted) return null;
		if (result) {
			const text = generateCloneContent(result, info);
			const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
			return { text, title, contentType: "text/plain" };
		}
		return this.fetchViaApi(url, owner, repo, info);
	}

	private async fetchGitHub(url: string, signal?: AbortSignal, forceClone?: boolean): Promise<FetchResponse | null> {
		const info = parseGitHubUrl(url);
		if (!info) return null;
		if (signal?.aborted) return null;
		if (!this.options.enabled) return null;

		const { owner, repo } = info;
		const key = cacheKey(owner, repo, info.ref);

		const cached = this.cloneCache.get(key);
		if (cached) return this.awaitCachedClone(cached, url, owner, repo, info, signal);

		if (info.refIsFullSha) {
			if (signal?.aborted) return null;
			const sizeNote = "Note: Commit SHA URLs use the GitHub API instead of cloning.";
			return this.fetchViaApi(url, owner, repo, info, sizeNote);
		}

		if (!forceClone) {
			const sizeKB = await this.checkRepoSize(owner, repo);
			if (signal?.aborted) return null;
			if (sizeKB !== null) {
				const sizeMB = sizeKB / 1024;
				if (sizeMB > this.options.maxRepoSizeMB) {
					if (signal?.aborted) return null;
					const sizeNote =
						`Note: Repository is ${Math.round(sizeMB)}MB (threshold: ${this.options.maxRepoSizeMB}MB). ` +
						`Showing API-fetched content instead of full clone. Ask the user if they'd like to clone the full repo — ` +
						`if yes, call web_fetch again with the same URL.`;
					const apiView = await this.fetchViaApi(url, owner, repo, info, sizeNote);
					if (apiView) return apiView;
					return null;
				}
			}
		}

		/* c8 ignore next */
		if (signal?.aborted) return null;

		const cachedAfterCheck = this.cloneCache.get(key);
		if (cachedAfterCheck) return this.awaitCachedClone(cachedAfterCheck, url, owner, repo, info, signal);

		const clonePromise = this.cloneRepo(owner, repo, info.ref, signal);
		const localPath = cloneDir(this.options.clonePath, owner, repo, info.ref);
		this.cloneCache.set(key, { localPath, clonePromise });

		const result = await clonePromise;
		/* c8 ignore next 4 */
		if (signal?.aborted) {
			if (!result) this.cloneCache.delete(key);
			return null;
		}

		if (!result) {
			this.cloneCache.delete(key);
			/* c8 ignore next */
			if (signal?.aborted) return null;
			return this.fetchViaApi(url, owner, repo, info);
		}

		const text = generateCloneContent(result, info);
		const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
		return { text, title, contentType: "text/plain" };
	}
}

// ---------------------------------------------------------------------------
// Local clone content generation (pure functions; safe to keep at module scope)
// ---------------------------------------------------------------------------

function isBinaryFile(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return true;

	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return false;
	}
	try {
		const buf = Buffer.alloc(512);
		const bytesRead = readSync(fd, buf, 0, 512, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
	} catch /* c8 ignore next */ {
		return false;
	} finally {
		closeSync(fd);
	}

	return false;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveWithinRepo(rootPath: string, relativePath: string): string | null {
	const normalizedRoot = resolvePath(rootPath);
	const candidate = resolvePath(normalizedRoot, relativePath);
	if (candidate !== normalizedRoot) {
		const rootPrefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
		if (!candidate.startsWith(rootPrefix)) return null;
	}
	if (!existsSync(candidate)) return candidate;
	try {
		const realRoot = realpathSync(normalizedRoot);
		const realCandidate = realpathSync(candidate);
		if (realCandidate === realRoot) return candidate;
		const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
		return realCandidate.startsWith(realRootPrefix) ? candidate : null;
	} catch /* c8 ignore next */ {
		return null;
	}
}

function buildTree(rootPath: string): string {
	const entries: string[] = [];

	function walk(dir: string, relPath: string): void {
		if (entries.length >= MAX_TREE_ENTRIES) return;
		let items: string[];
		try {
			items = readdirSync(dir).sort();
		} catch /* c8 ignore next */ {
			return;
		}
		for (const item of items) {
			if (entries.length >= MAX_TREE_ENTRIES) return;
			if (item === ".git") continue;
			const rel = relPath ? `${relPath}/${item}` : item;
			const safePath = resolveWithinRepo(rootPath, rel);
			if (!safePath) {
				entries.push(`${rel}  [outside repo skipped]`);
				continue;
			}
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(safePath);
			} catch /* c8 ignore next */ {
				continue;
			}
			if (stat.isDirectory()) {
				if (NOISE_DIRS.has(item)) {
					entries.push(`${rel}/  [skipped]`);
					continue;
				}
				entries.push(`${rel}/`);
				walk(safePath, rel);
			} else {
				entries.push(rel);
			}
		}
	}

	walk(rootPath, "");
	if (entries.length >= MAX_TREE_ENTRIES) {
		entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
	}
	return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
	const targetPath = resolveWithinRepo(rootPath, subPath);
	if (!targetPath) return "(path escapes repository root)";
	const lines: string[] = [];
	let items: string[];
	try {
		items = readdirSync(targetPath).sort();
	} catch /* c8 ignore next */ {
		return "(directory not readable)";
	}
	for (const item of items) {
		if (item === ".git") continue;
		const rel = subPath ? `${subPath}/${item}` : item;
		const safePath = resolveWithinRepo(rootPath, rel);
		if (!safePath) {
			lines.push(`  ${item}  (outside repo)`);
			continue;
		}
		try {
			const stat = statSync(safePath);
			lines.push(stat.isDirectory() ? `  ${item}/` : `  ${item}  (${formatFileSize(stat.size)})`);
		} catch /* c8 ignore next */ {
			lines.push(`  ${item}  (unreadable)`);
		}
	}
	return lines.join("\n");
}

function readReadme(localPath: string): string | null {
	const candidates = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
	for (const name of candidates) {
		const readmePath = join(localPath, name);
		if (existsSync(readmePath)) {
			try {
				const content = readFileSync(readmePath, "utf-8");
				return content.length > 8192 ? `${content.slice(0, 8192)}\n\n[README truncated at 8K chars]` : content;
			} catch {}
		}
	}
	return null;
}

function generateCloneContent(localPath: string, info: GitHubUrlInfo): string {
	const lines: string[] = [];
	lines.push(`Repository cloned to: ${localPath}`);
	lines.push("");

	if (info.type === "root") {
		lines.push("## Structure");
		lines.push(buildTree(localPath));
		lines.push("");
		const readme = readReadme(localPath);
		if (readme) {
			lines.push("## README.md");
			lines.push(readme);
			lines.push("");
		}
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (info.type === "tree") {
		const dirPath = info.path || "";
		const fullDirPath = resolveWithinRepo(localPath, dirPath);
		if (!fullDirPath || !existsSync(fullDirPath)) {
			lines.push(`Path \`${dirPath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(buildTree(localPath));
		} else {
			lines.push(`## ${dirPath || "/"}`);
			lines.push(buildDirListing(localPath, dirPath));
		}
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	// blob
	const filePath = info.path || "";
	const fullFilePath = resolveWithinRepo(localPath, filePath);
	if (!fullFilePath || !existsSync(fullFilePath)) {
		lines.push(`Path \`${filePath}\` not found in clone. Showing repository root instead.`);
		lines.push("");
		lines.push("## Structure");
		lines.push(buildTree(localPath));
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(fullFilePath);
	} catch (err) /* c8 ignore next */ {
		const message = err instanceof Error ? err.message : String(err);
		lines.push(`Could not inspect \`${filePath}\`: ${message}`);
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (stat.isDirectory()) {
		lines.push(`## ${filePath || "/"}`);
		lines.push(buildDirListing(localPath, filePath));
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (isBinaryFile(fullFilePath)) {
		const ext = extname(filePath).replace(".", "");
		lines.push(`## ${filePath}`);
		lines.push(
			`Binary file (${ext}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`,
		);
		return lines.join("\n");
	}

	let content: string;
	try {
		content = readFileSync(fullFilePath, "utf-8");
	} catch {
		lines.push(`Could not read \`${filePath}\` as UTF-8 text.`);
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	lines.push(`## ${filePath}`);
	if (content.length > MAX_INLINE_FILE_CHARS) {
		lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
		lines.push(`\n[File truncated at 100K chars. Full file: ${fullFilePath}]`);
	} else {
		lines.push(content);
	}
	lines.push("");
	lines.push("Use `read` and `bash` tools at the path above to explore further.");
	return lines.join("\n");
}
