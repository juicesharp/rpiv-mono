# rpiv-site / src / pages

## Responsibility
File-based routing layer for the Astro 5 static site. Each `.astro`/`.ts` file under `src/pages/` becomes a route emitted at build time. Pages are pure composition shells: they wire layout + nav, fetch data via typed `src/lib/` adapters, and delegate UI to components in `src/components/`.

## Dependencies
- **`astro`**: `GetStaticPaths`, `APIContext` types; `astro:content` (`render`)
- **`@astrojs/rss`**: RSS XML builder used by `blog/rss.xml.ts`
- **`../layouts/Base.astro`**: HTML shell, SEO meta, JSON-LD article graph
- **`../../lib/posts`**: `getAllPosts`, `getPublishedPosts`, `computeReadingTime` (the only callers of `getCollection("posts")`)
- **`../../lib/docs`**: `DOCS_ROOT_ID`, `getPublishedDocs` — `docs/index.astro` and the `docs/[...slug]` catch-all
- **`../../lib/agents`, `../../lib/skills`, `../../lib/inlineMd`**: `getAgentsByTier`/`getAgent`/`getAgentSpec`/`tier`/`TIER_BY_NAME`, `getAllSkills`/`getSkill`/`getSkillSpec`, `inlineMd` — the four `docs/reference` pages
- **`../components/*`**: Nav, ScrollIndicator, AltHero, AltThesis, Install, AltFirstRun, WorkflowCatalog, InsideBuild, AltSurface, SiblingGrid, AltModels, AltRoadmap, SetupTrace; `blog/index.astro` adds SumiInk; docs pages get Search, DocsSidebar, DocsToc via `DocsLayout`

## Module Structure
```
index.astro              — Positioning-first landing at "/" (thesis → start → depth → economics)
blog/index.astro, [slug].astro, rss.xml.ts — "/blog" listing, post page, RSS feed endpoint
docs/index.astro         — "/docs" renders the docs-root article via getEntry("docs", DOCS_ROOT_ID) in DocsLayout
docs/[...slug].astro     — Catch-all renders any docs/*.md body at "/docs/<path>"
docs/reference/agents.astro, agents/[slug].astro — Agent reference index + per-agent pages
docs/reference/skills.astro, skills/[slug].astro — Skill reference index + per-skill pages
```
Output is `static` — every route prerenders. Dynamic segments are `blog/[slug]`, the two reference `[slug]` pages, and the catch-all `docs/[...slug]`; RSS is the only non-page endpoint.

## Static Composition Page (no page-level data fetching)
```astro
---
import Base from "../layouts/Base.astro";
import AltHero from "../components/AltHero.astro";
import AltThesis from "../components/AltThesis.astro";
// …
---
<Base title="rpiv-pi · keep the driver in the loop" description="…">
  <Nav />
  <ScrollIndicator />
  <main class="landing">
    <AltHero /><AltThesis /><Install /><AltFirstRun />
    <WorkflowCatalog /><InsideBuild /><AltSurface />
    <SiblingGrid /><AltModels /><AltRoadmap /><SetupTrace />
  </main>
</Base>
```
Sections own their data resolvers — `index.astro` is a flat narrative list; reordering the file reorders the site. `Install` is front-loaded so a first-time visitor can start within one scroll; the old mechanism-first `/classic` landing is retired (git history keeps it).

## Dynamic Route (`getStaticPaths` + `render`)
```astro
export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getPublishedPosts();
  return posts.map((entry) => ({
    params: { slug: entry.id },
    props: { entry, readingTime: computeReadingTime(entry.body ?? "") },
  }));
};
const { entry, readingTime } = Astro.props;
const { Content } = await render(entry);   // emits MD/MDX body HTML
```
Conditional tag rendering uses `{entry.data.tags.length > 0 && …}`. `prose.css` is imported as a module side-effect so Astro bundles + scopes it. The post body sits in a centered `.post-column` (`max-width: 64ch`) — `font-size: var(--type-reading)` must be set on the column wrapper, not only `.prose--post`, so the 64ch cap resolves against the post body size instead of the 16px root.

## RSS Endpoint
```ts
export async function GET(context: APIContext) {
  if (!context.site) throw new Error("`site` must be configured…");
  const posts = await getPublishedPosts();
  return rss({
    title: "rpiv-pi Blog",
    site: context.site,
    xmlns: { atom: "...Atom", dc: "http://purl.org/dc/elements/1.1/" },
    items: posts.map((post) => ({
      title: post.data.title, pubDate: post.data.pubDate,
      description: post.data.description, link: `/blog/${post.id}`,
      // per-item customData: <dc:creator> from post.data.author + optional <atom:updated>
      customData: `<dc:creator><![CDATA[${post.data.author}]]></dc:creator>` + /* updatedDate */ "",
    })),
    customData: `<language>en-us</language>`,
  });
}
```
Content-type and XML formatting are handled by `@astrojs/rss`; the endpoint returns its `Response` as-is.

## Architectural Boundaries
- **Layout import**: marketing/blog pages wrap with `Base` (passing `title` + `description`); `blog/[slug].astro` adds an `article` block and docs pages a `docArticle` block, both feeding JSON-LD. Docs pages wrap with `DocsLayout` (sidebar/toc) and mount the Pagefind `Search` UI
- **SEO/meta block**: centralised in `Base.astro` — pages never emit `<head>` tags directly
- **Scoped styles**: six of the nine pages colocate a `<style>` block using `tokens.css` custom properties (`--type-tiny`, `--space-7`, `--sage`, etc.); `index.astro`, `docs/index.astro`, and `docs/[...slug].astro` carry none — their styling lives in components and `DocsLayout`
- **Blog data via `lib/posts` only** — `lib/posts.ts` is the sole `getCollection("posts")` caller; the reference `[slug]` pages do call `getCollection("agentSpecs"/"skillSpecs")` in `getStaticPaths`, and `docs/index.astro` calls `getEntry` directly. All pages use `render(entry) → { Content }` for body HTML
- **No `astro:assets` `<Image>` in pages** — assets resolve via `public/` (site root); `src/` imports are reserved for processable assets handled inside components/layouts

<important if="you are adding a new page or route under src/pages/">
1. Keep the page a composition shell — fetch through a typed `src/lib/` adapter (`posts`, `docs`, `agents`, `skills`), never inline `getCollection` outside the noted reference `[slug]` exception.
2. Wrap marketing/blog pages in `Base` (`title` + `description`) and docs pages in `DocsLayout`; never emit `<head>` tags from a page.
3. Output is `static` — dynamic segments must supply `getStaticPaths`; scope any page-local styles in a `<style>` block using `tokens.css` custom properties.
</important>
