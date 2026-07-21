# rpiv-site / src / lib

## Responsibility
Thin domain-helper layer that wraps Astro content-collections (`agentSpecs`, `agents`, `skillSpecs`, `skills`, `posts`, `docs`) and reads sibling package.json files across the monorepo, shaping them into typed, sorted, presentation-ready records for `.astro` pages and components. Also hosts the hand-maintained workflow mirror (`workflows.ts`) covering three (build/vet/polish) of the five built-in workflows (ship/arch/vet/polish/build) rpiv-pi registers into rpiv-workflow's built-in layer, which drives the landing.

## Dependencies
- **`astro:content`** (virtual module): `getCollection`
- **`node:fs`** + **`node:url`** for cross-package package.json reads
- **`vitest`**: only in `posts.test.ts`
- **Cross-package** (filesystem only, NOT source imports): `compat.ts` reads `../../../rpiv-pi/package.json` and `CHANGELOG.md`; `version.ts` JSON-imports `../../../rpiv-pi/package.json`; `siblings.ts` reads each sibling's `package.json`

## Module Structure
```
agents.ts / skills.ts — Merge spec + visitor-copy collections; five CapabilityTiers (verifier tier added with the three-pipeline release — 15-agent TIER_BY_NAME allowlist, verifier before external in TIER_ORDER), fallback taglines, flow groupings (PIPELINE/SECONDARY/CODE_REVIEW_FLOW), ARTIFACT_WRITE_SITES, PIPELINE_META
workflows.ts     — Hand-maintained mirror of three of the five built-in workflows (build/vet/polish; ship and arch are not mirrored): module-private WORKFLOWS exposed via getWorkflows(); WorkflowStage flags (fanout/gate/fix/human), backward-edge loops, showcase flag
counts.ts        — Build-time landing stat counts (SurfaceCounts, getSurfaceCounts) derived from skillSpecs, the TIER_BY_NAME roster via getAgentsByTier, getWorkflows, and SIBLING_NAMES — a stat and the section it links to can never disagree
posts.ts / docs.ts / reading-time.ts — Published-content filters (single source of truth for "published"), sorted; `reading-time.ts` is a pure `words / 200` estimator (floor=1) extracted so Vitest can test it without `astro:content`
siblings.ts      — Sibling catalog: reads each sibling's package.json; `shortPeers` strips `@earendil-works/`/`@juicesharp/` scopes and drops `rpiv-*` peers (external weight only); adds curated role labels
compat.ts / version.ts — Cross-package version surface: rpiv-pi `version` (JSON import; throws if missing) + CHANGELOG floor scrape via FLOOR_RE
inlineMd.ts      — Renders a tiny inline-Markdown subset (`code` + `**bold**`), HTML-escaping the rest, for reference-page frontmatter strings
```

## Why This Layer (vs Inline in Pages)
- **Shared invariants** — listing, detail page, and RSS endpoint must agree on "published" semantics; centralizing avoids drift
- **Derivations** — agent description trimming/typo fixes; sibling scope stripping — too dense for templates
- **Sort/order** — newest-first posts, tiered + alphabetized agents, canonical pipeline order for skills
- **Schema mapping** — spec + copy collections are merged into one `{slug, tagline, body, data}` shape so pages bind one object
- **Test isolation** — `astro:content` is unresolvable in Vitest, so `reading-time.ts` is extracted; the site package runs `vitest` on just this leaf
- **Compile-time safety** — `satisfies Record<KnownSkill, …>` forces tsc errors when skills are added without metadata

## Content-Collection Merge Pattern
```ts
const [specs, copies] = await Promise.all([
    getCollection("agentSpecs"),
    getCollection("agents"),
]);
const all: AgentEntry[] = specs.map((spec) => {
    const copy = copies.find((c) => c.data.slug === spec.data.name);
    return {
        slug: spec.data.name,
        tagline: copy?.data.tagline ?? fallbackTagline(spec),
        body: copy?.body,
        data: spec.data,        // upstream spec frontmatter
        copy: copy?.data,       // visitor-copy frontmatter (purpose/when_to_use/…)
    };
});
```

## Reading-Time (pure, leaf-testable)
```ts
export function computeReadingTime(body: string): number {
    const words = body.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.ceil(words / 200));   // 200 wpm, floor 1
}
```

## Cross-Package Reads (filesystem, not source import)
```ts
function readPkg(name: SiblingName): PkgJson {
    const url = new URL(`../../../${name}/package.json`, import.meta.url);
    return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}
```
**Does NOT pull from `rpiv-pi/extensions/rpiv-core/siblings`** — the catalog here is the hardcoded `SIBLING_NAMES` tuple plus each sibling's own `package.json`. This is the build-time spec-loading boundary documented in the site root architecture.

## Compat (regex scrape, build-time guard)
```ts
const FLOOR_RE = /pi-coding-agent[`\s]+\^([0-9]+\.[0-9]+\.[0-9]+)/;
// Scrapes rpiv-pi/CHANGELOG.md for the floor; pairs with rpiv-pi/package.json's version.
// Throws if the regex fails — build-time guard against silent floor drift.
```

## Workflow Mirror (spine, not full graph)
- **Keep in sync** with `packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts` — `workflows.ts` is a hand-maintained presentation mirror (three of the five built-ins; ship and arch are omitted), never a source import
- **`stageCount` must equal** the runtime `Object.keys(stages).length` (currently 23/5/6 — the mirror's hardcoded 19 for `build` is stale and needs resync); `stages` is the curated rail spine — `build` folds its 23 runtime stages into seven acts
- **Stage flags drive rendering** — `fanout` (stacked node), `gate`/`fix` (quality gate + fix loop), `human` (build's design review); optional `loop` draws the backward arc (vet "↺ until approved", polish "↺ until clean")
- **`showcase` ≠ runtime default** — the landing showcases `build` (it exercises the most machinery); the runtime default (no config) cascades to the first registered workflow, `ship`

## Type Contracts Exposed
- `AgentEntry`, `CapabilityTier`, `TIER_BY_NAME`
- `Compat`
- `PostEntry`, `PostWithReadingTime`
- `DocEntry`, `DocSection`, `SECTION_ORDER`, `SECTION_LABELS`
- `Sibling`, `SiblingName`, `SIBLING_NAMES`
- `SkillEntry`, `PipelineStep`, `PipelineMeta`, `ARTIFACT_WRITE_SITES`, `PIPELINE_META`
- `WorkflowEntry`, `WorkflowStage`, `WorkflowLoop`
- `SurfaceCounts`
- `VERSION: string`

## Architectural Boundaries
- **NO collection filtering/merging/sorting in components/pages** — components never touch `astro:content`; pages touch it only for `getStaticPaths` enumeration (`getCollection`) and `render`/`getEntry` — all derivation goes through this layer
- **Cross-package access is filesystem-only** (readFileSync of `package.json` / `CHANGELOG.md`) — never `import` from `../../../rpiv-pi/src/...`
- **`satisfies Record<KnownSkill, …>`** is the compile-time guard against orphaned skill metadata
- **`FLOOR_RE` failures throw at build** — silent floor drift between site and CHANGELOG is impossible
