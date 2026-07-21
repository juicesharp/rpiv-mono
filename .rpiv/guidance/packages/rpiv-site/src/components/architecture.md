# src/components/ (Astro UI layer)

## Responsibility
Single-file `.astro` components composing the marketing site. Two roles:
- **Section composers** (full-width): AltHero, AltThesis, Install, AltFirstRun, WorkflowCatalog, InsideBuild, AltSurface, SiblingGrid, AltModels, AltRoadmap, SetupTrace, Colophon
- **Atoms / chrome** (typed `Props` interface, except the prop-less `Search`): SiblingCard, SiblingInfographic, Nav, ScrollIndicator, SumiInk, Search, DocsSidebar, DocsToc

There is **no shared base/layout component** beyond `Base.astro` (one level up); section composers own their data fetch and scoped CSS, atoms are presentational. The `Alt*` family plus `InsideBuild` replaced the retired `/classic` landing (commits `2ce75b26`, `0ba59465` — Hero, WhyWorkflow, RunAnatomy, StageSkills, AroundSkills, Guidance, AgentGrid, SkillCard deleted). `AgentCard.astro` survives as an **orphan** — zero importers since AgentGrid's removal; delete or re-adopt, don't emulate.

## Dependencies
- **`astro`**: the SFC pattern itself (frontmatter `---` script + markup body + scoped `<style>`)
- **`src/lib/*`**: typed API layer — `getWorkflows` (workflows.ts), `getPipelineSkills` (skills.ts), `getSurfaceCounts` (counts.ts), `loadSiblings` (siblings.ts), `loadCompat` (compat.ts), plus the `VERSION` constant (version.ts); the `getX` resolvers are async (awaited), `loadX` are synchronous — all resolve at build time. The thesis sections (AltHero, AltThesis, AltFirstRun, AltModels, AltRoadmap, InsideBuild) carry hand-maintained copy with no lib import
- **`src/styles/tokens.css`**: design-token CSS custom properties (`--ink`, `--washi`, `--sage`, `--ochre`, `--space-*`, `--type-*`, `--font-mono`, `--font-serif`, `--ease-ink`)
- **NO `astro:content` direct imports** — components must call `src/lib/` resolvers

## Consumers
- `src/pages/index.astro` mounts the home sections in narrative order: thesis (AltHero, AltThesis) → start (Install, AltFirstRun) → depth (WorkflowCatalog, InsideBuild, AltSurface, SiblingGrid) → economics + direction (AltModels, AltRoadmap) → SetupTrace
- Section composers import atoms directly (e.g. `SiblingGrid` imports `SiblingCard`, which imports `SiblingInfographic`)
- `src/layouts/Base.astro` mounts `Colophon` + footer globally below the page slot; `DocsLayout.astro` uses `Search`, `DocsSidebar`, `DocsToc`

## Module Structure
```
AltHero, AltThesis, AltModels, AltRoadmap           — Thesis/positioning sections (hand-maintained copy)
Install, AltFirstRun, SetupTrace                    — Install + first-run narrative
WorkflowCatalog, InsideBuild, AltSurface            — Pipeline depth: catalog, 19-stage anatomy plate, surface counts
SiblingGrid, Colophon                               — Data-driven grid / global footer (Base.astro)
SiblingCard, SiblingInfographic, AgentCard          — Presentational atoms (typed `Props`; AgentCard orphaned)
Nav, ScrollIndicator, SumiInk                       — Chrome / cross-section ornament
Search, DocsSidebar, DocsToc                        — Docs chrome (Pagefind UI + nav/toc)
```

## Section Composer Pattern (data-bound)
```astro
---
import { getWorkflows } from "../lib/workflows";   // or getPipelineSkills / getSurfaceCounts (async)
const workflows = await getWorkflows();            // typed [] from src/lib; loadSiblings/loadCompat are sync — no await
---
<section class="container">
  <h2 class="kicker mono">Pipelines</h2>
  {workflows.map(w => <article class="card"><h3>{w.name}</h3><p>{w.when}</p></article>)}
</section>

<style>
  /* Scoped to this component by Astro. Use tokens — never raw color/spacing. */
  section { padding: var(--space-7) 0; color: var(--ink); }
  .kicker { color: var(--sage); }
</style>
```

## Atom Pattern (typed Props)
```astro
---
// Astro infers prop types from the `interface Props` declaration.
import type { Sibling } from "../lib/siblings";
interface Props { sibling: Sibling; index: number }
const { sibling, index } = Astro.props;
---
<article class="card">
  <h3>{sibling.name}</h3>
  <p>{sibling.description}</p>
  <code class="mono">{sibling.installCmd}</code>
</article>

<style>
  .card { background: var(--washi); border: 1px solid var(--rule); }
</style>
```

## SumiInk — The Cross-Section Ornament
```astro
---
// Variant-prop SVG primitive used by AltHero, Colophon, SiblingGrid, Install,
// DocsLayout, and the blog index.
// One file, four render modes — keeps brand ornaments consistent without
// scattering inline SVG. Optional `className` merges via class:list.
interface Props { variant: "corner" | "divider" | "backdrop" | "rss"; className?: string }
---
{variant === "corner"   && <svg>...</svg>}
{variant === "divider"  && <svg>...</svg>}
{variant === "backdrop" && <svg>...</svg>}
{variant === "rss"      && <svg>...</svg>}
```

## Architectural Boundaries
- **NO `getCollection` here** — `astro:content` imports live in `src/lib/` and a few `src/pages/` routes; components depend on the typed adapter
- **NO React/Vue/Svelte islands** — pure `.astro` SFCs; no `client:` directives anywhere. Client-side JS is vanilla `<script>` blocks (DocsToc, InsideBuild, Nav, ScrollIndicator, Search, WorkflowCatalog); `Search.astro` dynamically loads the Pagefind UI on docs pages
- **NO inline color / spacing / font literals** — every visual constant comes from `tokens.css` custom properties
- **`<style>` blocks are scoped per Astro default** — cross-component primitives (`.card`, `.chip`, `.kicker`, `.mono`, `.container`) live in `global.css`
- **NO Tailwind / CSS-in-JS** — vanilla CSS with custom properties; no PostCSS plugins

<important if="you are adding a new section component or atom">
## Adding a Component
1. Create `src/components/<Name>.astro` — PascalCase filename mirrors the role
2. **Section composer**: frontmatter `await`s data from a `src/lib/` resolver. If the data shape is new, add the resolver to `src/lib/` first
3. **Atom**: declare `interface Props` and destructure `Astro.props`; never reach into siblings
4. Use `tokens.css` custom properties for every color/spacing/type value — extend tokens before hardcoding
5. If the markup is shared across sections (`.card`, `.chip`, `.kicker`), add it to `global.css`; otherwise scope via `<style>` block
6. For SVG ornaments that recur, add a variant to `SumiInk.astro` rather than creating a new SVG component
7. Mount the section in `src/pages/index.astro` (sections only — atoms are imported by their parent)
</important>
