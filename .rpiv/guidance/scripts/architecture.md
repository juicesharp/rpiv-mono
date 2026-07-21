# scripts/ (release engineering)

## Responsibility
Lockstep release pipeline for the rpiv-mono workspace, plus a safety-proof harness. `release.mjs` orchestrates an end-to-end release (preflight → bump → CHANGELOG promote → commit + tag → publish → reinstate `[Unreleased]` → push); `sync-versions.js` enforces the lockstep invariant and rewrites intra-monorepo `dependencies`/`devDependencies` to `^<lockstep-version>`. Together they implement: a release is one atomic, reproducible monorepo-wide action. `check-slice-overlap.mjs` is a standalone proof harness that validates `packages/rpiv-pi/skills/_shared/slice-overlap.mjs` against an independent broader oracle (no release role). `check-no-decision-codes.mjs` is a second non-release guard — a standing prevention check that keeps design-doc decision-codes out of committed `.ts`.

## Dependencies
Node built-ins only — plus one cross-tree workspace import: `check-slice-overlap.mjs` imports `partition` from `packages/rpiv-pi/skills/_shared/slice-overlap.mjs`. Shells out to `git`, `npm`, `npx shx`. Reads `packages/rpiv-pi/package.json` as the canonical version oracle. Zero third-party packages.

## Consumers
- **Developers**: `npm run release:{patch|minor|major}` or `node scripts/release.mjs <x.y.z>`
- **Root npm scripts**: `version:*` chains call the sync script after `npm version -ws`
- **CI** (`.github/workflows/ci.yml`): runs `npm run check` + `npm run coverage` on push/PR (Node 22/24) — but publishing stays **local-only by design**: no workflow runs `npm publish`
- **Husky hooks**: `pre-commit` runs `npm run check:decision-codes` fail-fast, then `npm run check` — gating the clean-tree precondition the release script asserts; `pre-push` (`npm run coverage`) ensures a release-tag push has green tests

## Module Structure
```
release.mjs            — Imperative release pipeline (no exports; run() exits on failure)
sync-versions.js       — Lockstep invariant + intra-monorepo dep rewrite (idempotent)
check-slice-overlap.mjs — Safety proof for packages/rpiv-pi/skills/_shared/slice-overlap.mjs; flags under-selection only
check-no-decision-codes.mjs — Pre-commit guard: no parenthesized decision-code citations in scoped *.ts
```

## Lockstep Invariant Enforcement
`sync-versions.js` is **all-or-nothing**: if any two workspace packages have drifted to different versions, it fails the build before writing anything. `peerDependencies` are deliberately **untouched** — the zero-cross-imports contract requires they stay `"*"`.

## Diff-Aware Write (Idempotent)
The dep-rewrite step is **idempotent**: it only writes a `package.json` when at least one intra-monorepo dep would change, and writes tab-indented JSON + trailing newline to match the repo's existing `package.json` convention, so re-running on a synced repo produces zero file changes.

## Wrapped Shell-out Runner
Every shell command runs through a single wrapper that **echoes the command and fail-fasts** (`process.exit(1)`) on non-zero exit unless explicitly opted out. Top-level code never throws — failures terminate via the wrapper so partial pipeline state is rare and easy to diagnose.

## CHANGELOG Promotion + Reinstatement
- **Promote**: literal-string replace of the `[Unreleased]` heading to the dated version heading. Missing-section packages are tolerated (heterogeneous CHANGELOG presence is intentional)
- **Reinstate**: regex-anchored injection of a fresh `[Unreleased]` block above the first version heading — **not** idempotent by itself; the pipeline guarantees exactly-one invocation per release

## Decision-Code Contamination Guard
`check-no-decision-codes.mjs` walks `packages/rpiv-workflow` and `packages/rpiv-pi/extensions/rpiv-core` (`*.ts` only, `node_modules` skipped) and exits 1 on any **parenthesized, case-sensitive** decision-code citation — `(C#|T#|D#|G#|FR#|A#|M#|Slice N|Phase X|Problem N|Decision N|concern-X)`. The invariant: design-doc decision-codes live in `.rpiv/artifacts/`, never in committed `.ts`. The parens + uppercase gate and `*.ts`-only scope are deliberate — they self-filter plan fixtures in test data and legit `.md` uses, so there is **no allowlist to maintain**. Wired as `npm run check:decision-codes` (root `package.json`) and the first pre-commit step.

## Architectural Boundaries
- **NO third-party deps** — Node built-ins + shell-outs only; semver comparison is hand-rolled rather than depending on an npm package
- **`packages/rpiv-pi` is the canonical version oracle** — every other package follows; never read version from a different package
- **`peerDependencies` are intentionally untouched** by `sync-versions.js` — the zero-cross-imports contract requires they stay `"*"`
- **Fail-fast via `process.exit(1)`** — no thrown errors at top level; the wrapped runner exits on shell failure
- **Lockstep is sacred** — only one source of truth for the current version; `sync-versions.js` guarantees parity
- **Filesystem-driven discovery** — `readdirSync("packages")` is the only enumeration mechanism; new packages auto-pick-up with no script edits
- **`private: true` packages bump but don't publish** — `npm publish -ws` skips them automatically

<important if="you are cutting a new release">
## Cutting a Release
1. Ensure clean tree (`git status` shows no changes); the script exits 1 otherwise
2. Pick: `node scripts/release.mjs <patch|minor|major>` (delegates to `npm run version:*`) OR `node scripts/release.mjs <x.y.z>` (must be strictly greater than current)
3. The script bumps versions across all workspaces (lockstep), promotes every `packages/*/CHANGELOG.md` `[Unreleased]` heading, commits, tags `v<version>`, runs `npm publish -ws --access public`, reinstates `[Unreleased]`, commits, then pushes `main` + tag
4. On any mid-flight failure, the script `process.exit(1)`s — review state manually before retrying (no automatic rollback)
5. Both paths delete `node_modules` + `package-lock.json` and reinstall (the bump path via `npm run version:*`, the explicit path inline) — guarantees lockfile honesty
</important>

<important if="you are adding a new package to the monorepo">
## Adding a Package
1. Create `packages/<new-pkg>/package.json` with `version` matching every other package
2. Optionally add `CHANGELOG.md` containing `## [Unreleased]` — release script auto-detects via `existsSync` filter
3. Run `node scripts/sync-versions.js` to wire any intra-monorepo deps to `^<lockstep-version>`
4. Discovery is automatic — both scripts use `readdirSync("packages")`, no script edits needed
5. If the package is a Pi sibling extension, also: add a `siblings.ts` entry, and a `peerDependencies` entry in `rpiv-pi/package.json` pinned to `"*"`
6. If the package should never be published, add `"private": true`
</important>
