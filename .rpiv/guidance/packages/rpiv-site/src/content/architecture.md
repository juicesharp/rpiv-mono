# src/content/ (Astro content collections)

## Responsibility
Local Astro 5 content collections — `agents`, `skills`, `extensions`, `posts`, `docs` — backing the marketing site's data-driven sections. Two more collections (`agentSpecs`, `skillSpecs`) are defined in `src/content.config.ts` but live in the rpiv-pi sibling, not under `src/content/`. The local `agents`/`skills` files are **visitor copy** (tagline + structured doc fields) overlaid onto the spec-mirrored pairs; `extensions`, `posts`, `docs` are **sole-source** standalone collections.

## Dependencies
- **`astro:content`** (build-time): `defineCollection`, `z` schema validation; the `glob` loader is imported from `astro/loaders`
- **Upstream `packages/rpiv-pi/`**: `skills/<name>/SKILL.md` and `agents/<name>.md` are loaded via cross-package glob — these files are not under `src/content/`

## Consumers
- `src/lib/agents.ts` / `src/lib/skills.ts` — call `getCollection('agents')` / `getCollection('skills')` and merge with their spec siblings by `slug`
- `src/lib/posts.ts` / `src/lib/docs.ts` — call `getCollection('posts')` / `getCollection('docs')` (the only callers for those collections)
- `src/lib/siblings.ts` enumerates siblings via its own `SIBLING_NAMES` tuple + `node:fs` reads of workspace `package.json` files — the `extensions` collection has no `getCollection` caller anywhere in `src/`

## Module Structure
```
agents/      — Visitor copy (tagline + purpose/when_to_use/dispatched_by) for site subagents, joined to specs by slug
skills/      — Visitor copy (tagline + purpose/when_to_use/inputs/outputs/key_steps/related) for site skills, joined by slug
extensions/  — Standalone sibling copy; schema-validated but unconsumed (SiblingGrid renders `loadSiblings()`, not this collection)
posts/       — Blog post markdown bodies + frontmatter
docs/        — Docs markdown bodies, sectioned (getting-started/guides/explanation/reference)
```

## Schema Patterns
```typescript
// src/content.config.ts (sibling to this folder).
//
// Spec-mirror collections — full upstream frontmatter, sourced cross-package.
const skillSpecs = defineCollection({
    loader: glob({ pattern: "*/SKILL.md", base: "../rpiv-pi/skills" }),
    schema: z.object({
        name: z.string(),
        description: z.string(),
        "argument-hint": z.union([z.string(), z.array(z.string())]).optional(),
        "allowed-tools": z.union([z.string(), z.array(z.string())]).optional(),
        "disable-model-invocation": z.boolean().optional(),
    }),
});

// Visitor-copy collection — structured local overlay joined to specs by slug.
// Carries the human-facing doc shape; all fields beyond slug/tagline optional.
const skills = defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/skills" }),
    schema: z.object({
        slug: z.string(), tagline: z.string(),
        purpose: z.string().optional(),
        when_to_use: z.array(z.string()).optional(),
        inputs: z.array(z.object({ name: z.string(), required: z.boolean().default(false), /* … */ })).optional(),
        outputs: z.array(z.object({ artifact: z.string(), /* path/format */ })).optional(),
        key_steps: z.array(z.object({ title: z.string(), rationale: z.string() })).optional(),
        related: z.object({ upstream: z.array(z.string()).default([]), downstream: z.array(z.string()).default([]) }).optional(),
    }),
});
// agents copy mirrors this shape with purpose + scalar when_to_use + dispatched_by[].

// Standalone collection — no upstream mirror. Schema-validated at build but
// currently unconsumed: no getCollection("extensions") caller exists.
const extensions = defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/extensions" }),
    schema: z.object({ slug: z.string(), tagline: z.string(), package: z.string(),
        status: z.enum(["stable", "beta", "experimental"]).default("stable"), order: z.number().default(0) }),
});
```

## Visitor-Copy Frontmatter (typical entry)
```yaml
# src/content/skills/research.md — frontmatter carries the doc structure; body optional.
---
slug: research
tagline: Answers structured research questions about a codebase by formulating trace-quality questions, dispatching parallel analysis agents, and synthesizing a cited research document under `.rpiv/artifacts/research/`.
when_to_use:
  - A `discover` artifact exists and the team needs file-backed answers to its open questions.
  # …3 more bullets; purpose/inputs/outputs/key_steps elided
related: { upstream: [discover], downstream: [design, plan, blueprint, explore] }
---
```

## Architectural Boundaries
- **NO duplicated spec content** — never copy fields from `rpiv-pi/skills/*/SKILL.md` into `src/content/skills/*.md`. The site loads upstream specs at build time via the `skillSpecs` / `agentSpecs` collections.
- **`slug` is the join key** — visitor-copy `slug` MUST match the upstream `name` field; `src/lib/agents.ts` and `src/lib/skills.ts` join on it
- **Frontmatter carries the doc payload** for visitor-copy entries — structured fields (purpose/when_to_use/…) render the reference pages; the body stays optional/long-form
- **`posts` / `docs` are the site-owned standalone collections** — no upstream mirror; `extensions` is standalone too but validation-only — the SiblingGrid renders from `loadSiblings()`, never `getCollection`
- **Schema changes propagate via the build** — `astro check` (or `astro build`) fails if a `.md` file violates the schema; the `FLOOR_RE` parser in `src/lib/compat.ts` is similarly fail-loud

<important if="you are adding a new visitor-copy entry (new skill or agent in rpiv-pi)">
## Adding a Visitor-Copy Entry
1. Create `src/content/<collection>/<slug>.md` with frontmatter `{ slug, tagline }` plus any structured doc fields (purpose/when_to_use/…); body optional
2. `slug` MUST match the upstream `name` frontmatter field exactly — the join in `src/lib/` will silently drop unmatched entries
3. Skills usually need no `src/lib` edit — the reference index renders via `getAllSkills()` and the landing catalog is the hardcoded build/vet/polish `WORKFLOWS` in `src/lib/workflows.ts`; of the flow tables in `src/lib/skills.ts`, only `PIPELINE` still has a consumer (`Colophon.astro`) — `SECONDARY` / `CODE_REVIEW_FLOW` are consumer-less
4. Agents MUST be added to `TIER_BY_NAME` in `src/lib/agents.ts` — `getStaticPaths` filters `agentSpecs` against it and `getAgent` throws otherwise; tiers now include `verifier` (slice-verifier / artifact-code-reviewer / artifact-coverage-reviewer), made visible with the three-pipeline release after previously being kept invisible per FRD Non-Goals
5. No site code edit needed for the entry itself — Astro picks up new `.md` files in collection folders automatically
</important>

<important if="you are adding a new extension (sibling) card">
## Adding an Extension Entry
1. Add the slug to `SIBLING_NAMES` in `src/lib/siblings.ts` AND a `ROLES` label entry — `loadSiblings()` reads each `package.json` directly and will throw if the workspace dir is missing
2. Cards render in `SIBLING_NAMES` declaration order; `SiblingCard` shows the hand-curated `ROLES` chip plus the `package.json` version — description/homepage/peers also come from `package.json`
3. The `src/content/extensions/<slug>.md` entry (`{ slug, tagline, package, status, order }`) is schema-validated but unconsumed — `status`/`order` are never read, and entries without a `SIBLING_NAMES` slot (`rpiv-i18n`, `rpiv-warp`) never render
</important>
