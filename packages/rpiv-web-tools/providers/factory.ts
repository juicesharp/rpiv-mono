import { BraveProvider } from "./brave.js";
import { ExaProvider } from "./exa.js";
import { FirecrawlProvider } from "./firecrawl.js";
import { JinaProvider } from "./jina.js";
import { KagiProvider } from "./kagi.js";
import { OllamaProvider } from "./ollama.js";
import { PerplexityProvider } from "./perplexity.js";
import { SearxngProvider } from "./searxng.js";
import { SerperProvider } from "./serper.js";
import { TavilyProvider } from "./tavily.js";
import type { FullProvider, SearchProvider } from "./types.js";
import { YouComProvider } from "./youcom.js";

export interface ProviderCredentials {
	apiKey?: string;
	baseUrl?: string;
}

// The return union mirrors the role split: Brave/Kagi/Perplexity/Serper/SearXNG
// are search-only (SearchProvider); full providers expose native fetch endpoints
// (FullProvider). Consumers narrow with `"fetch" in provider` when they need
// to dispatch on capability.
export function createSearchProvider(name: string, creds: ProviderCredentials): SearchProvider | FullProvider {
	const apiKey = creds.apiKey ?? "";
	switch (name) {
		case "brave":
			return new BraveProvider(apiKey);
		case "tavily":
			return new TavilyProvider(apiKey);
		case "serper":
			return new SerperProvider(apiKey);
		case "exa":
			return new ExaProvider(apiKey);
		case "youcom":
			return new YouComProvider(apiKey);
		case "jina":
			return new JinaProvider(apiKey);
		case "kagi":
			return new KagiProvider(apiKey);
		case "firecrawl":
			return new FirecrawlProvider(apiKey);
		case "perplexity":
			return new PerplexityProvider(apiKey);
		case "searxng":
			return new SearxngProvider({ apiKey: creds.apiKey, baseUrl: creds.baseUrl ?? "" });
		case "ollama":
			return new OllamaProvider({ apiKey: creds.apiKey, baseUrl: creds.baseUrl ?? "" });
		default:
			throw new Error(`Unknown search provider: "${name}"`);
	}
}
