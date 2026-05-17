import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/**/*.test.ts"],
		setupFiles: ["./test/setup.ts"],
		// setup.ts performs ~9 dynamic `await import(...)` calls inside beforeEach
		// (deliberately — see header comment in test/setup.ts). Cold-cache
		// resolution of those imports on the very first test of a worker can
		// exceed vitest's default 10s hookTimeout. Raised so the worker warm-up
		// completes inside the timer; subsequent tests reuse the module cache.
		hookTimeout: 30_000,
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["packages/*/**/*.ts"],
			thresholds: {
				statements: 95,
				branches: 89,
				functions: 93,
				lines: 96,
			},
			exclude: [
				"**/node_modules/**",
				"**/.pi/**",
				"**/.rpiv/**",
				"**/docs/**",
				"**/*.test.ts",
				"**/*.d.ts",
				"**/index.ts",
				"packages/test-utils/**",
				"packages/rpiv-site/**",
			],
		},
	},
});
