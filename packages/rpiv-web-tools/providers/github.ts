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
import { homedir } from "node:os";
import { extname, join, sep as pathSep, resolve as resolvePath } from "node:path";
import { assertTextContentType, extractBodyAsText, fetchUrlOrThrow } from "./fetch-helpers.js";
import type { FetchResponse, SearchProvider, SearchResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_TOKEN_ENV_VAR = "GITHUB_TOKEN";

export const GITHUB_PROVIDER_META = {
	name: "github",
	label: "GitHub",
	envVar: GITHUB_TOKEN_ENV_VAR,
} as const;

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

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
// gh CLI availability
// ---------------------------------------------------------------------------

let ghAvailable: boolean | null = null;
let ghHintShown = false;

export async function checkGhAvailable(): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;
	return new Promise((resolve) => {
		execFile("gh", ["--version"], { timeout: 5000 }, (err) => {
			ghAvailable = !err; // c8 ignore next
			resolve(ghAvailable as boolean);
		});
	});
}

function showGhHint(): void {
	if (!ghHintShown) {
		ghHintShown = true;
		console.error("[rpiv-web-tools] Install `gh` CLI for better GitHub repo access including private repos.");
	}
}

// ---------------------------------------------------------------------------
// Repo size check
// ---------------------------------------------------------------------------

export async function checkRepoSize(owner: string, repo: string): Promise<number | null> {
	if (!(await checkGhAvailable())) return null;
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

// ---------------------------------------------------------------------------
// GitHub API (API-only fetch path)
// ---------------------------------------------------------------------------

async function getDefaultBranch(owner: string, repo: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;
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

async function fetchTreeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;
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
				resolve(truncated ? display + `\n... (${paths.length} total entries)` : display);
			},
		);
	});
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;
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
					resolve(decoded.length > 8192 ? decoded.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : decoded);
				} catch {
					resolve(null);
				}
			},
		);
	});
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;
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

