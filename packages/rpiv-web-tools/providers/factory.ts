import { BraveProvider } from "./brave.ts";
import { ExaProvider } from "./exa.ts";
import { FirecrawlProvider } from "./firecrawl.ts";
import { JinaProvider } from "./jina.ts";
import { OllamaProvider } from "./ollama.ts";
import { PerplexityProvider } from "./perplexity.ts";
import { SearxngProvider } from "./searxng.ts";
import { SerperProvider } from "./serper.ts";
import { TavilyProvider } from "./tavily.ts";
import type { FullProvider, SearchProvider } from "./types.ts";
import { YouComProvider } from "./youcom.ts";

export interface ProviderCredentials {
	apiKey?: string;
	baseUrl?: string;
}

// The return union mirrors the role split: Brave/Serper/SearXNG are search-
// only (SearchProvider); the other five expose native fetch endpoints too
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
