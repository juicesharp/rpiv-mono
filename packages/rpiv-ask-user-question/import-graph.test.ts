import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A cycle of static value imports deadlocks esbuild's async `__esm` init; jiti masks it, so only a bundle
 * shows the hang (#208). Dynamic `import()` defers init instead of awaiting it, so those edges are out of scope.
 */

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/** `import`/`export … from "./x.js"`, statement form only; `[^;]` spans multi-line specifier lists. */
const STATIC_IMPORT = /^(?:import|export)\s+([^;]*?)\sfrom\s+["'](\.[^"']+)["']/gms;

function productionModules(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...productionModules(path));
		else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

/** `import type {…}`, `export type {…}`, and `import { type A, type B }` are erased; anything else carries a value. */
function importsValues(clause: string): boolean {
	if (/^type\s/.test(clause)) return false;
	const braced = clause.match(/\{([^}]*)\}/);
	if (!braced) return true;
	if (clause.replace(braced[0], "").replace(/,/g, "").trim()) return true;
	return braced[1]
		.split(",")
		.map((s) => s.trim())
		.some((s) => s && !/^type\s/.test(s));
}

function staticImportGraph(files: string[]): { graph: Map<string, string[]>; unresolved: string[] } {
	const graph = new Map<string, string[]>();
	const unresolved: string[] = [];
	for (const file of files) {
		const deps: string[] = [];
		for (const [, clause, specifier] of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
			if (!importsValues(clause)) continue;
			const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
			if (existsSync(target)) deps.push(target);
			else unresolved.push(`${relative(PACKAGE_ROOT, file)}: ${specifier}`);
		}
		graph.set(file, deps);
	}
	return { graph, unresolved };
}

function findCycles(graph: Map<string, string[]>): string[][] {
	const cycles: string[][] = [];
	const visiting = new Set<string>();
	const done = new Set<string>();
	const stack: string[] = [];
	const visit = (node: string): void => {
		visiting.add(node);
		stack.push(node);
		for (const dep of graph.get(node) ?? []) {
			if (visiting.has(dep)) cycles.push(stack.slice(stack.indexOf(dep)).map((p) => relative(PACKAGE_ROOT, p)));
			else if (!done.has(dep)) visit(dep);
		}
		stack.pop();
		visiting.delete(node);
		done.add(node);
	};
	for (const node of graph.keys()) if (!done.has(node)) visit(node);
	return cycles;
}

describe("static import graph", () => {
	it("has no cycles among the package's production modules", () => {
		const { graph, unresolved } = staticImportGraph(productionModules(PACKAGE_ROOT));
		expect(graph.has(join(PACKAGE_ROOT, "view/dialog-builder.ts"))).toBe(true);
		expect(unresolved).toEqual([]);
		expect(findCycles(graph).map((cycle) => cycle.join(" -> "))).toEqual([]);
	});
});