async function fetchViaApi(
	_url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	sizeNote?: string,
): Promise<FetchResponse | null> {
	const ref = info.ref || (await getDefaultBranch(owner, repo));
	if (!ref) return null;

	const lines: string[] = [];
	if (sizeNote) {
		lines.push(sizeNote);
		lines.push("");
	}

	if (info.type === "blob" && info.path) {
		const content = await fetchFileViaApi(owner, repo, info.path, ref);
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

	const [tree, readme] = await Promise.all([fetchTreeViaApi(owner, repo, ref), fetchReadmeViaApi(owner, repo, ref)]);

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

// ---------------------------------------------------------------------------
// Clone config
// ---------------------------------------------------------------------------

interface GitHubCloneConfig {
	enabled: boolean;
	maxRepoSizeMB: number;
	cloneTimeoutSeconds: number;
	clonePath: string;
}

let cachedCloneConfig: GitHubCloneConfig | null = null;

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}

function normalizeClonePath(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}

function loadCloneConfig(): GitHubCloneConfig {
	if (cachedCloneConfig) return cachedCloneConfig;

	const defaults: GitHubCloneConfig = {
		enabled: true,
		maxRepoSizeMB: 350,
		cloneTimeoutSeconds: 30,
		clonePath: "/tmp/pi-github-repos",
	};

	if (!existsSync(CONFIG_PATH)) {
		/* c8 ignore next 2 */
		cachedCloneConfig = defaults;
		return cachedCloneConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: {
		githubClone?: {
			enabled?: unknown;
			maxRepoSizeMB?: unknown;
			cloneTimeoutSeconds?: unknown;
			clonePath?: unknown;
		};
	};
	try {
		raw = JSON.parse(rawText) as typeof raw;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const gc = raw.githubClone ?? {};
	cachedCloneConfig = {
		enabled: normalizeEnabled(gc.enabled, defaults.enabled),
		maxRepoSizeMB: normalizePositiveNumber(gc.maxRepoSizeMB, defaults.maxRepoSizeMB),
		cloneTimeoutSeconds: normalizePositiveNumber(gc.cloneTimeoutSeconds, defaults.cloneTimeoutSeconds),
		clonePath: normalizeClonePath(gc.clonePath, defaults.clonePath),
	};
	return cachedCloneConfig;
}

// ---------------------------------------------------------------------------
// Clone cache
// ---------------------------------------------------------------------------

interface CachedClone {
	localPath: string;
	clonePromise: Promise<string | null>;
}

const cloneCache = new Map<string, CachedClone>();

function cacheKey(owner: string, repo: string, ref?: string): string {
	return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function cloneDir(config: GitHubCloneConfig, owner: string, repo: string, ref?: string): string {
	const dirName = ref ? `${repo}@${ref}` : repo;
	return join(config.clonePath, owner, dirName);
}

function execClone(args: string[], localPath: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
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

async function cloneRepo(
	owner: string,
	repo: string,
	ref: string | undefined,
	config: GitHubCloneConfig,
	signal?: AbortSignal,
): Promise<string | null> {
	const localPath = cloneDir(config, owner, repo, ref);
	try {
		rmSync(localPath, { recursive: true, force: true });
	} catch {
		// ignore
	}

	const timeoutMs = config.cloneTimeoutSeconds * 1000;
	const hasGh = await checkGhAvailable();

	if (hasGh) {
		const args = ["gh", "repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
		if (ref) args.push("--branch", ref);
		return execClone(args, localPath, timeoutMs, signal);
	}

	showGhHint();
	const gitUrl = `https://github.com/${owner}/${repo}.git`;
	const args = ["git", "clone", "--depth", "1", "--single-branch"];
	if (ref) args.push("--branch", ref);
	args.push(gitUrl, localPath);
	return execClone(args, localPath, timeoutMs, signal);
}

// ---------------------------------------------------------------------------
// Local clone content generation
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
				return content.length > 8192 ? content.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : content;
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

// ---------------------------------------------------------------------------
// Clone path helpers
// ---------------------------------------------------------------------------

async function awaitCachedClone(
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
	return fetchViaApi(url, owner, repo, info);
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Fetches GitHub repository content for a github.com URL.
 * Tries to clone the repo (via `gh` CLI or `git`) for full file access;
 * falls back to the GitHub REST API for large repos or when clone fails.
 * Returns null for non-GitHub URLs or when the URL is not a recognized code URL.
 */
export async function extractGitHub(
	url: string,
	signal?: AbortSignal,
	forceClone?: boolean,
): Promise<FetchResponse | null> {
	const info = parseGitHubUrl(url);
	if (!info) return null;
	if (signal?.aborted) return null;

	const config = loadCloneConfig();
	if (!config.enabled) return null;

	const { owner, repo } = info;
	const key = cacheKey(owner, repo, info.ref);

	const cached = cloneCache.get(key);
	if (cached) return awaitCachedClone(cached, url, owner, repo, info, signal);

	if (info.refIsFullSha) {
		if (signal?.aborted) return null;
		const sizeNote = "Note: Commit SHA URLs use the GitHub API instead of cloning.";
		return fetchViaApi(url, owner, repo, info, sizeNote);
	}

	if (!forceClone) {
		const sizeKB = await checkRepoSize(owner, repo);
		if (signal?.aborted) return null;
		if (sizeKB !== null) {
			const sizeMB = sizeKB / 1024;
			if (sizeMB > config.maxRepoSizeMB) {
				if (signal?.aborted) return null;
				const sizeNote =
					`Note: Repository is ${Math.round(sizeMB)}MB (threshold: ${config.maxRepoSizeMB}MB). ` +
					`Showing API-fetched content instead of full clone. Ask the user if they'd like to clone the full repo — ` +
					`if yes, call web_fetch again with the same URL.`;
				const apiView = await fetchViaApi(url, owner, repo, info, sizeNote);
				if (apiView) return apiView;
				return null;
			}
		}
	}

	/* c8 ignore next */
	if (signal?.aborted) return null;

	// Re-check after size check: concurrent caller may have started a clone
	const cachedAfterCheck = cloneCache.get(key);
	if (cachedAfterCheck) return awaitCachedClone(cachedAfterCheck, url, owner, repo, info, signal);

	const clonePromise = cloneRepo(owner, repo, info.ref, config, signal);
	const localPath = cloneDir(config, owner, repo, info.ref);
	cloneCache.set(key, { localPath, clonePromise });

	const result = await clonePromise;
	/* c8 ignore next 4 */
	if (signal?.aborted) {
		if (!result) cloneCache.delete(key);
		return null;
	}

	if (!result) {
		cloneCache.delete(key);
		/* c8 ignore next */
		if (signal?.aborted) return null;
		return fetchViaApi(url, owner, repo, info);
	}

	const text = generateCloneContent(result, info);
	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return { text, title, contentType: "text/plain" };
}

/**
 * Injects an entry into the clone cache — for testing generateCloneContent
 * without running a real git clone. Never call in production.
 * @internal
 */
export function __addToCloneCache(key: string, localPath: string, clonePromise: Promise<string | null>): void {
	cloneCache.set(key, { localPath, clonePromise });
}

/**
 * Clears the in-memory clone cache and removes all cloned directories.
 * Exported for test cleanup.
 */
export function clearCloneCache(): void {
	for (const entry of cloneCache.values()) {
		try {
			rmSync(entry.localPath, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	cloneCache.clear();
	cachedCloneConfig = null;
	ghAvailable = null;
}

// ---------------------------------------------------------------------------
// SearchProvider class
// ---------------------------------------------------------------------------

export class GitHubProvider implements SearchProvider {
	readonly name = GITHUB_PROVIDER_META.name;
	readonly label = GITHUB_PROVIDER_META.label;
	readonly envVar = GITHUB_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	// GitHub is not a search provider. This stub satisfies the SearchProvider
	// interface contract and surfaces a helpful error when web_search is used
	// with provider: "github".
	async search(_query: string, _maxResults: number, _signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(`${this.envVar} is not set. Run /web-search-config to configure, or export the env var.`);
		}
		throw new Error(
			"GitHub does not support web search. Use web_fetch with a github.com URL to access repository content instead.",
		);
	}

	// No apiKey guard: GitHubProvider's fetch() wraps the built-in
	// HTTP+htmlToText pipeline for non-GitHub URLs and does not call any
	// vendor endpoint — same contract as Brave/Serper/SearXNG.
	async fetch(url: string, raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		const res = await fetchUrlOrThrow(url, signal);
		const contentType = res.headers.get("content-type") ?? "";
		assertTextContentType(contentType);
		const { text, title } = await extractBodyAsText(res, contentType, raw);
		const contentLengthHeader = res.headers.get("content-length");
		return {
			text,
			title,
			contentType: contentType || undefined,
			contentLength: contentLengthHeader ? Number(contentLengthHeader) : undefined,
		};
	}
}
