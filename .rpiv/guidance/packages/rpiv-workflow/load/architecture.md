# load/

## Responsibility
Layered jiti loader for `defineWorkflow` overlays. Discovers built-in + user + project layers, jiti-imports each `.ts` file, normalises the default export, merges by workflow name with last-write-wins precedence, applies per-key `skillAliases` (project ⊕ user) to every workflow before validation, runs the skill-contract phase, surfaces one-shot legacy advisories, and resolves the run-default workflow. **Never throws** — every failure surfaces as an `Issue` on `LoadedWorkflows`.

## Dependencies
- **`jiti`**: ESM-aware `.ts` import without a build step; module cache OFF so `/reload` picks up edits (fs transform cache stays on — content-hash validated, edit-safe)
- **`@juicesharp/rpiv-config`**: `configPath(...)` resolves `~/.config/rpiv-workflow/` for the user layer
- **`../api`, `../built-ins`, `../layers`, `../validate-workflow`, `../skill-contract` + `../skill-contracts`, `../stage-identity`, `../validate/issue`, `../internal-utils`**: `Workflow` type, built-in registry + provider error drain, `ConfigLayer` union, validation pass, contract-registry machinery, `isDispatchingStage`/`resolveSkill`, `WorkflowValidationIssue`, `formatError`

## Consumers
- `command-run.ts` — `/wf` dispatch (`findWorkflow`, `loadWorkflows`)
- `preview.ts` — type-only `LoadedWorkflows` for the picker (renders `skillAliases` as a banner)
- Public surface via `../registration.ts` (re-exported transitively by `../index.ts`): `loadWorkflows`, `Issue`, `LoadedWorkflows`, `OverlayPaths`, `projectOverlayPaths`, `userOverlayPaths`, `aliasSkills`
- `../internal.ts` — exposes `__resetLoadCache` for tests (NOT the public barrel)

`LoadedWorkflows` carries two required derived fields: `skillAliases` (`{}` when none — merged project ⊕ user, already applied to every dispatching stage) and `skillContracts: SkillContractMap` (declared merged over harvested; empty `Map` when none).

## Module Structure
```
issues.ts            — LEAF: LoadIssue + Issue (layer/path-attributed wrapper over WorkflowValidationIssue); LoadIssueOrigin adds "framework"
paths.ts             — OverlayPaths {configFile, packsDir}; project/user path factories
legacy.ts            — Legacy-layout advisories: LEGACY_* notice strings + pushLegacyNotices probes
skill-contract-phase.ts — applySkillContractPhase: provider flush/drain + effective registry + derivers
shape-guards.ts      — Structural predicates (isWorkflow, isEnvelope) + describe (formatError is ../internal-utils.ts)
normalize.ts         — FileKind="config"|"pack" + normalizeDefaultExport → tagged NormalizeResult
cache.ts             — Lazily-created jiti (overlay module map) + mtime-keyed overlayCache; __resetLoadCache for tests
merge.ts             — LoadAccumulator + LayerOutcome + loadLayer/loadOverlayFile/mergeOverlay
resolve-default.ts   — Project default > user default > first registered; stale name → Issue
alias.ts             — isDispatchingStage + aliasSkills (pure transform) + applySkillAliases (loader-internal)
index.ts             — Orchestrator loadWorkflows(cwd) + findWorkflow + public types/barrel
```
`issues.ts` is a leaf so `merge.ts` can name `Issue` without importing the orchestrator back. `layer`/`path` attribution lives ONLY on the loader wrapper — `WorkflowValidationIssue` carries `code`/`params`/`message` and knows nothing about layers.

