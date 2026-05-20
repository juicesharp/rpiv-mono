import { BRAVE_PROVIDER_META } from "./brave.js";
import { EXA_PROVIDER_META } from "./exa.js";
import { FIRECRAWL_PROVIDER_META } from "./firecrawl.js";
import { JINA_PROVIDER_META } from "./jina.js";
import { SEARXNG_PROVIDER_META } from "./searxng.js";
import { SERPER_PROVIDER_META } from "./serper.js";
import { TAVILY_PROVIDER_META } from "./tavily.js";

export { BRAVE_API_KEY_ENV_VAR, BRAVE_PROVIDER_META, BraveProvider } from "./brave.js";
export { EXA_API_KEY_ENV_VAR, EXA_PROVIDER_META, ExaProvider } from "./exa.js";
export { createSearchProvider, type ProviderCredentials } from "./factory.js";
export { FIRECRAWL_API_KEY_ENV_VAR, FIRECRAWL_PROVIDER_META, FirecrawlProvider } from "./firecrawl.js";
export { JINA_API_KEY_ENV_VAR, JINA_PROVIDER_META, JinaProvider } from "./jina.js";
export {
	SEARXNG_API_KEY_ENV_VAR,
	SEARXNG_DEFAULT_URL,
	SEARXNG_PROVIDER_META,
	SEARXNG_URL_ENV_VAR,
	SearxngProvider,
} from "./searxng.js";
export { SERPER_API_KEY_ENV_VAR, SERPER_PROVIDER_META, SerperProvider } from "./serper.js";
export { TAVILY_API_KEY_ENV_VAR, TAVILY_PROVIDER_META, TavilyProvider } from "./tavily.js";
export type { FetchResponse, SearchProvider, SearchResponse, SearchResult } from "./types.js";

export const PROVIDERS = [
	BRAVE_PROVIDER_META,
	TAVILY_PROVIDER_META,
	SERPER_PROVIDER_META,
	EXA_PROVIDER_META,
	JINA_PROVIDER_META,
	FIRECRAWL_PROVIDER_META,
	SEARXNG_PROVIDER_META,
] as const;
