/**
 * Import-graph guard for the clean-install chicken-and-egg invariant: no file
 * statically reachable from the extension entry (index.ts) may VALUE-import a
 * sibling package. A static edge to an absent peerDependency makes the whole
 * extension fail to load, suppressing the very /rpiv-setup command and
 * missing-sibling banner that tell the user to install it (issue #66).
 *
 * Files like built-in-workflows.ts and artifact-collector.ts DO value-import
 * @juicesharp/rpiv-workflow — that is safe only while they stay off the
 * entry's static graph (they are reached via guarded dynamic imports). That
 * invariant was previously enforced by comments alone; this test walks the
 * static import graph from index.ts and fails on any reachable sibling value
 * import. Type-only imports (`import type` / `export type ... from`) are
 * erased at runtime and therefore allowed.
 *
 * Sibling detection reuses SIBLINGS[].matches from siblings.ts — the same
 * single source of truth the presence checks and /rpiv-setup use.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SIBLINGS } from "./siblings.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface ImportEdge {
	readonly specifier: string;
	readonly typeOnly: boolean;
}

/**
 * Extract STATIC import/export edges from a source file. Statements are
 * matched at column 0 (Biome-formatted code), so specifiers quoted inside
 * doc comments don't count. Dynamic `import(...)` calls intentionally don't
 * match — they are the sanctioned way to reach a sibling.
 *
 * Conservative on inline type modifiers: `import { type A } from "x"` is
 * treated as a value edge (only the `import type { ... }` statement form is
 * exempt), erring toward flagging.
 */
function staticEdges(source: string): ImportEdge[] {
	const edges: ImportEdge[] = [];
	// `import`/`export` ... `from "spec"`. The binding-list character class
	// excludes `=(;` so declarations (`export const x = ...`) can't bridge
	// forward to a later statement's `from`.
	const fromRe = /^(?:import|export)\s+(type\s+)?[\w$,*{}\s]*?from\s*["']([^"']+)["']/gm;
	// Bare side-effect form: `import "spec";`
	const sideEffectRe = /^import\s*["']([^"']+)["']/gm;
	for (const m of source.matchAll(fromRe)) {
		edges.push({ specifier: m[2], typeOnly: m[1] !== undefined });
	}
	for (const m of source.matchAll(sideEffectRe)) {
		edges.push({ specifier: m[1], typeOnly: false });
	}
	return edges;
}

/** Resolve a relative `./x.js` specifier to the on-disk `.ts` source. */
function resolveLocal(fromFile: string, specifier: string): string {
	const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ""));
	for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`cannot resolve "${specifier}" imported from ${fromFile}`);
}

interface WalkResult {
	/** Files reached over static value edges, relative to rpiv-core/. */
	readonly visited: string[];
	/** `file → sibling specifier` for every static sibling value import found. */
	readonly violations: string[];
}

/** BFS over static VALUE edges from `entry`; type-only edges are erased at runtime. */
function walkStaticGraph(entry: string): WalkResult {
	const visited = new Set<string>();
	const violations: string[] = [];
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (visited.has(file)) continue;
		visited.add(file);
		for (const edge of staticEdges(readFileSync(file, "utf8"))) {
			if (edge.typeOnly) continue;
			if (edge.specifier.startsWith(".")) {
				queue.push(resolveLocal(file, edge.specifier));
			} else if (SIBLINGS.some((s) => s.matches.test(edge.specifier))) {
				violations.push(`${relative(HERE, file)} → "${edge.specifier}"`);
			}
		}
	}
	return { visited: [...visited].map((f) => relative(HERE, f)), violations };
}

describe("sibling import graph", () => {
	it("no static value import of a sibling is reachable from the extension entry", () => {
		const { visited, violations } = walkStaticGraph(resolve(HERE, "index.ts"));
		// Sanity: the walker actually traversed the registrar graph — guards
		// against an edge-extraction regression silently visiting nothing.
		expect(visited.length).toBeGreaterThan(10);
		expect(visited).toContain("session-capture.ts");
		expect(visited).toContain("skill-contracts-source.ts");
		expect(violations).toEqual([]);
	});

	it("positive control: the walker flags known sibling value imports off the entry graph", () => {
		// built-in-workflows.ts value-imports rpiv-workflow by design (reached
		// only via the lazy provider's dynamic import). Walking from it must
		// produce violations — proving the detector can actually detect.
		const { violations } = walkStaticGraph(resolve(HERE, "built-in-workflows.ts"));
		expect(violations.some((v) => v.includes("@juicesharp/rpiv-workflow"))).toBe(true);
	});
});
