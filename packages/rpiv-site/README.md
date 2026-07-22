# @juicesharp/rpiv-site

The rpiv-pi website at [rpiv-pi.com](https://rpiv-pi.com) — a static Astro build with a landing page, `/blog`, and a searchable `/docs` tree. Internal to this repo: `private: true`, never published, never loaded by the Pi runtime.

## Develop

You need Node 22 (pinned in [`.nvmrc`](../../.nvmrc)) and npm 11 — the repo's `engines` floor. Run every command from the monorepo root:

| Command | What it does |
| --- | --- |
| `npm install` | Installs the whole workspace. |
| `npm run dev --workspace=@juicesharp/rpiv-site` | Dev server on Astro's default port 4321. |
| `npm run build:site` | Builds to `packages/rpiv-site/dist/`. |
| `npm run preview --workspace=@juicesharp/rpiv-site` | Serves `dist/`. |
| `npm run test --workspace=@juicesharp/rpiv-site` | Runs `vitest run` over the package's one test file, `src/lib/posts.test.ts`. |

You cannot build the site standalone. Every build reads sibling packages off disk — `../rpiv-pi/skills/*/SKILL.md`, `../rpiv-pi/agents/*.md`, `../rpiv-pi/package.json`, `../rpiv-pi/CHANGELOG.md`, and each sibling's `package.json`. A missing sibling, or a `CHANGELOG.md` with no `pi-coding-agent ^X.Y.Z` line, fails your build with an explicit error.

You will not get a docs search index locally. Pagefind is not part of `astro build` — only CI runs `npx pagefind --site packages/rpiv-site/dist` after the build.

You also will not get a type-check from `npm run check` at the root: this package is excluded from `tsconfig.base.json` (and from Vitest coverage, and Biome skips its `.astro` files). Astro owns its own type pipeline.

## Used by

Nothing. No package in the repo depends on `rpiv-site`; the dependency arrow points outward only. Beyond the root `build:site` script, the only consumers are two workflows:

| Workflow | Role |
| --- | --- |
| [`deploy-site.yml`](../../.github/workflows/deploy-site.yml) | Builds, indexes with Pagefind, and deploys to GitHub Pages on `push` to `main` under `packages/rpiv-site/**` or the workflow file itself, plus `workflow_dispatch`. Node 22, `ubuntu-latest`. |
| [`ci.yml`](../../.github/workflows/ci.yml) | `paths-ignore: packages/rpiv-site/**` — a site-only push runs **no** CI. |

## Conventions

- **Content comes from disk, not from a manifest.** Skill and agent pages load `packages/rpiv-pi/` Markdown through Astro glob loaders; the version and compatibility line come from `rpiv-pi`'s `package.json` and `CHANGELOG.md`. Nothing is copied into this package, so nothing goes stale.
- **Sibling cards are hand-curated.** Adding one touches [`src/lib/siblings.ts`](src/lib/siblings.ts) and [`src/components/SiblingInfographic.astro`](src/components/SiblingInfographic.astro) in lockstep; a partial edit is a type error, but you will only see it in your editor — no build or CI step type-checks this package.
- **The site's sibling list is its own.** `SIBLING_NAMES` is maintained independently of `rpiv-pi`'s `rpiv-core/siblings.ts` and is a deliberately smaller list.
- **Zero client framework.** No React/Vue/Svelte islands and no `client:` directives; interactivity is vanilla `<script>`. Fonts are self-hosted via Fontsource and stylesheets are inlined, so the critical path makes no third-party request.
- **Design tokens are documented, not improvised.** [`DESIGN.md`](DESIGN.md) codifies the palette, type, motion, and spacing system encoded in `src/styles/tokens.css`. Read it before you add a color or a duration.
- **Per-package sync checklists** for adding a skill, agent, sibling, or landing-page section live in [`.rpiv/guidance/packages/rpiv-site/architecture.md`](../../.rpiv/guidance/packages/rpiv-site/architecture.md).
