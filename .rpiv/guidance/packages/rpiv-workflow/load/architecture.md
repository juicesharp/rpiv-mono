# load/

## Responsibility
Layered jiti loader for `defineWorkflow` overlays. Discovers built-in + user + project layers, jiti-imports each `.ts` file, normalises the default export, merges by workflow name with last-write-wins precedence, applies per-key `skillAliases` (project ⊕ user) to every workflow before validation, builds the effective skill-contract registry, surfaces one-shot legacy advisories, and resolves the run-default workflow. **Never throws** — every failure surfaces as an `Issue` on `LoadedWorkflows`.

## Dependencies
- **`jiti`**: ESM-aware `.ts` import without a build step; module cache OFF so `/reload` picks up edits (fs transform cache stays on — content-hash validated, edit-safe)
- **`@juicesharp/rpiv-config`**: `configPath(...)` resolves `~/.config/rpiv-workflow/` for the user layer
- **`../api`, `../built-ins`, `../layers`, `../validate-workflow`, `../skill-contract` + `../skill-contracts`, `../stage-identity`, `../validate/issue`, `../internal-utils`**: `Workflow` type, built-in registry + provider error drain, `ConfigLayer` union, validation pass, `SkillContractMap` + contract-registry machinery, `isDispatchingStage`/`resolveSkill`, `WorkflowValidationIssue`, `formatError`

## Consumers
- `command-run.ts` — `/wf` dispatch (`findWorkflow`, `loadWorkflows`)
- `preview.ts` — type-only `LoadedWorkflows` for the picker (renders `skillAliases` as a banner)
- Public barrel `../index.ts` — re-exports `loadWorkflows`, `Issue`, `LoadedWorkflows`, `OverlayPaths`, `projectOverlayPaths`, `userOverlayPaths`, `aliasSkills`
- `../internal.ts` — exposes `__resetLoadCache` for tests

`LoadedWorkflows` carries two required derived fields: `skillAliases` (`{}` when none — merged project ⊕ user, already applied to every dispatching stage) and `skillContracts: SkillContractMap` (declared merged over harvested; empty `Map` when none). Siblings wanting the same remap on a built-in before `runWorkflow` call the public `aliasSkills(w, aliases)` directly.

