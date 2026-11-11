// check-ts-import-specifiers.mjs — standing guard against `.js` specifiers that name a `.ts` source.
//
//   node scripts/check-ts-import-specifiers.mjs
//
// Walks every package (except the Astro site) plus test/, reads every *.ts, and flags
// any relative `from "…"` / `import "…"` / `import("…")` specifier ending in `.js`
// when no such `.js` exists on disk but the `.ts` sibling does.
//
// RULE
//   Relative imports name the real `.ts` file (`./foo.ts`, not `./foo.js`).
//   `allowImportingTsExtensions` + `noEmit` in tsconfig.base.json make this legal.
//
// WHY
//   Packages publish raw `.ts` and Pi loads them through jiti with `moduleCache: false`,
//   so every specifier is resolved on every fresh process. A nonexistent `.js` target
//   sends jiti through its whole fallback candidate list (stat calls plus a constructed
//   error per miss) before it finds the `.ts` sibling. Measured across the eight rpiv
//   extensions on Pi 1.1.0: ~1.84 s → ~0.16 s of warm module import (#304, #306, #316).
//
// WHY ONLY WHEN THE `.ts` SIBLING EXISTS
//   Real `.js`/`.mjs` files stay importable as-is, and test fixtures that embed
//   `from "./x.js"` inside source strings name no real module — neither is the slow case.
//
// Exit 0 = clean; exit 1 = violation(s) printed as `path:line: specifier`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const EXCLUDED_PACKAGES = new Set(["rpiv-site"]);
const GUARDED_DIRS = [
	...readdirSync("packages", { withFileTypes: true })
		.filter((ent) => ent.isDirectory() && !EXCLUDED_PACKAGES.has(ent.name))
		.map((ent) => join("packages", ent.name)),
	"test",
];

// `from "./x.js"`, `import "./x.js"`, `import("./x.js")` — static, side-effect and dynamic forms.
const RELATIVE_JS_SPECIFIER_RE = /\b(?:from|import)\s*\(?\s*(["'])(\.{1,2}\/[^"'\n]*?)\.js\1/g;

function walkTs(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (ent.name === "node_modules" || ent.name === "dist" || ent.name.startsWith(".")) continue;
		const full = join(dir, ent.name);
		if (ent.isDirectory()) walkTs(full, out);
		else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

let scanned = 0;
const violations = [];

for (const dir of GUARDED_DIRS) {
	for (const file of walkTs(dir)) {
		scanned++;
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			for (const [, , base] of lines[i].matchAll(RELATIVE_JS_SPECIFIER_RE)) {
				const target = resolve(dirname(file), base);
				if (!existsSync(`${target}.js`) && existsSync(`${target}.ts`)) {
					violations.push(`${file}:${i + 1}: ${base}.js`);
				}
			}
		}
	}
}

if (violations.length) {
	console.error(`Found ${violations.length} relative .js specifier(s) that name a .ts source:`);
	for (const v of violations) console.error(`  ${v}`);
	console.error(
		"\nName the real file (`./foo.ts`). Pi's jiti loader pays a fallback-resolution cost for every\nnonexistent .js target on every startup (see scripts/check-ts-import-specifiers.mjs).",
	);
	process.exit(1);
}

console.log(
	`OK — no relative .js specifiers naming a .ts source (scanned ${scanned} file${scanned === 1 ? "" : "s"}).`,
);
