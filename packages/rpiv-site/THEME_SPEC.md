# Old School Theme Specification

This document serves as a handoff and specification guide for the `theme/old-school` branch of the `rpiv-site` project. The next AI agent working on this branch should read and adhere to these guidelines to maintain the established aesthetic.

## 1. Design Philosophy
- **Content First, Presentation Second:** The primary goal is absolute readability and semantic structure. Flashy UI components (bento boxes, horizontal sliders, glassmorphism, heavy CSS grids) are strictly forbidden.
- **High-Contrast Light Mode:** A stark, classic web aesthetic using pure white backgrounds and high-contrast dark text to maximize legibility. Similar to early web documents or academic pages.
- **Multi-page Architecture:** The application operates as a traditional, routing-based multi-page website rather than a complex single-page application with JavaScript scroll-spying.

## 2. Color Palette (Reference `tokens.css`)
- **Backgrounds:** Pure white (`--ink: #ffffff`) and very light grays (`--ink-raised: #f9f9f9`) for structural separation.
- **Text:** Pure black or high-contrast dark grays (`--washi: #000000`, `--text: #111111`, `--text-quiet: #555555`).
- **Accents:** Vivid, classic web colors. We use standard Hyperlink Blue (`--sage: #0000ee`) and Dark Red (`--ochre: #cc0000`). No gradients are allowed anywhere on the site.

## 3. Typography
- Font sizes are scaled up significantly compared to traditional web apps to ensure comfortable reading (e.g., `--type-base` is `18px`).
- Stick to standard sans-serif (`Outfit`, `Inter`) for prose and readable content.
- Use monospace (`JetBrains Mono`, `Berkeley Mono`) heavily for technical elements, labels, metadata, and navigation links.

## 4. Component & CSS Guidelines
- **Layouts:** Use standard, linear HTML flows (`<ol>`, `<ul>`, `<article>`, `<section>`). Content should stack vertically and naturally.
- **Navigation:** The `Nav.astro` component must remain a static header containing absolute route links (`/pipeline`, `/agents`). **Do not re-introduce JavaScript scroll observers or sticky blurry backdrops.**
- **Banned CSS Properties:** Do not use `radial-gradient`, `linear-gradient`, `mix-blend-mode`, `box-shadow` (for glowing effects), or complex `display: grid` masonry layouts. 
- **Separation:** Use standard solid borders for element separation (e.g., `1px solid var(--rule)` or `border-bottom: 1px dashed var(--rule-strong)`).

## 5. Architectural Status
- The main landing page (`index.astro`) has been intentionally stripped down to core entry points (Hero, Install). Do not bloat it back up into a long-scrolling page.
- The complex components (`Pipeline.astro`, `AgentGrid.astro`) have been isolated into their own dedicated pages (`/pipeline.astro`, `/agents.astro`).
- They have been rewritten from heavily styled flex-tracks/CSS Grids into standard vertical HTML lists. Ensure any new data visualisations follow this exact same "boring but readable" list format.
