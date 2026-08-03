# rpiv-site — Design System

Sumi ink canvas, washi paper accents, sage/moss/ochre minerals. Two voices: Berkeley Mono for structure, Iowan Old Style for prose. "Ma" rhythm on an 8px grid. Motion is ink-organic, never spring. This document codifies the system already encoded in `src/styles/tokens.css` so the next contributor doesn't have to re-derive it from CSS variables.

## Aesthetic intent (the seven dimensions)

| Dimension | Direction |
|---|---|
| **Tone** | Sumi-e editorial + technical craft. Magazine spread, not SaaS dashboard. |
| **Color** | Dark warm — sumi `#1c1a17` ground, washi `#ede6d3` text, sage/ochre/moss accents. No SaaS blue, no purple gradients. |
| **Typography** | Mono for structure (Berkeley Mono → JetBrains Mono → SF Mono). Serif for prose (Iowan Old Style → Charter → Source Serif). Never Inter, never Roboto, never system-ui as display. |
| **Motion** | Ink-organic `cubic-bezier(0.23, 0.71, 0.27, 0.98)` over five duration tiers (`--dur-fast` 120ms → `--dur-enter` 1200ms). |
| **Spatial** | 8px "ma" rhythm (`--space-1`..`--space-11`). Generous whitespace, asymmetric where it earns it. |
| **Backgrounds** | Solid sumi ground + SumiInk SVG ornament (`corner` / `divider` / `backdrop` variants). No gradient mesh, no noise. |
| **Differentiation** | The sumi/washi material metaphor + the strict mono/serif voice split. |

## Token discipline

Every *systemic* visual constant — color, type scale, the 8px spacing rhythm, and motion easing/duration tiers — lives in `src/styles/tokens.css`. Three bans are absolute: no hex codes, no font-family strings, and no raw `cubic-bezier(...)` anywhere else in the codebase; always reference the token. Raw `px`/`ms` literals are not banned outright — hairline borders (`1px solid var(--rule)`), layout metrics (grid tracks, container max-widths, media-query breakpoints), fixed glyph/icon dimensions, and per-component animation stagger delays stay local to the file that owns them. See **Layout** for the 240px docs sidebar and the 1280px cap.

```css
/* WRONG — hex literal in a component */
.card { background: #252220; }

/* RIGHT — token reference */
.card { background: var(--ink-raised); }
```

If a value doesn't exist as a token, **extend `tokens.css` first**, then reference it. The token names carry meaning (`--ink-raised`, `--washi-soft`, `--rule-strong`) that hex values cannot — preserve them.

### Color tokens — when to reach for which

| Surface need | Token |
|---|---|
| Page ground | `--ink` |
| Card / raised surface | `--ink-raised` |
| Muted inset | `--ink-muted` |
| Primary text | `--text` (= `--washi`) |
| Secondary / metadata | `--text-quiet` |
| Tertiary / labels | `--text-distant` |
| Hairline | `--rule` |
| Card edge / emphasis divider | `--rule-strong` |
| Calm accent (links, active state, focus) | `--sage` / `--sage-deep` |
| Warm accent (active border on docs nav, highlight wash) | `--ochre` |
| Deep moss (rare, for severity-low chrome) | `--moss` |
| Chip background | `--kuro` |
| Stop-and-look only (failed verification, severity:critical) | `--alert` — **never as a UI accent** |

### Type tokens

Headings always use `--font-mono`. Body always uses `--font-serif`. Kickers (`.kicker`) are mono uppercase at `--type-tiny` with `letter-spacing: 0.18em`. Don't mix voices within a single element — switch at the element boundary.

| Token | Use |
|---|---|
| `--type-h1` | Hero — landing only (clamp 48–96px) |
| `--type-h2` | Page-level `<h1>` on listings + `.prose--docs h1` + `.blog-hero__title` (clamp 28–40px) |
| `--type-h-hero` | Section composer `<h2>` on the landing (30px fixed) |
| `--type-h-section` | In-section `<h3>` on landing composers (clamp 22–26px) |
| `--type-h3` | Listing-row titles, tier headers, atom card titles (20px) |
| `--type-h-docs-h2` | `.prose--docs h2` in the reference body (24px). Docs h3/h4 have no token — they track the fluid reading body (`--type-reading`, 17–19px) via `em` in `prose.css` (1.1em / 1em). |
| `--type-lead` | Lede paragraphs (hero, docs hero, `.docs-lede`) — clamp 18–20px |
| `--type-base` / `--type-small` / `--type-tiny` / `--type-micro` / `--type-kicker` | Body → chrome → fine-print stack |

### Kicker variants

Kickers default to `--text-distant` — a quiet section label. Two modifiers extend the role:

| Class | Color | Use |
|---|---|---|
| `.kicker` | `--text-distant` | Default — most section labels, chrome, metadata strips |
| `.kicker .kicker--accent` | `--sage` | A label of interest — TOC headers, grid section labels, anywhere the kicker is the wayfinding cue |
| `.kicker .kicker--action` | `--ochre` | An actionable label — quick-start, install, the one thing the visitor should hit first |

Use sparingly: one `--action` per surface, `--accent` for grouping, default for everything else. Landing composers pair the default `.kicker` with a local BEM modifier (`.ahero__kicker`, `.cat__kicker`, `.ib__kicker`) that carries stagger `animation-delay` only — never color — so every landing section label stays at `--text-distant`.

### Motion tokens — the budget

Use the named durations, not arbitrary milliseconds:

