/**
 * Tests for `loadWorkflows` — jiti-based workflow loader.
 *
 * Each test writes a `rpiv.config.ts` fixture under a temp cwd, loads it,
 * and asserts the merged `LoadedWorkflows` shape. The user-level config
 * path (`~/.config/rpiv/config.ts`) is exercised via the same temp-tree
 * pattern as `loadConfig.test.ts` used to — clean between tests so one
 * test's overlay doesn't leak into the next.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtInWorkflows } from "./built-in.js";
import { loadWorkflows, projectConfigPath, USER_CONFIG_PATH } from "./load.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_TMP = join(process.env.HOME!, "test-workflow-load");
const USER_CONFIG_DIR = dirname(USER_CONFIG_PATH);

beforeEach(() => {
	rmSync(TEST_TMP, { recursive: true, force: true });
	rmSync(USER_CONFIG_DIR, { recursive: true, force: true });
	mkdirSync(TEST_TMP, { recursive: true });
});
afterEach(() => {
	rmSync(TEST_TMP, { recursive: true, force: true });
	rmSync(USER_CONFIG_DIR, { recursive: true, force: true });
});

const writeProjectConfig = (cwd: string, body: string): void => {
	writeFileSync(projectConfigPath(cwd), body, "utf-8");
};

const writeUserConfig = (body: string): void => {
	mkdirSync(USER_CONFIG_DIR, { recursive: true });
	writeFileSync(USER_CONFIG_PATH, body, "utf-8");
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
	it("merges a single-workflow default-export from rpiv.config.ts", async () => {
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
		expect(issue?.path).toBe(projectConfigPath(TEST_TMP));
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
