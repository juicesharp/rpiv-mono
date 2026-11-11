import { BRAVE_PROVIDER_META } from "./brave.ts";
import { EXA_PROVIDER_META } from "./exa.ts";
import { FIRECRAWL_PROVIDER_META } from "./firecrawl.ts";
import { JINA_PROVIDER_META } from "./jina.ts";
import { OLLAMA_PROVIDER_META } from "./ollama.ts";
import { PERPLEXITY_PROVIDER_META } from "./perplexity.ts";
import { SEARXNG_PROVIDER_META } from "./searxng.ts";
import { SERPER_PROVIDER_META } from "./serper.ts";
import { TAVILY_PROVIDER_META } from "./tavily.ts";
import type { ProviderMeta } from "./types.ts";
import { YOUCOM_PROVIDER_META } from "./youcom.ts";

export { BRAVE_API_KEY_ENV_VAR, BRAVE_PROVIDER_META, BraveProvider } from "./brave.ts";
export { EXA_API_KEY_ENV_VAR, EXA_PROVIDER_META, ExaProvider } from "./exa.ts";
export { createSearchProvider, type ProviderCredentials } from "./factory.ts";
export { FIRECRAWL_API_KEY_ENV_VAR, FIRECRAWL_PROVIDER_META, FirecrawlProvider } from "./firecrawl.ts";
// URL interceptors live in providers/interceptors/. The github primitives
// (parseGitHubUrl, GitHubUrlInfo, etc.) are re-exported from there.
export {
	clearCloneCache,
	GITHUB_TOKEN_ENV_VAR,
	GitHubInterceptor,
	type GitHubInterceptorOptions,
	type GitHubUrlInfo,
	parseGitHubUrl,
	type UrlInterceptor,
} from "./interceptors/index.ts";
export { JINA_API_KEY_ENV_VAR, JINA_PROVIDER_META, JinaProvider } from "./jina.ts";
export {
	configureOllama,
	OLLAMA_API_KEY_ENV_VAR,
	OLLAMA_DEFAULT_URL,
	OLLAMA_HOST_ENV_VAR,
	OLLAMA_PROVIDER_META,
	OllamaProvider,
} from "./ollama.ts";
export { PERPLEXITY_API_KEY_ENV_VAR, PERPLEXITY_PROVIDER_META, PerplexityProvider } from "./perplexity.ts";
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
} from "./searxng.ts";
export { SERPER_API_KEY_ENV_VAR, SERPER_PROVIDER_META, SerperProvider } from "./serper.ts";
export { TAVILY_API_KEY_ENV_VAR, TAVILY_PROVIDER_META, TavilyProvider } from "./tavily.ts";
export type {
	FetchProvider,
	FetchResponse,
	FullProvider,
	ProviderConfigChange,
	ProviderConfigCurrent,
	ProviderConfigUi,
	ProviderMeta,
	ProviderRole,
	SearchProvider,
	SearchResponse,
	SearchResult,
} from "./types.ts";
export { YDC_API_KEY_ENV_VAR, YOUCOM_API_KEY_ENV_VAR, YOUCOM_PROVIDER_META, YouComProvider } from "./youcom.ts";

// Typed as readonly ProviderMeta[] (not `as const`) so iterators can access
// the optional META fields (baseUrlEnvVar, defaultBaseUrl, configure) without
// per-element narrowing. Individual META consts still expose their narrow
// literal types when imported directly.
export const PROVIDERS: readonly ProviderMeta[] = [
	BRAVE_PROVIDER_META,
	TAVILY_PROVIDER_META,
	SERPER_PROVIDER_META,
	EXA_PROVIDER_META,
	YOUCOM_PROVIDER_META,
	JINA_PROVIDER_META,
	FIRECRAWL_PROVIDER_META,
	PERPLEXITY_PROVIDER_META,
	SEARXNG_PROVIDER_META,
	OLLAMA_PROVIDER_META,
];
