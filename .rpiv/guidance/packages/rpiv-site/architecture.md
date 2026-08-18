# rpiv-site

## Monorepo Context
Astro 5 static marketing site for the rpiv-pi family. Workspace package (`@juicesharp/rpiv-site`, `private: true`) — joins lockstep + shared CI infrastructure but **NOT a Pi extension**: no `pi` field, never published, never loaded by the Pi runtime. **Excluded from the root TypeScript project** (`tsconfig.base.json:exclude` lists `packages/rpiv-site/**`); it has its own `tsconfig.json` extending `astro/tsconfigs/strict`. Biome lints/formats `.ts` here via the root `packages/*/**/*.ts` include (plus site-only `.css`/`.html` patterns) — only `.astro`/`.mjs` and type-checking fall to Astro's own pipeline. Build invoked at the monorepo root via `npm run build:site`.

## Responsibility
Hand-built marketing tour at `https://rpiv-pi.com` (deployed to GitHub Pages — `public/CNAME`) plus a `/blog` and a `/docs` route tree. The home page is positioning-first ("correct ≠ aligned, keep the driver in the loop") and composes AltHero → AltThesis → Install → AltFirstRun → WorkflowCatalog → InsideBuild → AltSurface → SiblingGrid → AltModels → AltRoadmap → SetupTrace (`Colophon` mounts globally in `Base.astro`); the earlier mechanism-first landing (`/classic`) is retired — git history keeps it. The flow surfaces the rpiv-pi pipelines, skills, agents, and sibling extensions. Spec content (skills, agents) is **read directly from the rpiv-pi sibling at build time** via cross-package globs — never duplicated.

## Dependencies
- **`astro` ^5.0.0** (devDep): the entire framework — `.astro` SFCs, content collections, static output
- **`@astrojs/sitemap` ^3.2.0** / **`@astrojs/rss` ^4.0.0** (devDep): `/sitemap-index.xml`; `/blog/rss.xml` feed builder
- **`pagefind` ^1.5.2** (devDep): static search index + UI, mounted on docs pages via `Search.astro`
- **`@fontsource/jetbrains-mono` ^5.2.8** (runtime dep): bundled font, imported in `src/layouts/Base.astro` (no CDN)
- **`sharp`** (ambient — used only by `scripts/generate-og.mjs`, not in `package.json`): operator-only OG/apple-touch-icon rasteriser

## Consumers
- **GitHub Pages**: serves the contents of `dist/` (output of `astro build`); `public/CNAME` pins the domain
- **No runtime callers** — fully static, no API or backend

## Module Structure
```
Build config         — astro.config.mjs + tsconfig.json; site has its own type universe
public/              — Static assets copied verbatim (CNAME, favicon.svg, apple-touch-icon, og-* images (png/jpg), robots.txt)
scripts/generate-og.mjs — Operator-only build helper (sharp); NOT invoked by `astro build`
src/pages/           — File-based routes (home + blog + docs trees) → see src/pages/architecture.md
src/layouts/         — Base.astro (HTML shell, SEO, JSON-LD, bundled font) + DocsLayout.astro
src/components/      — UI layer → see src/components/architecture.md
src/content/ + content.config.ts — Content collections → see src/content/architecture.md
src/lib/ + src/styles/ — Typed adapters/spec readers → see src/lib/architecture.md; global.css + tokens.css + prose.css (sumi/washi palette)
```

## Cross-Package Spec Loading (build-time only)
```typescript
// src/content.config.ts — seven collections. Two reach OUT of the package via
// Astro's glob loader so the site reads upstream rpiv-pi sources directly (no dup).
const skillSpecs  = defineCollection({ loader: glob({ pattern: "*/SKILL.md", base: "../rpiv-pi/skills" }), schema: ... });
const agentSpecs  = defineCollection({ loader: glob({ pattern: "*.md",       base: "../rpiv-pi/agents" }), schema: ... });
// Visitor copy lives locally, joined by slug == upstream `name`. Schemas now carry
// structured doc fields (purpose/when_to_use/inputs/outputs/key_steps/related).
const skills      = defineCollection({ loader: glob({ pattern: "*.md", base: "./src/content/skills" }), schema: ... });
const agents      = defineCollection({ loader: glob({ pattern: "*.md", base: "./src/content/agents" }), schema: ... });
// Local-only collections (no upstream mirror): extensions, posts, docs.
```