## Issue Accumulator (never-throws contract)
```ts
export interface LoadIssue { kind: "load"; layer: LoadIssueOrigin; path?: string; severity: "error"|"warning"; message: string; }  // LoadIssueOrigin = ConfigLayer | "framework"
export type Issue = LoadIssue | (WorkflowValidationIssue & { kind: "validation"; layer: ConfigLayer; path?: string });
try { raw = await cachedImport(path); } catch (e) { loadError(acc, layer, path, `failed to import ${path}: ${formatError(e)}`); return undefined; }
```
The runner gates on `severity === "error"` issues; callers (`command-run.ts`) decide block vs warn. Even built-in provider throws honor the contract: `flushBuiltInProviders()` RECORDS them (never propagates), and `loadWorkflows` drains each via `drainBuiltInProviderErrors()` into a `layer: "framework"` warning BEFORE reading `getBuiltIns()` — a provider that throws before registering contributes its error but (correctly) no workflows. The skill-contract phase additionally drains cross-owner contract collisions as framework warnings, and deriver mutations land on per-load shallow stage copies so the global registry and the mtime cache are never mutated in place.

## Tagged-result normaliser (no exceptions across the boundary)
```ts
export type NormalizeResult = { kind: "ok"; value: ParsedConfig } | { kind: "err"; error: string };
// FileKind discriminates capability: only "config" may carry `default` AND `skillAliases`; packs exporting
// the envelope are hard-rejected here — one source of truth per layer.
if (isEnvelope(raw) && kind === "pack") return { kind: "err", error: /* envelope is config-only */ };
```
Envelope shape today: `{ workflows?, default?, skillAliases? }`, ≥1 field present; the alias-only envelope is valid. Also hard-rejected: empty `Workflow[]`, non-Workflow array members, bare multi-entry arrays (envelope required), non-array `workflows`, non-`Record<string,string>` `skillAliases`. Keep `isEnvelope` (`shape-guards.ts`) and the shape table in `normalize.ts`'s top jsdoc in sync.

## Layer cascade (insertion order = precedence)
```ts
// built-in → user packs (alpha-sorted) → user config → project packs → project config; later wins.
for (const err of drainBuiltInProviderErrors())    // drain recorded provider throws first (see never-throws)
  acc.issues.push({ kind: "load", layer: "framework", severity: "warning", message: `built-in provider failed: ${formatError(err)}` });
for (const w of getBuiltIns()) acc.workflowMap.set(w.name, w);
const userOutcome    = await loadLayer(userOverlayPaths(),       "user",    acc);
const projectOutcome = await loadLayer(projectOverlayPaths(cwd), "project", acc);
const skillAliases = applySkillAliases(acc, userOutcome, projectOutcome);  // BEFORE the contract phase + validation
applySkillContractPhase(acc, /* … */);                                     // registry + derivers, between aliasing and validation
for (const w of acc.workflowMap.values()) for (const v of validateWorkflow(w, { skillContracts })) acc.issues.push({ ...v, kind: "validation", layer, path });
const defaultName = resolveDefault(projectOutcome.configDefault, userOutcome.configDefault, acc);
```
Layer banners in issues are conditional: `"built-in"` appears only when built-ins exist; each layer banner only when that layer contributed.

## Skill-alias application (`alias.ts`)
`applySkillAliases(acc, userOutcome, projectOutcome)` merges project ⊕ user (project wins per-key), early-exits on an empty map, snapshots pre-remap dispatched skills, rewrites workflows via the pure `aliasSkills(w, merged)` (returns `w` BY REFERENCE when unchanged, else an `Object.freeze`d copy — shared built-ins are never mutated), and walks `userAliases`/`projectAliases` SEPARATELY to attribute no-op warnings to the right source layer (same key dead in both → two warnings). One-hop only: alias targets are not re-aliased. Returns the `merged` map verbatim for `LoadedWorkflows.skillAliases`.

