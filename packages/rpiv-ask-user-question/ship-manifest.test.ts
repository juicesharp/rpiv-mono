import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

function walkProductionTs(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "docs") continue;
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkProductionTs(abs));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || entry.name === "test-fixtures.ts") continue;
		out.push(relative(PACKAGE_DIR, abs));
	}
	return out;
}

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module across the tree", () => {
		const pkgRaw = readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8");
		const pkg = JSON.parse(pkgRaw) as { files?: string[] };
		const declared = new Set(pkg.files ?? []);

		const onDisk = walkProductionTs(PACKAGE_DIR);

		const missing = onDisk.filter((f) => !declared.has(f));
		expect(missing).toEqual([]);
	});
});
