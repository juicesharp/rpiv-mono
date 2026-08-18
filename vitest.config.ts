import { availableParallelism } from "node:os";
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
		// Subprocess-heavy tests (git operations, jiti resolution, config loading)
		// die just past vitest's 5s default when all workers are instrumented by
		// v8 coverage and the CPU is contended. 15s keeps real hangs fatal while
		// absorbing load-induced slowness.
		testTimeout: 15_000,
		// One fork per core saturates the CPU: every worker pays the cold import
		// of the pi-coding-agent graph under coverage instrumentation, and tests
		// that spawn subprocesses then compete with all of them. Leave headroom.
		maxWorkers: Math.max(1, Math.floor(availableParallelism() * 0.6)),
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["packages/*/**/*.ts"],
			thresholds: {
				statements: 94,
				branches: 87,
				functions: 93,
				lines: 95,
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
				"packages/rpiv-telemetry/**",
			],
		},
	},
});