## Module Structure
```
issues.ts           — LEAF: LoadIssue + Issue (layer/path-attributed wrapper over WorkflowValidationIssue); LoadIssueOrigin adds "framework" for loader-machinery failures
paths.ts            — OverlayPaths {configFile, packsDir}; project/user path factories
legacy.ts           — Legacy-layout advisories: LEGACY_* notice strings + pushLegacyNotices probes
skill-contract-phase.ts — applySkillContractPhase: provider flush/drain + effective registry + derivers
shape-guards.ts     — Structural predicates (isWorkflow, isEnvelope) + describe (formatError is ../internal-utils.ts)
normalize.ts        — FileKind="config"|"pack" + normalizeDefaultExport → tagged NormalizeResult
cache.ts            — Module-singleton jiti + mtime-keyed overlayCache; __resetLoadCache for tests
merge.ts            — LoadAccumulator + LayerOutcome + loadLayer/loadOverlayFile/mergeOverlay
resolve-default.ts  — Project default > user default > first registered; stale name → Issue
alias.ts            — isDispatchingStage + aliasSkills (pure transform) + applySkillAliases (loader-internal)
index.ts            — Orchestrator loadWorkflows(cwd) + findWorkflow + public types/barrel
```
`issues.ts` is a leaf so `merge.ts` can name `Issue` without importing the orchestrator back (the pipeline's one former back-edge). `layer`/`path` attribution lives ONLY on the loader wrapper — `WorkflowValidationIssue` itself carries `code`/`params`/`message` and knows nothing about layers.

## Issue Accumulator (never-throws contract)
```ts
// Every recoverable failure becomes a tagged Issue; loader itself never throws.
export interface LoadIssue { kind: "load"; layer: LoadIssueOrigin; path?: string; severity: "error"|"warning"; message: string; }  // LoadIssueOrigin = ConfigLayer | "framework"
export type Issue = LoadIssue | (WorkflowValidationIssue & { kind: "validation"; layer: ConfigLayer; path?: string });
try { raw = await cachedImport(path); } catch (e) { loadError(acc, layer, path, `failed to import ${path}: ${formatError(e)}`); return undefined; }
```
The runner gates on `severity === "error"` issues; callers (`command-run.ts`) decide block vs warn. Even built-in provider throws honor the contract: `flushBuiltInProviders()` RECORDS them (never propagates), and `loadWorkflows` drains each via `drainBuiltInProviderErrors()` into a `layer: "framework"` warning BEFORE reading `getBuiltIns()` — a provider that throws before registering contributes its error but (correctly) no workflows.

## Tagged-result normaliser (no exceptions across the boundary)
```ts
export type NormalizeResult = { kind: "ok"; value: ParsedConfig } | { kind: "err"; error: string };
// FileKind discriminates capability: only "config" may carry `default` AND `skillAliases`; packs exporting an envelope are hard-rejected here — one source of truth per layer.
if (isEnvelope(raw) && kind === "pack") return { kind: "err", error: "packs export Workflow|Workflow[] only" };
```
Envelope shape today: `{ workflows?, default?, skillAliases? }`, ≥1 field present; the alias-only envelope is valid. Keep `isEnvelope` (`shape-guards.ts`) and the shape table in `normalize.ts`'s top jsdoc in sync.

## Layer cascade (insertion order = precedence)
```ts
// built-in → user packs (alpha-sorted) → user config → project packs → project config; later wins.
for (const err of drainBuiltInProviderErrors())    // drain recorded provider throws first (see never-throws)
  acc.issues.push({ kind: "load", layer: "framework", severity: "warning", message: `built-in provider failed: ${formatError(err)}` });
for (const w of getBuiltIns()) acc.workflowMap.set(w.name, w);
const userOutcome    = await loadLayer(userOverlayPaths(),       "user",    acc);
const projectOutcome = await loadLayer(projectOverlayPaths(cwd), "project", acc);
const skillAliases = applySkillAliases(acc, userOutcome, projectOutcome);  // BEFORE validation so every observed stage reflects the final skill name
for (const w of acc.workflowMap.values()) for (const v of validateWorkflow(w, { skillContracts })) acc.issues.push({ ...v, kind: "validation" });  // validate once; errors block, warnings advise
const defaultName = resolveDefault(projectOutcome.configDefault, userOutcome.configDefault, acc);
```

## Skill-alias application (`alias.ts`)
`applySkillAliases(acc, userOutcome, projectOutcome)` merges project ⊕ user (project wins per-key), early-exits on an empty map, snapshots pre-remap dispatched skills, rewrites every workflow in place via the pure `aliasSkills(w, merged)`, and walks `userAliases`/`projectAliases` SEPARATELY to attribute no-op warnings to the right source layer (same key dead in both → two warnings). One-hop only: alias targets are not re-aliased. Returns the `merged` map verbatim for `LoadedWorkflows.skillAliases`. See `alias.ts` for the per-layer no-op attribution.
## Legacy advisories
`legacy.ts` owns both the notice strings and the probes (`pushLegacyNotices`, called by `index.ts`): `LEGACY_OVERLAY_NOTICE` (`.rpiv-workflow/`), `LEGACY_RUNS_NOTICE`, `LEGACY_USER_CONFIG_NOTICE` — each carrying its migration shell. The dashed directories are no longer read; these advisories are the only signal. Sunset target ~3 release cycles post-1.0 — remove each `existsSync` gate, its message constant, and the co-located test case together.
## mtime-keyed import cache (loader ↔ jiti boundary)
```ts
const jiti = createJiti(import.meta.url, { moduleCache: false });  // cache.ts module-singleton: module cache off, fs transform cache kept; mtime-keyed overlayCache re-imports on edit
export async function cachedImport(path: string): Promise<unknown> {
  const cached = overlayCache.get(path), stat = statSync(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;  // hit
  const value = await jiti.import(path, { default: true });             // strip ESM default
  overlayCache.set(path, { mtimeMs: stat.mtimeMs, parsed: value }); return value; }
```
## Architectural Boundaries
- **Never throws to caller** — every failure path becomes an `Issue`
- **Mutable `LoadAccumulator` threaded through helpers** — new loader features add a field, not a parameter
- **Pack files cannot set `default` OR declare `skillAliases`** — both envelope-only fields are hard-rejected on packs, eliminating "who set this?" ambiguity across overlapping packs
- **Internal-only surfaces** — `applySkillAliases` is loader-internal, exported from `alias.ts` for `index.ts` only (the sibling-facing surface is `aliasSkills`, the pure transform); `__resetLoadCache` is test-only, exported via `../internal.ts`, NOT the public barrel

<important if="you are adding a new layer source (e.g. workspace overlay)">
## Adding a Layer Source
1. Add the literal to `ConfigLayer` in `../layers.ts`
2. Export `<name>OverlayPaths(...): OverlayPaths` in `paths.ts`
3. In `index.ts`, call `loadLayer(<name>OverlayPaths(...), "<name>", acc)` at the correct precedence slot — later call = higher precedence
4. If the layer can set a default, add it to the `candidates` list in `resolve-default.ts` above lower-precedence layers
5. If the layer can declare `skillAliases`, thread its `LayerOutcome` into `applySkillAliases(...)` so its keys (a) participate in the merged map at the new layer's precedence and (b) receive correct per-source-layer no-op attribution
6. Update `load.test.ts` precedence cases (both workflow-name and skill-alias paths)
</important>
<important if="you are adding a new default-export shape or shape guard">
## Adding a Shape
1. Structural? Export `isFoo(v: unknown): v is Foo` in `shape-guards.ts` (typeof/Array.isArray only — no zod, no `instanceof`)
2. Add a branch in `normalizeDefaultExport` returning `{ kind: "ok" | "err" }` — NEVER throw
3. Per-`FileKind` policy: hard-reject envelope-style features when `kind === "pack"` (the policy that today rejects `default` AND `skillAliases` on pack files)
4. Envelope shape today is `{ workflows?, default?, skillAliases? }` with at least one field present (alias-only envelope is valid); a new envelope field appends to this list — update `isEnvelope` in `shape-guards.ts` AND the shape table in `normalize.ts`'s top jsdoc together so the runtime + doc surface don't drift
5. Cover null/undefined/wrong-typeof branches in co-located unit tests — integration paths rarely reach them
</important>
