/**
 * rpiv-web-tools — Pi extension
 *
 * Registers the `web_search` and `web_fetch` tools, plus the
 * `/web-search-config` slash command. Body lives in `web-tools.ts`.
 *
 * Config persists at ~/.config/rpiv-web-tools/config.json. Per-provider env
 * vars (e.g. BRAVE_SEARCH_API_KEY, TAVILY_API_KEY) win over the config file.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebFetchTool, registerWebSearchConfigCommand, registerWebSearchTool } from "./web-tools.js";

export { createSearchProvider } from "./providers/factory.js";

export type { FetchResponse, SearchProvider, SearchResponse, SearchResult } from "./providers/types.js";
export {
	DEFAULT_WEB_FETCH_GUIDELINES,
	DEFAULT_WEB_FETCH_SNIPPET,
	DEFAULT_WEB_SEARCH_GUIDELINES,
	DEFAULT_WEB_SEARCH_SNIPPET,
	registerWebFetchTool,
	registerWebSearchConfigCommand,
	registerWebSearchTool,
} from "./web-tools.js";

export default function (pi: ExtensionAPI) {
	registerWebSearchTool(pi);
	registerWebFetchTool(pi);
	registerWebSearchConfigCommand(pi);
}
