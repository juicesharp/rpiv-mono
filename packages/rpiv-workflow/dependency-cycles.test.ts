/**
 * Cycle guard — asserts ZERO value-import cycles across the package's
 * production modules. Locks in the Phase-3 SCC dissolution: the engine's
 * mutual recursions (runStage ↔ advanceChain, the loop driver) are composed
 * by injection (`ChainDeps` / `LoopDeps` in runner/stage-lifecycle.ts), never
 * as module cycles, and a regression here is a structural bug even when ESM
 * hoisting happens to make it run.
 *
 * Type-only imports (`import type … from`, `export type { … } from`, and
 * brace lists where EVERY specifier is `type`-prefixed) are excluded — they
 * are erased at runtime and cannot cause initialization-order failures. The
 * known remaining type-only back-edges (types.ts ⇄ lifecycle.ts) are
 * documented in those files.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

/** Directories that hold no production modules. */
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "docs", "thoughts", ".rpiv"]);

function productionModules(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (!EXCLUDED_DIRS.has(entry)) out.push(...productionModules(full));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

/** Strip line and block comments so commented-out imports don't count. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Extract the RELATIVE specifiers of value-level static imports/re-exports.
 * Handles: `import d from`, `import { a, type B } from`, `import * as ns
 * from`, side-effect `import "./x.js"`, `export { a } from`, `export * from`.
 * Skips: `import type`, `export type`, and brace lists whose every specifier
 * carries an inline `type` prefix.
 */
function valueImportSpecifiers(src: string): string[] {
	const code = stripComments(src);
	const specs: string[] = [];
	const statementRe =
		/\b(import|export)\s+(type\s+)?((?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)(?:\s*,\s*(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?))?)\s+from\s+["']([^"']+)["']/g;
	for (const m of code.matchAll(statementRe)) {
		const [, , typeKeyword, clause, spec] = m;
		if (typeKeyword) continue; // import type / export type
		if (!spec!.startsWith(".")) continue;
		// A brace-only clause where every specifier is `type X` is erased too.
		const braces = clause!.match(/\{([^}]*)\}/);
		if (braces && !/[\w$*]/.test(clause!.replace(braces[0], "").replace(",", "").trim())) {
			const names = braces[1]!
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (names.length > 0 && names.every((n) => /^type\s/.test(n))) continue;
		}
		specs.push(spec!);
	}
	// Side-effect imports: `import "./x.js";`
	for (const m of code.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
		if (m[1]!.startsWith(".")) specs.push(m[1]!);
	}
	return specs;
}

/** Resolve `./x.js` (TS ESM convention) → the sibling `x.ts` module path. */
function resolveSpecifier(fromFile: string, spec: string): string | undefined {
	const base = resolve(dirname(fromFile), spec).replace(/\.js$/, ".ts");
	try {
		statSync(base);
		return base;
	} catch {
		return undefined; // points outside the package or at a non-TS asset
	}
}

/** Tarjan's strongly-connected components. */
function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
	let index = 0;
	const stack: string[] = [];
	const onStack = new Set<string>();
	const indices = new Map<string, number>();
	const lowlinks = new Map<string, number>();
	const sccs: string[][] = [];

	function strongconnect(v: string): void {
		indices.set(v, index);
		lowlinks.set(v, index);
		index++;
		stack.push(v);
		onStack.add(v);
		for (const w of graph.get(v) ?? []) {
			if (!indices.has(w)) {
				strongconnect(w);
				lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
			} else if (onStack.has(w)) {
				lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
			}
		}
		if (lowlinks.get(v) === indices.get(v)) {
			const scc: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				onStack.delete(w);
				scc.push(w);
			} while (w !== v);
			sccs.push(scc);
		}
	}

	for (const v of graph.keys()) if (!indices.has(v)) strongconnect(v);
	return sccs;
}

describe("dependency cycles", () => {
	it("production modules form a DAG on value imports (zero SCCs > 1)", () => {
		const files = productionModules(PKG_ROOT);
		const graph = new Map<string, string[]>();
		for (const file of files) {
			const targets: string[] = [];
			for (const spec of valueImportSpecifiers(readFileSync(file, "utf8"))) {
				const resolved = resolveSpecifier(file, spec);
				if (resolved) targets.push(resolved);
			}
			graph.set(file, targets);
		}

		const cycles = stronglyConnectedComponents(graph)
			.filter((scc) => scc.length > 1)
			.map((scc) => scc.map((f) => relative(PKG_ROOT, f)).sort());

		expect(cycles).toEqual([]);
	});

	it("sanity: the scan actually sees the engine modules", () => {
		const files = productionModules(PKG_ROOT).map((f) => relative(PKG_ROOT, f));
		expect(files).toContain("runner/runner.ts");
		expect(files).toContain("loop-kinds.ts");
		expect(files.length).toBeGreaterThan(50);
	});
});
