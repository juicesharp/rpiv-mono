/**
 * rpiv-web-tools — Pi extension
 *
 * Registers the `web_search` and `web_fetch` tools, plus the
 * `/web-tools` slash command. Body lives in `web-tools.ts`.
 *
 * Config persists at ~/.config/rpiv-web-tools/config.json. Per-provider env
 * vars (e.g. BRAVE_SEARCH_API_KEY, TAVILY_API_KEY) win over the config file.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInterceptors } from "./providers/interceptors/index.ts";
import { registerWebFetchTool, registerWebSearchConfigCommand, registerWebSearchTool } from "./web-tools.ts";

export { createSearchProvider } from "./providers/factory.ts";
export {
	GITHUB_TOKEN_ENV_VAR,
	GitHubInterceptor,
	type GitHubInterceptorOptions,
	type GitHubUrlInfo,
	parseGitHubUrl,
	resolveGitHubOptions,
	type UrlInterceptor,
} from "./providers/interceptors/index.ts";

export type {
	FetchProvider,
	FetchResponse,
	FullProvider,
	SearchProvider,
	SearchResponse,
	SearchResult,
} from "./providers/types.ts";
export {
	DEFAULT_WEB_FETCH_GUIDELINES,
	DEFAULT_WEB_FETCH_SNIPPET,
	DEFAULT_WEB_SEARCH_GUIDELINES,
	DEFAULT_WEB_SEARCH_SNIPPET,
	registerWebFetchTool,
	registerWebSearchConfigCommand,
	registerWebSearchTool,
} from "./web-tools.ts";

// Programmatic consumer-side opt-in for URL interceptors. Tier 2 in the
// resolution model: end-user config (Tier 1) still wins. Default OFF —
// existing rpiv-web-tools users see zero behavior change.
export interface RegisterOptions {
	interceptors?: {
		github?: boolean;
	};
}

export default function registerWebTools(pi: ExtensionAPI, opts?: RegisterOptions): void {
	buildInterceptors(opts?.interceptors);
	registerWebSearchTool(pi);
	registerWebFetchTool(pi);
	registerWebSearchConfigCommand(pi);
}
