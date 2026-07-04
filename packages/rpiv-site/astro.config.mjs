import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
	site: "https://rpiv-pi.com",
	output: "static",
	trailingSlash: "ignore",
	// The install walkthrough moved from /docs/getting-started to /docs itself
	// (the docs root renders the article; the old hub page is gone).
	redirects: {
		"/docs/getting-started": "/docs",
	},
	build: {
		assets: "_astro",
		inlineStylesheets: "always",
	},
	markdown: {
		shikiConfig: {
			transformers: [
				{
					// The default github-dark theme inlines background-color:#24292e
					// on every <pre>, clashing with the ink palette. Swap it for the
					// site token at highlight time — inline styles can't be beaten
					// from the stylesheet without !important.
					pre(node) {
						node.properties.style = String(node.properties.style ?? "").replace(
							"background-color:#24292e",
							"background-color:var(--ink-raised)",
						);
					},
				},
			],
		},
	},
	// /classic is the archived previous landing, kept for comparison — out of
	// the sitemap (it also carries a noindex meta via Base).
	integrations: [sitemap({ filter: (page) => !page.startsWith("https://rpiv-pi.com/classic") })],
});
