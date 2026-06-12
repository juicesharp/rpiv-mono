import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
	site: "https://rpiv-pi.com",
	output: "static",
	trailingSlash: "ignore",
	build: {
		assets: "_astro",
		inlineStylesheets: "always",
	},
	// /classic is the archived previous landing, kept for comparison — out of
	// the sitemap (it also carries a noindex meta via Base).
	integrations: [sitemap({ filter: (page) => !page.startsWith("https://rpiv-pi.com/classic") })],
});
