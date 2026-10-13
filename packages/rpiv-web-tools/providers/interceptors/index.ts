import { GitHubInterceptor, readUserGitHubConfig, resolveGitHubOptions } from "./github.js";
import type { UrlInterceptor } from "./types.js";

export {
	DEFAULTS as GITHUB_INTERCEPTOR_DEFAULTS,
	GITHUB_TOKEN_ENV_VAR,
	GitHubInterceptor,
	type GitHubInterceptorOptions,
	type GitHubUrlInfo,
	parseGitHubUrl,
	type ResolvedGitHubOptions,
	readUserGitHubConfig,
	resolveGitHubOptions,
} from "./github.js";
export type { UrlInterceptor } from "./types.js";

// Package-private singletons set by registerWebTools at startup. The
// orchestrator reads `getInterceptors()` per-request rather than caching the
// array reference, so re-registration (rare, but covered by tests) is honored
// without leaking stale state.
let activeInterceptors: UrlInterceptor[] = [];
let activeGitHubInterceptor: GitHubInterceptor | null = null;

export interface BuildInterceptorsOptions {
	github?: boolean;
}

export function buildInterceptors(consumer?: BuildInterceptorsOptions): UrlInterceptor[] {
	const userCfg = readUserGitHubConfig();
	const resolved = resolveGitHubOptions(userCfg, consumer?.github);
	if (resolved.enabled) {
		activeGitHubInterceptor = new GitHubInterceptor(resolved);
		activeInterceptors = [activeGitHubInterceptor];
	} else {
		activeGitHubInterceptor = null;
		activeInterceptors = [];
	}
	return activeInterceptors;
}

export function getInterceptors(): readonly UrlInterceptor[] {
	return activeInterceptors;
}

export function getActiveGitHubInterceptor(): GitHubInterceptor | null {
	return activeGitHubInterceptor;
}

// Public free-function alias for test cleanup. Resets the active GitHub
// interceptor (if any),
// routed through the class rather than module-level state.
export function clearCloneCache(): void {
	activeGitHubInterceptor?.reset();
}

// Called from test/setup.ts beforeEach — closes the repo-wide reset contract
// PR #45 left open. Resets the active interceptor's state AND drops the
// active set, so the next registerWebTools call starts from scratch.
export function __resetWebToolsInterceptors(): void {
	activeGitHubInterceptor?.reset();
	activeGitHubInterceptor = null;
	activeInterceptors = [];
}