## Legacy advisories
`legacy.ts` owns both the notice strings and the probes (`pushLegacyNotices`, called by `index.ts`): `LEGACY_OVERLAY_NOTICE` (`.rpiv-workflow/`), `LEGACY_RUNS_NOTICE`, `LEGACY_USER_CONFIG_NOTICE` — each carrying its migration shell. The dashed directories are no longer read; these advisories are the only signal. Sunset target ~3 release cycles post-1.0 — remove each `existsSync` gate, its message constant, and the co-located test case together.

## mtime-keyed import cache (loader ↔ jiti boundary)
```ts
// created on first overlay import; failed setup resets so the next /wf retries
getJiti() = createJiti(import.meta.url, { moduleCache: false, virtualModules: await overlayVirtualModules() });
export async function cachedImport(path: string): Promise<unknown> {
  const cached = overlayCache.get(path), stat = statSync(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;  // hit
  const value = await (await getJiti()).import(path, { default: true }); // strip ESM default
  overlayCache.set(path, { mtimeMs: stat.mtimeMs, parsed: value }); return value; }
```

## Architectural Boundaries
- **Never throws to caller** — every failure path becomes an `Issue`
- **Mutable `LoadAccumulator` threaded through helpers** — new loader features add a field, not a parameter
- **Pack files cannot set `default` OR declare `skillAliases`** — both envelope-only fields are hard-rejected on packs, eliminating "who set this?" ambiguity across overlapping packs
- **Internal-only surfaces** — `applySkillAliases` is loader-internal, exported from `alias.ts` for `index.ts` only (the sibling-facing surface is `aliasSkills`, the pure transform); `__resetLoadCache` is test-only via `../internal.ts`, NOT the public barrel
- **Overlays resolve this package and `typebox` through `virtualModules`, never through disk** — overlays live outside any `node_modules` tree and outside Pi's extension module mapping, so `overlayVirtualModules()` maps `@juicesharp/rpiv-workflow` (`.`, `/registration`, `/startup`, `/runner` — NOT `/internal`) to the running package's entries and `typebox` (`/value`, `/compile`, each fail-soft) to the copy this package received from Pi, mirroring Pi's own loader (#298). Built lazily on first overlay import so the thin startup/registration graph never pulls the runner. Other bare imports still use Node resolution from the overlay's folder
- **Overlay code is trusted local code** — jiti synchronously evaluates overlay top-level code on first load and on every edit (same trust level as a node script)

<important if="you are adding a new layer source (e.g. workspace overlay)">
1. Add the literal to `ConfigLayer` in `../layers.ts`
2. Export `<name>OverlayPaths(...): OverlayPaths` in `paths.ts`
3. In `index.ts`, call `loadLayer(<name>OverlayPaths(...), "<name>", acc)` at the correct precedence slot — later call = higher precedence
4. If the layer can set a default, add it to the `candidates` list in `resolve-default.ts` above lower-precedence layers
5. If the layer can declare `skillAliases`, thread its `LayerOutcome` into `applySkillAliases(...)` so its keys (a) participate in the merged map at the new layer's precedence and (b) receive correct per-source-layer no-op attribution
6. Update `load.test.ts` precedence cases (both workflow-name and skill-alias paths)
</important>

<important if="you are adding a new default-export shape or shape guard">
1. Structural? Export `isFoo(v: unknown): v is Foo` in `shape-guards.ts` (typeof/Array.isArray only — no zod, no `instanceof`)
2. Add a branch in `normalizeDefaultExport` returning `{ kind: "ok" | "err" }` — NEVER throw
3. Per-`FileKind` policy: hard-reject envelope-style features when `kind === "pack"` (the policy that today rejects `default` AND `skillAliases` on pack files)
4. Envelope shape today is `{ workflows?, default?, skillAliases? }` with at least one field present (alias-only envelope is valid); a new envelope field appends to this list — update `isEnvelope` in `shape-guards.ts` AND the shape table in `normalize.ts`'s top jsdoc together so the runtime + doc surface don't drift
5. Cover null/undefined/wrong-typeof branches in co-located unit tests — integration paths rarely reach them
</important>
