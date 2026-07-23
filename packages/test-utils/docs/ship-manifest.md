# Ship-manifest verification

How `verifyShipManifest` decides whether a package's `package.json#files` array actually covers the
production modules it imports at runtime. Twelve packages in this repo have a `ship-manifest.test.ts`
built on it.

## Usage

```ts
import { verifyShipManifest } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module across the tree", () => {
		expect(verifyShipManifest(import.meta.url).missing).toEqual([]);
	});

	it("every `files` entry points at something on disk — a stale entry ships nothing", () => {
		expect(verifyShipManifest(import.meta.url).stale).toEqual([]);
	});
});
```

The argument is either a directory path or a `file:` URL. Passing `import.meta.url` is the normal
form — the helper resolves it to the test file's parent directory, so the test never hard-codes a
path.

## Result shape

```ts
interface ShipManifestResult {
  declared: readonly string[]; // the `files` array, verbatim
  onDisk: readonly string[];   // production .ts files found on disk, relative to the package dir
  missing: readonly string[];  // on-disk files no `files` entry covers — the tarball would omit them
  stale: readonly string[];    // `files` entries with nothing at that path — ghost entries
}
```

The check runs in both directions on purpose. `missing` catches the failure that breaks consumers at
runtime: a module got added, nobody updated `files`, and the published tarball is missing an import
target. `stale` catches the quieter one: a file was renamed or deleted and `files` still points at
where it used to be.

## What the walk includes

Starting at the package directory, the walk recurses and collects files that end in `.ts`.

| Skipped | Rule |
| --- | --- |
| Dotfiles and dot-directories | any entry whose name starts with `.` |
| `node_modules/`, `docs/` | fixed `SKIP_DIRS` set |
| `test-fixtures.ts` | fixed `SKIP_FILES` set |
| `*.test.ts` | suffix match |
| Anything that is not `.ts` | suffix match |

Because test files are excluded from the walk, an npm test-file exclusion pattern in `files` has no
effect on `missing`.

The walk deliberately does **not** check asset directories (`locales/*.json` and the like), the
`exports` map, or the `main` / `module` fields. It answers one question — would npm publish include
every production `.ts` module this package imports — and nothing wider.

## How `files` entries are interpreted

The matcher mirrors npm's own `files` semantics, so a passing test means "npm would really include
this", not "this matches a house style".

| Entry form | Treated as |
| --- | --- |
| `"index.ts"` | exact file |
| `"load/"` | recursive directory prefix |
| `"load"` where `load/` exists on disk | normalized to the `load/` prefix |
| `"load"` where no such directory exists | exact file |
| `"!something"` | npm negation pattern — an exclusion rule, not a path |

Normalizing bare directory names to a trailing-slash prefix is what keeps a `"load"` entry from
spuriously covering a sibling `loader.ts`: only paths under `load/` match.

`!`-prefixed entries carve files *out* of a tarball rather than declaring inclusion, so they are
skipped by both halves of the diff — they never cover an on-disk file and they never count as stale.

## Staleness is plain existence

`stale` is computed with `existsSync` against the package directory, not against the production-`.ts`
walk. A `README.md` or `CHANGELOG.md` entry therefore counts as present even though the walk would
never surface it. Only entries pointing at nothing at all are reported.

## This package's own manifest

`@juicesharp/rpiv-test-utils` is `private: true`, and that field is load-bearing. Lockstep versioning
bumps this package with the rest of the repo, and only `private` keeps `npm publish -ws` from
shipping it.

`concurrent-host.ts` is barrel-only: it is exported from `index.ts` but absent from both `files` and
the `exports` map. It is the standing exception — a new module goes into all three.

## Adding the check to a new package

1. Create `ship-manifest.test.ts` next to `package.json` in the package.
2. Call `verifyShipManifest(import.meta.url)` and assert both `missing` and `stale` are empty.
3. When the test fails after you add a module, add the module to `files` — do not widen the skip
   lists. They are fixed sets in `manifest.ts` and changing them weakens the check for every package.
