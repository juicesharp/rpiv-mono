/**
 * Tests for `loadWorkflows` — jiti-based workflow loader.
 *
 * Each test writes a config / pack fixture under a temp cwd, loads
 * it, and asserts the merged `LoadedWorkflows` shape. The user-level
 * overlays (`~/.config/rpiv-workflow/config.ts` and the `packs/`
 * dir) are exercised via the same temp-tree pattern — cleaned
 * between tests so one test's overlay doesn't leak into the next.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, defineWorkflow, produces as producesRaw, type StageDef, type Workflow } from "./api.js";
import { __resetBuiltIns, registerBuiltIns } from "./built-ins.js";
import { loadWorkflows, projectOverlayPaths, userOverlayPaths } from "./load/index.js";
import { noopCollector } from "./outcomes/index.js";

// `produces` stages require an outcome (validated at load time). Load
// tests assert merge / source-layer shape, so we wire a noop collector
// into every produces() — same shape rule the real loader enforces,
// minimal scaffolding per fixture.
const STUB_ARTIFACT_OUTCOME = { collector: noopCollector };
const produces = (overrides: Partial<StageDef> = {}): StageDef =>
	producesRaw({ outcome: STUB_ARTIFACT_OUTCOME, ...overrides });

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_TMP = join(process.env.HOME!, "test-workflow-load");
const USER_PATHS = userOverlayPaths();
const USER_CONFIG_DIR = dirname(USER_PATHS.configFile);
const PROJECT_PATHS = projectOverlayPaths(TEST_TMP);

// Synthetic built-ins so load tests don't depend on which sibling package
// (rpiv-pi, etc.) happens to be registering workflows. Reset per test.
const builtInWorkflows: readonly Workflow[] = [
	defineWorkflow({ name: "mid", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
	defineWorkflow({
		name: "small",
		start: "implement",
		stages: { implement: acts() },
		edges: { implement: "stop" },
	}),
];

beforeEach(() => {
	rmSync(TEST_TMP, { recursive: true, force: true });
	rmSync(USER_CONFIG_DIR, { recursive: true, force: true });
	mkdirSync(TEST_TMP, { recursive: true });
	__resetBuiltIns();
	registerBuiltIns(builtInWorkflows);
});
afterEach(() => {
	rmSync(TEST_TMP, { recursive: true, force: true });
	rmSync(USER_CONFIG_DIR, { recursive: true, force: true });
});

const writeProjectConfig = (cwd: string, body: string): void => {
	const paths = projectOverlayPaths(cwd);
	mkdirSync(dirname(paths.configFile), { recursive: true });
	writeFileSync(paths.configFile, body, "utf-8");
};

const writeProjectPack = (cwd: string, filename: string, body: string): void => {
	const paths = projectOverlayPaths(cwd);
	mkdirSync(paths.packsDir, { recursive: true });
	writeFileSync(join(paths.packsDir, filename), body, "utf-8");
};

const writeUserConfig = (body: string): void => {
	mkdirSync(dirname(USER_PATHS.configFile), { recursive: true });
	writeFileSync(USER_PATHS.configFile, body, "utf-8");
};

const writeUserPack = (filename: string, body: string): void => {
	mkdirSync(USER_PATHS.packsDir, { recursive: true });
	writeFileSync(join(USER_PATHS.packsDir, filename), body, "utf-8");
};

// Fixture preamble: jiti loads these as real TS — so the produces()
// calls inside the fixture strings go through the real validator.
// Each fixture imports `produces` (aliased) and re-binds it to a helper
// that wires a noop stub outcome so produces stages pass validation
// without each fixture restating the collector.
const importApi = [
	`import { defineWorkflow, produces as producesRaw, acts, gate } from "${join(__dirname, "api.ts")}";`,
	`import { noopCollector } from "${join(__dirname, "outcomes", "index.ts")}";`,
	`const produces = (o = {}) => producesRaw({ outcome: { collector: noopCollector }, ...o });`,
].join("\n");

// ---------------------------------------------------------------------------
// Baseline — no overlays
// ---------------------------------------------------------------------------

describe("loadWorkflows — baseline", () => {
	it("returns only built-in workflows when neither overlay exists", async () => {
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toEqual(["built-in"]);
		expect(loaded.workflows.map((w) => w.name).sort()).toEqual(builtInWorkflows.map((w) => w.name).sort());
		expect(loaded.default).toBe("mid");
		expect(loaded.issues).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Single overlay — project
// ---------------------------------------------------------------------------

describe("loadWorkflows — project overlay", () => {
	it("merges a single-workflow default-export from config.ts", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({
  name: "ship",
  start: "implement",
  stages: { implement: acts(), commit: acts() },
  edges: { implement: "commit", commit: "stop" },
});
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toEqual(["built-in", "project"]);
		expect(loaded.workflows.find((w) => w.name === "ship")).toBeDefined();
		expect(loaded.workflowSources.get("ship")).toBe("project");
		// Built-in is still available alongside.
		expect(loaded.workflows.find((w) => w.name === "mid")).toBeDefined();
		expect(loaded.workflowSources.get("mid")).toBe("built-in");
	});

	it("accepts a Workflow[] default-export when more than one workflow is declared", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default {
  workflows: [
    defineWorkflow({
      name: "a",
      start: "x",
      stages: { x: produces() },
      edges: { x: "stop" },
    }),
    defineWorkflow({
      name: "b",
      start: "y",
      stages: { y: produces() },
      edges: { y: "stop" },
    }),
  ],
  default: "b",
};
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.workflows.map((w) => w.name)).toEqual(expect.arrayContaining(["a", "b"]));
		expect(loaded.default).toBe("b");
	});

	it("overrides a built-in workflow by name", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({
  name: "mid",
  start: "implement",
  stages: { implement: acts() },
  edges: { implement: "stop" },
});
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		const mid = loaded.workflows.find((w) => w.name === "mid")!;
		expect(loaded.workflowSources.get("mid")).toBe("project");
		expect(mid.start).toBe("implement");
		expect(Object.keys(mid.stages)).toEqual(["implement"]);
	});
});

// ---------------------------------------------------------------------------
// Layered overlays — user + project
// ---------------------------------------------------------------------------

describe("loadWorkflows — layered merge", () => {
	it("project workflow wins on collision with user workflow", async () => {
		writeUserConfig(
			`${importApi}
export default defineWorkflow({
  name: "same",
  start: "a",
  stages: { a: produces() },
  edges: { a: "stop" },
});
`,
		);
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({
  name: "same",
  start: "z",
  stages: { z: acts() },
  edges: { z: "stop" },
});
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toEqual(["built-in", "user", "project"]);
		const same = loaded.workflows.find((w) => w.name === "same")!;
		expect(loaded.workflowSources.get("same")).toBe("project");
		expect(same.start).toBe("z");
	});

	it("user `default` is respected when project does not specify one", async () => {
		writeUserConfig(
			`${importApi}
export default {
  workflows: [
    defineWorkflow({ name: "u1", start: "a", stages: { a: produces() }, edges: { a: "stop" } }),
    defineWorkflow({ name: "u2", start: "b", stages: { b: produces() }, edges: { b: "stop" } }),
  ],
  default: "u2",
};
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.default).toBe("u2");
	});

	it("project `default` overrides user `default`", async () => {
		writeUserConfig(
			`${importApi}
export default {
  workflows: [defineWorkflow({ name: "u1", start: "a", stages: { a: produces() }, edges: { a: "stop" } })],
  default: "u1",
};
`,
		);
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default {
  workflows: [defineWorkflow({ name: "p1", start: "b", stages: { b: produces() }, edges: { b: "stop" } })],
  default: "p1",
};
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.default).toBe("p1");
	});
});

// ---------------------------------------------------------------------------
// Issues — load + validation failures
// ---------------------------------------------------------------------------

describe("loadWorkflows — issues", () => {
	it("captures a load error when the config file throws on import", async () => {
		writeProjectConfig(TEST_TMP, "throw new Error('boom');\nexport default {};\n");

		const loaded = await loadWorkflows(TEST_TMP);
		const loadErrors = loaded.issues.filter((i) => i.kind === "load" && i.severity === "error");
		expect(loadErrors.length).toBeGreaterThan(0);
		expect(loadErrors[0]?.message).toMatch(/boom/);
		// Built-in workflows still load (layered loader is fail-soft).
		expect(loaded.workflows.find((w) => w.name === "mid")).toBeDefined();
	});

	it("captures a load error when the default export is the wrong shape", async () => {
		writeProjectConfig(TEST_TMP, "export default 'not a workflow';\n");
		const loaded = await loadWorkflows(TEST_TMP);
		const loadErrors = loaded.issues.filter((i) => i.kind === "load" && i.severity === "error");
		expect(loadErrors.length).toBeGreaterThan(0);
		expect(loadErrors[0]?.message).toMatch(/Workflow|envelope/);
	});

	it("captures a validation error when a workflow has an undeclared edge target", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({
  name: "bad",
  start: "a",
  stages: { a: produces() },
  edges: { a: "ghost" },
});
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const validationErrors = loaded.issues.filter((i) => i.kind === "validation" && i.severity === "error");
		expect(validationErrors.some((e) => /"ghost"/.test(e.message))).toBe(true);
	});

	it("attaches layer + path to validation issues so callers can render provenance", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({
  name: "bad",
  start: "a",
  stages: { a: produces() },
  edges: { a: "ghost" },
});
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const issue = loaded.issues.find((i) => i.kind === "validation" && i.workflow === "bad");
		expect(issue).toBeDefined();
		expect(issue?.layer).toBe("project");
		expect(issue?.path).toBe(PROJECT_PATHS.configFile);
	});

	it("refuses a bare Workflow[] with >1 entry — must wrap in envelope with explicit default", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default [
  defineWorkflow({ name: "a", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
  defineWorkflow({ name: "b", start: "y", stages: { y: produces() }, edges: { y: "stop" } }),
];
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some((i) => i.kind === "load" && i.severity === "error" && /must be wrapped/.test(i.message)),
		).toBe(true);
		// Built-in remains usable because the project layer was rejected.
		expect(loaded.workflows.find((w) => w.name === "a")).toBeUndefined();
		expect(loaded.workflows.find((w) => w.name === "mid")).toBeDefined();
	});

	it("rejects an empty Workflow[]", async () => {
		writeProjectConfig(TEST_TMP, "export default [];\n");

		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some(
				(i) => i.kind === "load" && i.severity === "error" && /must contain at least one Workflow/.test(i.message),
			),
		).toBe(true);
	});

	it("accepts a single-entry Workflow[] without an envelope", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default [
  defineWorkflow({ name: "solo", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
];
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.workflows.find((w) => w.name === "solo")).toBeDefined();
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
	});

	it("records an error when an explicit `default` references a missing workflow", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default {
  workflows: [defineWorkflow({ name: "real", start: "a", stages: { a: produces() }, edges: { a: "stop" } })],
  default: "missing",
};
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.issues.some((i) => i.kind === "load" && /"missing"/.test(i.message))).toBe(true);
		// Falls back to the built-in mid (still present).
		expect(loaded.default).toBe("mid");
	});

	it("a malformed user config does not poison the project layer", async () => {
		writeUserConfig("throw new Error('user broke');\nexport default {};\n");
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({
  name: "good",
  start: "a",
  stages: { a: produces() },
  edges: { a: "stop" },
});
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.workflows.find((w) => w.name === "good")).toBeDefined();
		expect(loaded.layers).toContain("project");
		expect(loaded.issues.some((i) => i.kind === "load" && i.layer === "user")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Packs directories — alpha-sorted, config file wins, no `default` allowed
// ---------------------------------------------------------------------------

describe("loadWorkflows — packs directories", () => {
	it("loads project packs without a config file", async () => {
		writeProjectPack(
			TEST_TMP,
			"a-pack.ts",
			`${importApi}
export default defineWorkflow({ name: "from-pack", start: "x", stages: { x: produces() }, edges: { x: "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toEqual(["built-in", "project"]);
		expect(loaded.workflowSources.get("from-pack")).toBe("project");
	});

	it("loads user packs without a config file", async () => {
		writeUserPack(
			"my-pack.ts",
			`${importApi}
export default defineWorkflow({ name: "user-pack", start: "x", stages: { x: produces() }, edges: { x: "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toContain("user");
		expect(loaded.workflowSources.get("user-pack")).toBe("user");
	});

	it("merges packs in alpha order — later files override earlier ones within the same layer", async () => {
		writeProjectPack(
			TEST_TMP,
			"a-first.ts",
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-a", stages: { "from-a": produces() }, edges: { "from-a": "stop" } });
`,
		);
		writeProjectPack(
			TEST_TMP,
			"z-last.ts",
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-z", stages: { "from-z": produces() }, edges: { "from-z": "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const x = loaded.workflows.find((w) => w.name === "x")!;
		// z-last.ts is loaded after a-first.ts (alpha order), so its workflow wins.
		expect(x.start).toBe("from-z");
	});

	it("config file wins over packs within the same layer", async () => {
		writeProjectPack(
			TEST_TMP,
			"pack.ts",
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-pack", stages: { "from-pack": produces() }, edges: { "from-pack": "stop" } });
`,
		);
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-config", stages: { "from-config": produces() }, edges: { "from-config": "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const x = loaded.workflows.find((w) => w.name === "x")!;
		expect(x.start).toBe("from-config");
	});

	it("accepts a Workflow[] in a pack", async () => {
		writeProjectPack(
			TEST_TMP,
			"solo-array.ts",
			`${importApi}
export default [
  defineWorkflow({ name: "solo", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
];
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.workflows.find((w) => w.name === "solo")).toBeDefined();
	});

	it("rejects the envelope form in a pack (default lives in the config file only)", async () => {
		writeProjectPack(
			TEST_TMP,
			"with-envelope.ts",
			`${importApi}
export default {
  workflows: [defineWorkflow({ name: "x", start: "a", stages: { a: produces() }, edges: { a: "stop" } })],
  default: "x",
};
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some(
				(i) =>
					i.kind === "load" &&
					i.severity === "error" &&
					/pack workflow files must export a `Workflow` or `Workflow\[\]`/.test(i.message),
			),
		).toBe(true);
		// File is rejected → workflow never made it in.
		expect(loaded.workflows.find((w) => w.name === "x")).toBeUndefined();
	});

	it("attributes validation issues to the exact pack file the workflow came from", async () => {
		writeProjectPack(
			TEST_TMP,
			"bad-pack.ts",
			`${importApi}
export default defineWorkflow({ name: "bad", start: "a", stages: { a: produces() }, edges: { a: "ghost" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const issue = loaded.issues.find((i) => i.kind === "validation" && i.workflow === "bad");
		expect(issue?.layer).toBe("project");
		expect(issue?.path).toBe(join(PROJECT_PATHS.packsDir, "bad-pack.ts"));
	});

	it("ignores non-.ts files in the packs directory", async () => {
		writeProjectPack(TEST_TMP, "notes.md", "# not a workflow");
		writeProjectPack(TEST_TMP, "config.json", "{}");
		const loaded = await loadWorkflows(TEST_TMP);
		// No errors raised, no extra workflows registered.
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
		expect(loaded.layers).toEqual(["built-in"]);
	});

	it("does not append a layer when only a non-existent packs dir is checked", async () => {
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toEqual(["built-in"]);
	});
});

// ---------------------------------------------------------------------------
// Default-export shape rejection — `describe(raw)` paths
// ---------------------------------------------------------------------------

describe("loadWorkflows — default-export shape rejection", () => {
	it("describes a primitive (number) in the error message", async () => {
		writeProjectConfig(TEST_TMP, "export default 42;\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.issues.some((i) => i.kind === "load" && /got number/.test(i.message))).toBe(true);
	});

	it("describes a primitive (string) in the error message", async () => {
		writeProjectConfig(TEST_TMP, 'export default "not a workflow";\n');
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.issues.some((i) => i.kind === "load" && /got string/.test(i.message))).toBe(true);
	});

	it("describes a non-Workflow, non-Envelope object in the error message", async () => {
		writeProjectConfig(TEST_TMP, "export default { hello: 1 };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.issues.some((i) => i.kind === "load" && /got object/.test(i.message))).toBe(true);
	});

	it("rejects a `Workflow[]` containing a non-Workflow element", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default [
  defineWorkflow({ name: "a", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
  { not: "a workflow" },
];
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.issues.some((i) => i.kind === "load" && /must contain only Workflow objects/.test(i.message))).toBe(
			true,
		);
	});

	it("rejects an envelope whose `workflows` contains a non-Workflow entry", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default {
  workflows: [
    defineWorkflow({ name: "a", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
    { not: "a workflow" },
  ],
  default: "a",
};
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some(
				(i) => i.kind === "load" && /default-export `workflows` must contain only Workflow objects/.test(i.message),
			),
		).toBe(true);
	});

	it("returns the first workflow by insertion order when no overlay sets a default", async () => {
		// Insertion order is the sole fallback — no hard-coded "mid" sentinel
		// sits between the explicit defaults and the insertion-order fallback.
		__resetBuiltIns();
		registerBuiltIns([
			defineWorkflow({ name: "alpha", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
			defineWorkflow({ name: "beta", start: "x", stages: { x: produces() }, edges: { x: "stop" } }),
		]);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.default).toBe("alpha");
	});

	it("returns default=undefined when no layer registered any workflows", async () => {
		// Standalone rpiv-workflow install (no rpiv-pi, no overlays). The
		// loader used to return `default: "mid"` even though no `mid` existed
		// — command.ts now keys on `default === undefined` to surface
		// MSG_NO_WORKFLOWS_REGISTERED instead.
		__resetBuiltIns();
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.workflows).toHaveLength(0);
		expect(loaded.default).toBeUndefined();
		expect(loaded.layers).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Path layout — unified `.rpiv/workflows/` tree
// ---------------------------------------------------------------------------

describe("loadWorkflows — unified .rpiv/workflows/ layout", () => {
	it("resolves project overlay paths under .rpiv/workflows/{config.ts, packs}", () => {
		expect(PROJECT_PATHS.configFile).toBe(join(TEST_TMP, ".rpiv", "workflows", "config.ts"));
		expect(PROJECT_PATHS.packsDir).toBe(join(TEST_TMP, ".rpiv", "workflows", "packs"));
	});

	it("loads a config.ts + pack from the new .rpiv/workflows/ location", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({ name: "from-config", start: "x", stages: { x: produces() }, edges: { x: "stop" } });
`,
		);
		writeProjectPack(
			TEST_TMP,
			"a-pack.ts",
			`${importApi}
export default defineWorkflow({ name: "from-pack", start: "x", stages: { x: produces() }, edges: { x: "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.workflowSources.get("from-config")).toBe("project");
		expect(loaded.workflowSources.get("from-pack")).toBe("project");
	});
});

// ---------------------------------------------------------------------------
// Legacy overlay — mandatory one-time notice, no fallback read
// ---------------------------------------------------------------------------

describe("loadWorkflows — legacy .rpiv-workflow/ overlay", () => {
	it("warns when a legacy .rpiv-workflow/ directory exists and does NOT load it", async () => {
		// Author a workflow under the OLD dashed path. It must be ignored.
		const legacyRoot = join(TEST_TMP, ".rpiv-workflow");
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(
			join(legacyRoot, "workflows.config.ts"),
			`${importApi}
export default defineWorkflow({ name: "legacy-wf", start: "x", stages: { x: produces() }, edges: { x: "stop" } });
`,
			"utf-8",
		);

		const loaded = await loadWorkflows(TEST_TMP);

		// The legacy workflow is NOT loaded — only the new path is read.
		expect(loaded.workflows.find((w) => w.name === "legacy-wf")).toBeUndefined();

		// A mandatory advisory warning points at the new location.
		const notice = loaded.issues.find(
			(i) => i.kind === "load" && i.severity === "warning" && /\.rpiv\/workflows\/config\.ts/.test(i.message),
		);
		expect(notice).toBeDefined();
		expect(notice?.message).toMatch(/\.rpiv-workflow/);
	});

	it("emits no legacy notice when no .rpiv-workflow/ directory exists", async () => {
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.issues.some((i) => i.kind === "load" && /\.rpiv-workflow/.test(i.message))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// skillAliases — declarative load-time skill remapping
// ---------------------------------------------------------------------------

describe("loadWorkflows — skillAliases", () => {
	it("remaps a stage's dispatched skill end-to-end (envelope form)", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default {
  workflows: [
    defineWorkflow({
      name: "ship",
      start: "implement",
      stages: { implement: acts(), commit: acts() },
      edges: { implement: "commit", commit: "stop" },
    }),
  ],
  skillAliases: { commit: "attributed-commit" },
};
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		const ship = loaded.workflows.find((w) => w.name === "ship")!;
		expect(ship.stages.commit?.skill).toBe("attributed-commit");
		expect(loaded.skillAliases).toEqual({ commit: "attributed-commit" });
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
	});

	it("aliases built-in workflows too (global scope)", async () => {
		// Built-in `small` has an implicit-skill `implement` stage.
		writeProjectConfig(TEST_TMP, "export default { skillAliases: { implement: 'impl2' } };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		const small = loaded.workflows.find((w) => w.name === "small")!;
		expect(small.stages.implement?.skill).toBe("impl2");
	});

	it("never mutates the shared built-in registry — a later alias-free load is vanilla", async () => {
		writeProjectConfig(TEST_TMP, "export default { skillAliases: { implement: 'impl2' } };\n");
		const aliased = await loadWorkflows(TEST_TMP);
		expect(aliased.workflows.find((w) => w.name === "small")!.stages.implement?.skill).toBe("impl2");

		// Drop the overlay and reload: the built-in must be back to its implicit skill.
		rmSync(PROJECT_PATHS.configFile, { force: true });
		const plain = await loadWorkflows(TEST_TMP);
		expect(plain.workflows.find((w) => w.name === "small")!.stages.implement?.skill).toBeUndefined();
		expect(plain.skillAliases).toEqual({});
	});

	it("project aliases override user aliases per key", async () => {
		writeUserConfig("export default { skillAliases: { implement: 'user-impl', extra: 'user-extra' } };\n");
		writeProjectConfig(TEST_TMP, "export default { skillAliases: { implement: 'proj-impl' } };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.skillAliases).toEqual({ implement: "proj-impl", extra: "user-extra" });
		expect(loaded.workflows.find((w) => w.name === "small")!.stages.implement?.skill).toBe("proj-impl");
	});

	it("accepts an alias-only config (no `workflows` field)", async () => {
		writeProjectConfig(TEST_TMP, "export default { skillAliases: { implement: 'impl2' } };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.skillAliases).toEqual({ implement: "impl2" });
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
	});

	it("warns (no error) when an alias key matches no dispatched skill", async () => {
		writeProjectConfig(TEST_TMP, "export default { skillAliases: { 'does-not-exist': 'x' } };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some(
				(i) => i.kind === "load" && i.severity === "warning" && /matches no dispatched skill/.test(i.message),
			),
		).toBe(true);
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
	});

	it("rejects a non-string alias value with a load error", async () => {
		writeProjectConfig(TEST_TMP, "export default { skillAliases: { commit: 123 } };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some(
				(i) =>
					i.kind === "load" && i.severity === "error" && /skillAliases.*Record<string, string>/.test(i.message),
			),
		).toBe(true);
	});

	it("rejects the skillAliases envelope in a pack file", async () => {
		writeProjectPack(TEST_TMP, "aliases.ts", "export default { skillAliases: { commit: 'x' } };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some(
				(i) =>
					i.kind === "load" &&
					i.severity === "error" &&
					/pack workflow files must export a `Workflow` or `Workflow\[\]`/.test(i.message),
			),
		).toBe(true);
	});

	// Regression: `isEnvelope` accepts the shape on `skillAliases`/`default` alone,
	// so a truthy non-array `workflows` reaches normalisation. It must surface as a
	// load error — never a thrown `TypeError` from `.every()` (loader never throws).
	it("rejects a non-array `workflows` in an alias-bearing envelope without throwing", async () => {
		writeProjectConfig(TEST_TMP, "export default { workflows: 'oops', skillAliases: { commit: 'x' } };\n");
		const loaded = await loadWorkflows(TEST_TMP);
		expect(
			loaded.issues.some(
				(i) => i.kind === "load" && i.severity === "error" && /`workflows` must be a Workflow\[\]/.test(i.message),
			),
		).toBe(true);
	});
});
