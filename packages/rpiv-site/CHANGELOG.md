# Changelog

All notable changes to `@juicesharp/rpiv-site` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.11.0] - 2026-05-20

### Changed
- `src/lib/agents.ts` now lists `artifact-code-reviewer` + `artifact-coverage-reviewer` in place of the retired `artifact-reviewer`.

## [1.10.2] - 2026-05-20

## [1.10.1] - 2026-05-19

## [1.10.0] - 2026-05-19

## [1.9.2] - 2026-05-19

## [1.9.1] - 2026-05-19

## [1.9.0] - 2026-05-18

### Added
- Blog post: "One Morning of the Driver-in-the-Loop Pipeline."

## [1.8.3] - 2026-05-18

## [1.8.2] - 2026-05-17

### Changed
- Site content updated to reflect the artifact path migration to `.rpiv/artifacts/`.

### Fixed
- Resolved W3C HTML and CSS validation errors, including heading-level skips, invalid ARIA attributes, and redundant landmark roles.

## [1.8.1] - 2026-05-17

### Changed
- Rework the pick-a-path guide for recipe-first reading, with scope-based entry points and customer-facing examples.
- Add release notes for v1.7.0 and v1.8.0.

## [1.8.0] - 2026-05-16

### Changed
- Update marketing-site infographic to reflect six-provider web search support.

## [1.7.0] - 2026-05-15

### Added
- Blog post on testing skill prompt changes with blinded LLM judges.
- Blog post on the discover vs SAGE A/B comparison study.
- Blog roll hero strip with sumi-ink backdrop and proper page heading.
- RSS feed link on the blog listing page.
- Post author displayed on blog index and in RSS `dc:creator`.
- Agent reference schema expanded with purpose, trigger condition, and dispatching skills.

### Changed
- Release notes blog post for v1.6.0 and v1.6.1.

## [1.6.1] - 2026-05-14

## [1.6.0] - 2026-05-14

### Added
- Structured reference pages for skills at `/docs/reference/skills/<slug>` with numbered editorial sections, input/output tables, and key-step rationales.
- Blog post on the discover skill's dialectic A/B study.

### Changed
- `/docs` pages use unified typography tokens and consistent kicker styles across all surfaces.
- Mobile navigation restructured as a three-row grid (brand, utility links, section links) so `/docs` is reachable from phones.

### Fixed
- Mobile `/docs` layout no longer leaks the 3-column desktop grid on articles with a table of contents.

## [1.5.2] - 2026-05-13

### Added
- Documentation site at `/docs` with sidebar navigation, table of contents, and Pagefind-powered search.
- Reference pages at `/docs/reference/skills` and `/docs/reference/agents` auto-render every rpiv-pi skill and subagent from upstream specs.
- Guides covering install and setup, an end-to-end pipeline walkthrough, workflow selection by feature scope, fresh-context discipline, session handoffs, and brownfield codebase onboarding.

### Changed
- Right-rail table of contents on `/docs` has clearer section-label/item contrast and an active-link anchor on the rail.

### Fixed
- Square OG image renders full-bleed; X/Twitter no longer exposes white corners through its circular crop mask.
- Pagefind search panel on `/docs` matches the site's color, type, and motion system and keeps the section nav visible when results are open.

## [1.5.1] - 2026-05-13

### Changed
- v1.5.0 release notes blog post.

### Fixed
- Blog post ordering tie-break using explicit timestamps.

## [1.5.0] - 2026-05-12

### Added
- Blog section with post listing, detail pages, serif prose typography, and RSS feed.

### Changed
- Navigation restructured into a two-tier grid layout with grouped utility links.
- RSS feed emits `<atom:updated>` for posts with an updated date.
- Footer link indentation normalized.

## [1.4.2] - 2026-05-11

## [1.4.1] - 2026-05-11

## [1.4.0] - 2026-05-10

## [1.3.1] - 2026-05-10

## [1.3.0] - 2026-05-08

### Added
- GitHub masthead link in the top navigation bar.

### Changed
- Off-scale typography, motion, and radius values consolidated into shared CSS custom properties.
- Skill key parity enforced at compile time; pipeline tokens use `color-mix()` instead of inline `rgba()` literals.

### Fixed
- Muted text color tokens lifted to pass WCAG AA contrast on small monospaced labels.

### Performance
- Critical CSS inlined into HTML to eliminate the render-blocking stylesheet chain.
- Latin woff2 font preloaded to flatten the critical rendering path.
- Scroll-spy offsets cached at layout time to avoid forced reflow during scroll.
- JetBrains Mono self-hosted via Fontsource to remove the third-party CDN render-blocking delay.

## [1.2.1] - 2026-05-07

### Added
- Pipeline section replaced with horizontal emaki disclosure — six scroll-snap panels with a "collects / why / produces" schema per step, plus mouse drag-to-scroll, keyboard navigation, and an IntersectionObserver-driven reveal animation.
- Pipeline section marks `/skill:discover` as optional with a dashed border and muted chip, and expands the ShipLoop section to four skills.

### Fixed
- Pipeline metadata keys are now enforced at compile time — adding a step to the pipeline array without a matching metadata entry fails TypeScript instead of silently omitting the panel's copy at runtime.

## [1.2.0] - 2026-05-07

### Added
- `scope-tracer` agent and `/skill:changelog` skill listed on the agents and skills pages with updated visitor copy.
- Version imprint in the top nav (between brand and section counter) and a quiet “EDITION · vX.Y.Z” line below the colophon rail. Both read from a single `lib/version.ts` that imports the lockstep version from `rpiv-pi/package.json` — the next release bump propagates automatically with zero hand edits. Nav imprint links to the pinned-version page on npm.

### Fixed
- X social card switched to summary + square logo for reliable preview rendering on low-engagement domains.
- Nav version imprint aligned on the same typographic baseline as the brand mark at desktop viewports.

## [1.1.5] - 2026-05-05