| Token | When to use |
|---|---|
| `--dur-fast` 120ms | Tap feedback, instant state changes |
| `--dur-quick` 320ms | Hover / focus / active-link migration. **Default for UI feedback.** |
| `--dur-tick` 360ms | Sequenced reveals (stagger ticks) |
| `--dur-ink` 600ms | Slow color migrations on large surfaces |
| `--dur-enter` 1200ms | Hero / page-load signature reveals only |

Always pair durations with `--ease-ink`. Never `ease-in-out`. The `@media (prefers-reduced-motion: reduce)` block at the end of `tokens.css` zeros every `--dur-*` token — you get this for free by using the tokens.

## Component patterns

### Atom — typed Props

```astro
---
interface Props { skill: SkillEntry; writeSite?: string }
const { skill, writeSite } = Astro.props;
---
<article class="card">
  <h3>{skill.name}</h3>
</article>

<style>
  .card { background: var(--ink-raised); border: 1px solid var(--rule); }
</style>
```

### Section composer — data-bound

Section composers `await` a typed resolver from `src/lib/` in their frontmatter. **Never call `getCollection()` directly from a component** — nothing under `src/components/` or `src/layouts/` may import `astro:content`; they take typed data as props. Data access lives in the `src/lib/` adapters. The only exceptions are in `src/pages/`, where Astro forces the issue: `getStaticPaths` runs before `Astro.props` exists, so `src/pages/docs/reference/{skills,agents}/[slug].astro` call `getCollection()` there to enumerate routes, `src/pages/docs/index.astro` uses `getEntry()` for the docs root, and page templates call `render()` on an entry a `src/lib/` adapter handed them.

### Cross-section ornament — SumiInk

Need an SVG accent? Add a variant to `src/components/SumiInk.astro` (`corner` / `divider` / `backdrop` / `rss`). Don't create a new SVG component for one-off marks.

## Skinning third-party UI (Pagefind pattern)

Third-party UI components are runtime-injected and Astro's `<style>` block can't scope them. Pattern, as established in `src/components/Search.astro`:

1. **Token bridge** in a scoped `<style>` block — feed the library's CSS variables from `tokens.css`.
2. **Selector overrides** in a `<style is:global>` block — every rule prefixed with the component's mount-point id (`#search`) so nothing leaks.
3. **Specificity** — chain selectors to beat the library's framework-scoped rules. Pagefind uses `.pagefind-ui__x.svelte-xxxx` (0,2,0); `#search .pagefind-ui .pagefind-ui__x` (0,2,1) beats it regardless of stylesheet load order.
4. **Verify the variable name exists** — read the library's compiled CSS before mapping a token. `--pagefind-ui-font-family` looked plausible but was a no-op for months; the actual var is `--pagefind-ui-font`.

When a library doesn't expose a variable for a surface (e.g. Pagefind's `<mark>` highlight), override the raw selector globally with the `#search` prefix. Document the override target inline so the next contributor knows why the rule exists.

## Layout

- **Docs grid**: 240px sidebar / `minmax(0, 1fr)` content. When a page has headings, `DocsLayout` adds `.has-toc` and the track becomes `240px minmax(0, 720px) minmax(220px, 1fr)` — content pinned to the reading measure, remaining width to the TOC rail. Sidebar and TOC sticky on desktop; sidebar collapses to a drawer and the grid to a single column on mobile (≤720px).
- **Single scroll context per visual stack**: when a long region (search results, code block) lives inside an already-scrolling container, bound it with `max-height` and its own `overflow-y: auto`. Never stack two `overflow` regions that compete for the wheel.
- **No `max-w-7xl mx-auto` centered-stack defaults**. Sections own their max-width. The standard cap on the docs layout is 1280px.

## NEVER generate

- Default fonts: Inter, Roboto, Arial, system-ui as display type. Avoid the "distinctive but overused" trap too — Space Grotesk, Geist, Satoshi, Fraunces, Cormorant. They show up in every AI demo.
- Clichéd color: purple-to-blue gradients, generic SaaS blue (#3B82F6 family), evenly-distributed pastel palettes.
- Inline visual literals: hex codes, font names, raw `cubic-bezier(...)` outside `tokens.css`. Also never re-type a value that already has a token — reach for `var(--space-*)`, `var(--type-*)`, `var(--dur-*)` before writing a number.
- Tailwind utility classes: `max-w-7xl mx-auto`, `rounded-xl shadow-md`, `flex items-center gap-4`. This codebase is vanilla CSS + tokens — keep it.
- Generic motion: `transition: all 200ms ease-in-out`, fade-in on every scroll, identical bounces.
- React/Vue/Svelte islands. The site is pure `.astro` SFCs. No interactive client-side framework.
- `getCollection()` / `getEntry()` in components or layouts — those live in `src/lib/` adapters, with `getStaticPaths` and the docs-root lookup in `src/pages/` as the only exceptions.
- Inert interactive surfaces: anything that looks clickable must be a real `<a href>` or `<button>`, not a styled `<div>`.

## Cross-references

- Tokens: `src/styles/tokens.css`
- Global primitives (`.kicker`, `.mono`, `.card`, `.chip`, `.container`): `src/styles/global.css`
- Prose styles: `src/styles/prose.css`
- Component architecture: `.rpiv/guidance/packages/rpiv-site/src/components/architecture.md`
- Package architecture: `.rpiv/guidance/packages/rpiv-site/architecture.md`
- Pagefind skin reference: `src/components/Search.astro`
