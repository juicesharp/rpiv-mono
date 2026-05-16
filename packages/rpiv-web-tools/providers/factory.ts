import { BraveProvider } from "./brave.js";
import { ExaProvider } from "./exa.js";
import { FirecrawlProvider } from "./firecrawl.js";
import { JinaProvider } from "./jina.js";
import { SerperProvider } from "./serper.js";
import { TavilyProvider } from "./tavily.js";
import type { SearchProvider } from "./types.js";

export function createSearchProvider(name: string, apiKey: string): SearchProvider {
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
		default:
			throw new Error(`Unknown search provider: "${name}"`);
	}
}
