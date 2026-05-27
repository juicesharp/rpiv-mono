import { BRAVE_PROVIDER_META } from "./brave.js";
import { EXA_PROVIDER_META } from "./exa.js";
import { FIRECRAWL_PROVIDER_META } from "./firecrawl.js";
import { GITHUB_PROVIDER_META } from "./github.js";
import { JINA_PROVIDER_META } from "./jina.js";
import { OLLAMA_PROVIDER_META } from "./ollama.js";
import { SEARXNG_PROVIDER_META } from "./searxng.js";
import { SERPER_PROVIDER_META } from "./serper.js";
import { TAVILY_PROVIDER_META } from "./tavily.js";
import type { ProviderMeta } from "./types.js";

export { BRAVE_API_KEY_ENV_VAR, BRAVE_PROVIDER_META, BraveProvider } from "./brave.js";
export { EXA_API_KEY_ENV_VAR, EXA_PROVIDER_META, ExaProvider } from "./exa.js";
export { createSearchProvider, type ProviderCredentials } from "./factory.js";
export { FIRECRAWL_API_KEY_ENV_VAR, FIRECRAWL_PROVIDER_META, FirecrawlProvider } from "./firecrawl.js";
export {
	clearCloneCache,
	extractGitHub,
	GITHUB_PROVIDER_META,
	GITHUB_TOKEN_ENV_VAR,
	GitHubProvider,
	type GitHubUrlInfo,
	parseGitHubUrl,
} from "./github.js";
export { JINA_API_KEY_ENV_VAR, JINA_PROVIDER_META, JinaProvider } from "./jina.js";
export {
	configureOllama,
	OLLAMA_API_KEY_ENV_VAR,
	OLLAMA_DEFAULT_URL,
	OLLAMA_HOST_ENV_VAR,
	OLLAMA_PROVIDER_META,
	OllamaProvider,
} from "./ollama.js";
export {
	configureSearxng,
	SEARXNG_API_KEY_ENV_VAR,
	SEARXNG_DEFAULT_URL,
	SEARXNG_PROVIDER_META,
	SEARXNG_URL_ENV_VAR,
	type SearxngConfigChange,
	type SearxngConfigCurrent,
	type SearxngConfigUi,
	SearxngProvider,
} from "./searxng.js";
export { SERPER_API_KEY_ENV_VAR, SERPER_PROVIDER_META, SerperProvider } from "./serper.js";
export { TAVILY_API_KEY_ENV_VAR, TAVILY_PROVIDER_META, TavilyProvider } from "./tavily.js";
export type {
	FetchResponse,
	ProviderConfigChange,
	ProviderConfigCurrent,
	ProviderConfigUi,
	ProviderMeta,
	SearchProvider,
	SearchResponse,
	SearchResult,
} from "./types.js";

// Typed as readonly ProviderMeta[] (not `as const`) so iterators can access
// the optional META fields (baseUrlEnvVar, defaultBaseUrl, configure) without
// per-element narrowing. Individual META consts still expose their narrow
// literal types when imported directly.
export const PROVIDERS: readonly ProviderMeta[] = [
	BRAVE_PROVIDER_META,
	TAVILY_PROVIDER_META,
	SERPER_PROVIDER_META,
	EXA_PROVIDER_META,
	JINA_PROVIDER_META,
	FIRECRAWL_PROVIDER_META,
	SEARXNG_PROVIDER_META,
	OLLAMA_PROVIDER_META,
	GITHUB_PROVIDER_META,
];
