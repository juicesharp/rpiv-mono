import { BraveProvider } from "./brave.js";
import { ExaProvider } from "./exa.js";
import { FirecrawlProvider } from "./firecrawl.js";
import { JinaProvider } from "./jina.js";
import { OllamaProvider } from "./ollama.js";
import { SearxngProvider } from "./searxng.js";
import { SerperProvider } from "./serper.js";
import { TavilyProvider } from "./tavily.js";
import type { SearchProvider } from "./types.js";

export interface ProviderCredentials {
	apiKey?: string;
	baseUrl?: string;
}

export function createSearchProvider(name: string, creds: ProviderCredentials): SearchProvider {
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
		case "jina":
			return new JinaProvider(apiKey);
		case "firecrawl":
			return new FirecrawlProvider(apiKey);
		case "searxng":
			return new SearxngProvider({ apiKey: creds.apiKey, baseUrl: creds.baseUrl ?? "" });
		case "ollama":
			return new OllamaProvider({ apiKey: creds.apiKey, baseUrl: creds.baseUrl ?? "" });
		default:
			throw new Error(`Unknown search provider: "${name}"`);
	}
}