## Spec-Data Files (`src/lib/`)
```typescript
// siblings.ts — reads each sibling's package.json directly via readFileSync from
//   "../../../<name>/package.json"; SIBLING_NAMES is the hand-curated tuple.
// compat.ts — reads packages/rpiv-pi/package.json (rpiv-pi version) and the monorepo
//   root package.json devDependencies pin of @earendil-works/pi-coding-agent (the tested
//   compatibility anchor — every package peer-depends on "*", so there is no published
//   floor); throws if the devDependency key is missing (build-time guard).
// agents.ts / skills.ts — Astro content-collection adapters (use `astro:content`).
//   Embed hand-curated tables: TIER_BY_NAME (capability tier per agent — 15 named
//   agents across locator/analyzer/external/specialist/verifier),
//   PIPELINE/SECONDARY/CODE_REVIEW_FLOW tuples + ARTIFACT_WRITE_SITES / PIPELINE_META.
// workflows.ts — hand-maintained presentation mirror of all four built-in
//   pipelines (build/vet/polish/ship; nothing is omitted); build's 31 runtime
//   stages fold into a curated seven-act spine (capture → slice → design → review →
//   plan → code → land). Components consume these typed APIs — never `getCollection()` directly.
```

## Architectural Boundaries
- **NO runtime — output is `static`** (`astro.config.mjs:6`); every data lookup runs in frontmatter at build time
- **NO duplicated specs** — agents and skills are loaded from `packages/rpiv-pi/` via cross-package glob; local content is the visitor-copy overlay (tagline + structured doc fields) plus the `extensions`, `posts`, `docs` collections
- **NO `getCollection` in components** — components import from the typed `src/lib/` adapters; `astro:content` is touched only by `src/lib/` and page frontmatter (e.g. `docs/reference/agents/[slug].astro` calls `getCollection`/`render` directly)
- **NO root-tsconfig coverage; `.astro` escapes Biome** — Astro's own pipeline owns type-check and `.astro` files; Biome lints `.ts`/`.css`/`.html` via the root config
- **`scripts/generate-og.mjs` is operator-only** — depends on an ambient `sharp`, reads a local `~/Downloads/...jpg`; never run by `astro build`
- **Hand-curated spec tables in `src/lib/`** — when an upstream agent/skill is added or its tier changes, update `TIER_BY_NAME` / `PIPELINE` etc. in the same change

<important if="you are adding a new section component to the marketing site">
## Adding a Section
1. Create `src/components/<Section>.astro` — frontmatter `await`s its data from a typed `src/lib/` resolver, body emits scoped markup with `<style>`
2. Use only `tokens.css` custom properties for color/spacing/type — see `src/components/architecture.md`
3. Mount the section inside `src/pages/index.astro` between existing sections; ordering is the navigation order
4. If the section needs new spec data (e.g. a different agent slice), extend the resolver in `src/lib/` rather than calling `getCollection` from the component
</important>

<important if="you are adding or removing an upstream skill, agent, or sibling extension">
## Sync Checklist for Spec Changes
1. **New skill**: add the visitor-copy `src/content/skills/<slug>.md` (tagline + structured `purpose`/`when_to_use`/`inputs`/`outputs`/`key_steps`/`related`); the upstream `SKILL.md` is auto-loaded by `skillSpecs`. If the skill belongs to a section flow, append it to `PIPELINE` / `SECONDARY` / `CODE_REVIEW_FLOW` in `src/lib/skills.ts`. If it writes an artifact, add an `ARTIFACT_WRITE_SITES` row. If the pipeline shape itself changes (stages added/removed in rpiv-pi's `built-in-workflows.ts`), re-sync the spine + `stageCount` in `src/lib/workflows.ts`.
2. **New agent**: add `src/content/agents/<slug>.md` (tagline + `purpose`/`when_to_use`/`dispatched_by`) and a `TIER_BY_NAME` row in `src/lib/agents.ts`; `agentSpecs` picks the upstream `.md` up automatically.
3. **New sibling extension**: create `src/content/extensions/<slug>.md` with `package`/`status`/`order` frontmatter. Only add a `SIBLING_NAMES` + `ROLES` entry in `src/lib/siblings.ts` if the sibling should appear in the curated SiblingGrid — `SIBLING_NAMES` is a hand-picked subset, NOT 1:1 with `extensions/`.
4. **Sibling renamed/removed**: update `SIBLING_NAMES`/`ROLES` if it was listed, AND delete the matching `extensions/<slug>.md`. The build fails loudly if a name in the tuple has no `package.json`.
5. The compat floor shown in the Install section is the root `package.json` devDependencies pin of `@earendil-works/pi-coding-agent` — dependency bumps update it automatically, no manual sync; `src/lib/compat.ts` reads it at build time and throws if the pin is missing or empty.
</important>
