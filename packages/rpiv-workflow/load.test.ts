/**
 * Tests for `loadWorkflows` — jiti-based workflow loader.
 *
 * Each test writes a canonical / drop-in fixture under a temp cwd, loads
 * it, and asserts the merged `LoadedWorkflows` shape. The user-level
 * overlays (`~/.config/rpiv/workflows.config.ts` and the `workflows/`
 * drop-in dir) are exercised via the same temp-tree pattern — cleaned
 * between tests so one test's overlay doesn't leak into the next.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { action, artifact, defineWorkflow, type Workflow } from "./api.js";
import { __resetBuiltIns, registerBuiltIns } from "./built-ins.js";
import { loadWorkflows, projectOverlayPaths, userOverlayPaths } from "./load/index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_TMP = join(process.env.HOME!, "test-workflow-load");
const USER_PATHS = userOverlayPaths();
const USER_CONFIG_DIR = dirname(USER_PATHS.canonical);
const PROJECT_PATHS = projectOverlayPaths(TEST_TMP);

// Synthetic built-ins so load tests don't depend on which sibling package
// (rpiv-pi, etc.) happens to be registering workflows. Reset per test.
const builtInWorkflows: readonly Workflow[] = [
	defineWorkflow({ name: "mid", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
	defineWorkflow({
		name: "small",
		start: "implement",
		nodes: { implement: action() },
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
	mkdirSync(dirname(paths.canonical), { recursive: true });
	writeFileSync(paths.canonical, body, "utf-8");
};

const writeProjectDropIn = (cwd: string, filename: string, body: string): void => {
	const paths = projectOverlayPaths(cwd);
	mkdirSync(paths.dropInDir, { recursive: true });
	writeFileSync(join(paths.dropInDir, filename), body, "utf-8");
};

const writeUserConfig = (body: string): void => {
	mkdirSync(dirname(USER_PATHS.canonical), { recursive: true });
	writeFileSync(USER_PATHS.canonical, body, "utf-8");
};

const writeUserDropIn = (filename: string, body: string): void => {
	mkdirSync(USER_PATHS.dropInDir, { recursive: true });
	writeFileSync(join(USER_PATHS.dropInDir, filename), body, "utf-8");
};

const importApi = `import { defineWorkflow, artifact, action, threshold } from "${join(__dirname, "api.ts")}";`;

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
	it("merges a single-workflow default-export from workflows.config.ts", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({
  name: "ship",
  start: "implement",
  nodes: { implement: action(), commit: action() },
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
      nodes: { x: artifact() },
      edges: { x: "stop" },
    }),
    defineWorkflow({
      name: "b",
      start: "y",
      nodes: { y: artifact() },
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
  nodes: { implement: action() },
  edges: { implement: "stop" },
});
`,
		);

		const loaded = await loadWorkflows(TEST_TMP);
		const mid = loaded.workflows.find((w) => w.name === "mid")!;
		expect(loaded.workflowSources.get("mid")).toBe("project");
		expect(mid.start).toBe("implement");
		expect(Object.keys(mid.nodes)).toEqual(["implement"]);
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
  nodes: { a: artifact() },
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
  nodes: { z: action() },
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
    defineWorkflow({ name: "u1", start: "a", nodes: { a: artifact() }, edges: { a: "stop" } }),
    defineWorkflow({ name: "u2", start: "b", nodes: { b: artifact() }, edges: { b: "stop" } }),
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
  workflows: [defineWorkflow({ name: "u1", start: "a", nodes: { a: artifact() }, edges: { a: "stop" } })],
  default: "u1",
};
`,
		);
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default {
  workflows: [defineWorkflow({ name: "p1", start: "b", nodes: { b: artifact() }, edges: { b: "stop" } })],
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
  nodes: { a: artifact() },
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
  nodes: { a: artifact() },
  edges: { a: "ghost" },
});
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const issue = loaded.issues.find((i) => i.kind === "validation" && i.workflow === "bad");
		expect(issue).toBeDefined();
		expect(issue?.layer).toBe("project");
		expect(issue?.path).toBe(PROJECT_PATHS.canonical);
	});

	it("refuses a bare Workflow[] with >1 entry — must wrap in envelope with explicit default", async () => {
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default [
  defineWorkflow({ name: "a", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
  defineWorkflow({ name: "b", start: "y", nodes: { y: artifact() }, edges: { y: "stop" } }),
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
  defineWorkflow({ name: "solo", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
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
  workflows: [defineWorkflow({ name: "real", start: "a", nodes: { a: artifact() }, edges: { a: "stop" } })],
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
  nodes: { a: artifact() },
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
// Drop-in directories — alpha-sorted, canonical wins, no `default` allowed
// ---------------------------------------------------------------------------

describe("loadWorkflows — drop-in directories", () => {
	it("loads project drop-in workflows without a canonical file", async () => {
		writeProjectDropIn(
			TEST_TMP,
			"a-pack.ts",
			`${importApi}
export default defineWorkflow({ name: "from-pack", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toEqual(["built-in", "project"]);
		expect(loaded.workflowSources.get("from-pack")).toBe("project");
	});

	it("loads user drop-in workflows without a canonical file", async () => {
		writeUserDropIn(
			"my-pack.ts",
			`${importApi}
export default defineWorkflow({ name: "user-pack", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.layers).toContain("user");
		expect(loaded.workflowSources.get("user-pack")).toBe("user");
	});

	it("merges drop-ins in alpha order — later files override earlier ones within the same layer", async () => {
		writeProjectDropIn(
			TEST_TMP,
			"a-first.ts",
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-a", nodes: { "from-a": artifact() }, edges: { "from-a": "stop" } });
`,
		);
		writeProjectDropIn(
			TEST_TMP,
			"z-last.ts",
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-z", nodes: { "from-z": artifact() }, edges: { "from-z": "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const x = loaded.workflows.find((w) => w.name === "x")!;
		// z-last.ts is loaded after a-first.ts (alpha order), so its workflow wins.
		expect(x.start).toBe("from-z");
	});

	it("canonical file wins over drop-ins within the same layer", async () => {
		writeProjectDropIn(
			TEST_TMP,
			"pack.ts",
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-pack", nodes: { "from-pack": artifact() }, edges: { "from-pack": "stop" } });
`,
		);
		writeProjectConfig(
			TEST_TMP,
			`${importApi}
export default defineWorkflow({ name: "x", start: "from-canonical", nodes: { "from-canonical": artifact() }, edges: { "from-canonical": "stop" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const x = loaded.workflows.find((w) => w.name === "x")!;
		expect(x.start).toBe("from-canonical");
	});

	it("accepts a Workflow[] in a drop-in", async () => {
		writeProjectDropIn(
			TEST_TMP,
			"solo-array.ts",
			`${importApi}
export default [
  defineWorkflow({ name: "solo", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
];
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.workflows.find((w) => w.name === "solo")).toBeDefined();
	});

	it("rejects the envelope form in a drop-in (default lives in canonical only)", async () => {
		writeProjectDropIn(
			TEST_TMP,
			"with-envelope.ts",
			`${importApi}
export default {
  workflows: [defineWorkflow({ name: "x", start: "a", nodes: { a: artifact() }, edges: { a: "stop" } })],
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
					/drop-in workflow files must export a `Workflow` or `Workflow\[\]`/.test(i.message),
			),
		).toBe(true);
		// File is rejected → workflow never made it in.
		expect(loaded.workflows.find((w) => w.name === "x")).toBeUndefined();
	});

	it("attributes validation issues to the exact drop-in file the workflow came from", async () => {
		writeProjectDropIn(
			TEST_TMP,
			"bad-pack.ts",
			`${importApi}
export default defineWorkflow({ name: "bad", start: "a", nodes: { a: artifact() }, edges: { a: "ghost" } });
`,
		);
		const loaded = await loadWorkflows(TEST_TMP);
		const issue = loaded.issues.find((i) => i.kind === "validation" && i.workflow === "bad");
		expect(issue?.layer).toBe("project");
		expect(issue?.path).toBe(join(PROJECT_PATHS.dropInDir, "bad-pack.ts"));
	});

	it("ignores non-.ts files in the drop-in directory", async () => {
		writeProjectDropIn(TEST_TMP, "notes.md", "# not a workflow");
		writeProjectDropIn(TEST_TMP, "config.json", "{}");
		const loaded = await loadWorkflows(TEST_TMP);
		// No errors raised, no extra workflows registered.
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
		expect(loaded.layers).toEqual(["built-in"]);
	});

	it("does not append a layer when only a non-existent drop-in dir is checked", async () => {
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
  defineWorkflow({ name: "a", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
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
    defineWorkflow({ name: "a", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
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

	it("returns the first workflow by insertion order when no overlay sets a default and `mid` is absent", async () => {
		// Wipe built-ins so the fallback path (workflowMap.keys().next().value)
		// is the only candidate; otherwise the FALLBACK_DEFAULT_WORKFLOW = "mid"
		// branch fires first.
		__resetBuiltIns();
		registerBuiltIns([
			defineWorkflow({ name: "alpha", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
			defineWorkflow({ name: "beta", start: "x", nodes: { x: artifact() }, edges: { x: "stop" } }),
		]);
		const loaded = await loadWorkflows(TEST_TMP);
		expect(loaded.default).toBe("alpha");
	});
});
