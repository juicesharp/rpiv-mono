---
name: frontend-design
description: "Inject tailored visual design guidance for frontend work. Scope: web frontends (HTML/CSS/JS, React, Vue, Svelte, Astro, etc.). Aesthetic principles generalize to native/TUI but examples assume web. Use when the user asks to build a page, full layout, or new application, or explicitly wants design direction. SKIP for single-component requests in codebases with an established style system. The skill auto-adapts: empty scan → 2-question micro-interview; established system → scan-only injection; otherwise full 7-dimension checkpoint with skip logic."
argument-hint: "[--headless]"
disable-model-invocation: true
contract:
  produces:
    kind: side-effect
    meta:
      effect: design-guidelines-injection
---

# Frontend Design

Frontend code without aesthetic intent reads as AI slop — Inter, SaaS blue, three centered cards. This skill forces a deliberate aesthetic *before* a line of code. Scan what exists. Ask only what isn't settled. Synthesize a brief that primes every subsequent turn.

The brief is the product. Boldness is the standard. Half-commitments produce the slop the skill exists to prevent.

Two invocation modes:
- **Full checkpoint** (default): scan → 7-dimension interview → inject guidelines
- **Headless** (`--headless`): scan → inject findings as guidelines → stop (no interview)

## Input

`$ARGUMENTS` — optional `--headless` flag for scan-only mode; otherwise full aesthetic checkpoint. Inline design-intent phrasing (e.g., "editorial dark with copper accents") and referenced design files (DESIGN.md, style guides, brand decks) are also read.

## Flow

1. Input → 2. Style discovery → 3. Aesthetic checkpoint → 4. Guideline synthesis

## Steps

### Step 1: Input Handling

1. **No argument provided** — full checkpoint mode:
   ```
   I'll guide your frontend design direction. Provide one of:

   `/skill:frontend-design`                — full aesthetic checkpoint (scan + interview + guidelines)
   `/skill:frontend-design --headless`     — scan-only: inject style findings without interview
   ```
   Then wait for input.

2. **The input contains `--headless`** — headless mode:
   - Set mode to `headless`. Proceed to Step 2. After Step 2, skip Step 3 and go directly to Step 4.

3. **Otherwise** — full checkpoint mode:
   - Set mode to `full`. Proceed to Step 2.

4. **Extract design intent from the input itself** — both files and inline phrasing.
   - **Read referenced files fully** (DESIGN.md, style guides, brand decks, tickets, named paths). Each dimension the file commits to (tone, color, type, motion, spatial, backgrounds, differentiation) counts as user-settled.
   - **Parse inline aesthetic commitments**: phrases like "editorial dark with copper accents", "brutalist serif on cream", "1985 terminal aesthetic". Record each named dimension as user-settled.
   - **Do not count vague adjectives.** "Modern", "clean", "fresh", "professional", "polished", "minimal-ish" are non-commitments — they do not settle any dimension. The user must name a specific direction for it to count.
   - **External references** (URLs, Figma links, screenshot paths) cannot be fetched from inside this skill. If the user supplies one without an inline excerpt, ask them to paste the relevant tokens/text — do not proceed with a guess.

Carry the resulting **user-settled dimensions** forward. They merge with scan findings in the auto-resolution step.

**No agent dispatch in Step 1.** Only `Read` on user-named paths.

### Step 2: Style Discovery (parallel agents)

Dispatch a single codebase-locator agent to scan for existing style context.

**Agent — Style system scan:**
- subagent_type: `codebase-locator`
- description: "Scan for style systems"
- prompt: "Scan the project for existing style context. Look for: (1) DESIGN.md files (Google's design spec), (2) design token files (tokens.css, tokens.json, design-tokens.*), (3) Tailwind/CSS framework configs (tailwind.config.*, postcss.config.*), (4) style guide or brand guideline files, (5) CSS custom property definitions (--color-*, --font-*, --spacing-*), (6) component library setups (Storybook, component indexes). Return file paths grouped by category with line offsets."

Wait for the agent to complete before proceeding.

### Scan Findings Summary

Present findings grouped by dimension:
- **DESIGN.md**: found at `path/to/DESIGN.md` (or "none found")
- **Tokens/Variables**: found at `path/to/tokens.css` with N custom properties (or "none found")
- **Framework config**: found at `path/to/tailwind.config.ts` (or "none found")
- **Style guides**: found at `path/to/style-guide.md` (or "none found")
- **Component library**: found at `path/to/components/` with N files (or "none found")

### If DESIGN.md found

Read it FULLY using the Read tool. This is the primary style source — its decisions take precedence over scan findings for the checkpoint.

### Headless exit

**If mode is `headless`:**
1. Synthesize scan findings into concise style guidelines (respect what exists, note what's missing)
2. Inject as assistant message (see Step 4 output format)
3. **Stop — do not proceed to Step 3.**

### Auto-mode resolution (full mode only)

**Combine** scan findings (Step 2) with user-settled dimensions (Step 1 item 4) into a single tally of pre-settled dimensions across the 7 axes. Then classify:

- **No evidence** (empty scan AND no user intent): proceed to Step 3 but ask **only Dimension 1 (Tone) and Dimension 7 (Differentiation)**. Skip 2-6. Note: "No project context, no inline intent — running micro-interview to avoid interviewing into a void." Step 4 lines for skipped dimensions read: "{dimension}: open — pick to match the chosen tone."

- **Near-complete** (DESIGN.md present, OR ≥4 of 7 dimensions settled across scan + user intent combined): auto-downgrade to headless. Note the source(s): "Established style system detected" and/or "User intent covers {N}/7 dimensions — switching to headless." Run Step 4 directly.

- **Partial** (1-3 dimensions settled, no DESIGN.md): proceed to full Step 3. Skip logic in Step 3 trims dimensions already settled by either scan or user intent — only ask the unsettled axes.

**Project context leads on conflict.** Scan-found tokens/configs override inline intent that contradicts them, unless the user explicitly signals override ("ignore tokens.css and lean dark", "override DESIGN.md", etc.). When intent and scan don't conflict, they merge — scan covers Color via tokens, user supplies Tone, both count.

### Full checkpoint continuation

Carry scan findings forward — they inform skip logic and pre-fill recommendations.

### Step 3: Aesthetic Checkpoint

Ask the developer about aesthetic direction across 7 dimensions. Use `ask_user_question` — one question at a time, wait for the answer before asking the next. Lead each question with the recommended option labeled `(Recommended)`.

### Skip Logic

Before asking each dimension, check if the scan (Step 2) found a **complete system** for that dimension. If yes, note the finding and skip the question. If the system is partial, still ask but pre-fill the recommendation from the scan.

**Skip thresholds by dimension** (agent judgment — these are examples, not rigid checklists):
- **Typography**: skip if font imports + type scale + CSS variables for font families all exist
- **Color**: skip if color palette tokens + theme variables + accent colors all exist
- **Motion**: skip if transition/animation tokens or a motion library is configured
- **Spatial**: skip if spacing scale tokens + layout system (grid/flex patterns) both exist
- **Backgrounds**: skip if texture/gradient/pattern definitions exist in the style system
- **Tone/Mood**: never skip — conceptual, not detectable from code
- **Differentiation**: never skip — conceptual, requires developer input

When skipping, record: "Dimension X: [finding from scan] — respecting existing system."

### Dimension 1: Tone & Mood

Ask via `ask_user_question`:
- Question: "Pick a tone and commit. What should this interface FEEL like on first glance?"
- Header: "Tone"
- Options (pick 3-4 that fit the project context, always include the first):
  - "Editorial (Recommended)" — magazine spread, not SaaS dashboard. Type does the work.
  - "Brutally minimal" — strip everything that isn't load-bearing. Monochrome, no decoration, no apology.
  - "Playful / toy-like" — rounded, bright, bouncy. Treat the cursor like it wants to play.
  - "Retro-futuristic" — CRT scanlines, neon, terminal green. The future from 1985.
  - "Luxury / refined" — dark palette, serif display, restrained gold. Expensive on purpose.
  - "Brutalist / raw" — exposed structure, harsh contrast, system fonts as a statement.
  - "Art deco / geometric" — ornament, symmetry, metallic accents. Decorative without apology.
  - "Soft / pastel" — light, rounded, gentle. Should feel like a held breath.
- If the DESIGN.md or scan findings suggest a tone, make that the `(Recommended)` option.

### Dimension 2: Color Direction

Ask via `ask_user_question`:
- Question: "What color direction? Commit to dominance — timid palettes are why everything looks the same."
- Header: "Color"
- Options:
  - "Dark, warm accents" — near-black ground, amber/rust/copper. Lit by candle, not screen.
  - "Dark, cool accents" — near-black ground, electric blue/teal. Lit by neon.
  - "Light, muted" — off-white ground, desaturated earth. Newsprint, not iCloud.
  - "Light, vibrant" — paper-white ground, one bold primary doing all the talking.
  - "High contrast" — stark black/white, one accent. Refuses to be background.
- If scan found color tokens/theme, make the closest match the `(Recommended)` option.

### Dimension 3: Typography

Ask via `ask_user_question`:
- Question: "What typography direction? No Inter. No Space Grotesk. Pick something with a face."
- Header: "Typography"
- Options:
  - "Serif display + sans body" — editorial. Headings carry the character.
  - "All sans, distinctive pairing" — modern, but pair unexpected weights/widths. Not Inter on Inter.
  - "Monospace-forward" — terminal aesthetic. For tools, dev surfaces, anything that earns it.
  - "Display serif + mono accents" — editorial meets technical. Best for content with structure.
- If scan found font imports/type scale, pre-fill the `(Recommended)` option from what exists.

### Dimension 4: Motion

Ask via `ask_user_question`:
- Question: "How much motion? One orchestrated reveal beats ten random hovers."
- Header: "Motion"
- Options:
  - "Subtle micro-interactions" — hover, focus, transition. Felt, not noticed.
  - "Bold page-load choreography" — staggered reveals, scroll-triggered. The entrance is the show.
  - "CSS-only, no JS" — pure CSS transitions. Lightweight, no runtime cost.
  - "Static" — zero animation. Type and layout do everything. Hardest to do well.
- If scan found animation tokens/motion library, pre-fill the `(Recommended)` option.

### Dimension 5: Spatial Composition

Ask via `ask_user_question`:
- Question: "What spatial composition? Symmetry is the default — pick it on purpose or break it on purpose."
- Header: "Spatial"
- Options:
  - "Generous whitespace, asymmetric" — editorial. Offset, breathe, refuse to fill the screen.
  - "Dense, information-rich" — dashboard. Every pixel has a job. Density as the aesthetic.
  - "Grid-breaking, overlapping" — layered, intentional rule-violation. Elements bleed past each other.
  - "Structured grid, symmetric" — predictable alignment. Earns it through type and color, not layout drama.
- If scan found spacing tokens/grid system, pre-fill the `(Recommended)` option.

### Dimension 6: Backgrounds & Texture

Ask via `ask_user_question`:
- Question: "What background treatment? Background is atmosphere — flat solids are the slop default."
- Header: "Backgrounds"
- Options:
  - "Solid with noise/grain" — flat color, texture overlay. Cheap depth, big payoff.
  - "Gradient mesh" — multi-color, blurred shapes. Atmospheric. Avoid the purple-blue cliche.
  - "Geometric patterns" — repeating shapes, lines, decorative motifs. Earns the maximalist tag.
  - "Clean solid, no texture" — pure flat. Only when content is doing all the visual work.
- If scan found background/texture definitions, pre-fill the `(Recommended)` option.

### Dimension 7: Differentiation

Ask via `ask_user_question`:
- Question: "What makes this UNFORGETTABLE? Name the one thing someone will remember a week later."
- Header: "Differentiation"
- Options (pick 2-3 that fit, always include an open-ended):
  - "Typography as art" — oversized, expressive type IS the visual. Heading does what an image would.
  - "Unexpected interaction" — a signature pattern that surprises. Cursor, scroll, or hover that no one else does.
  - "Atmosphere" — immersive background/texture that sets a mood before content loads.
  - "Layout rebellion" — breaks every grid convention on purpose. Visible intent in the structure.
- This dimension is always asked — it cannot be derived from scan findings.

### Record Checkpoint Answers

After all 7 dimensions (or all unsettled dimensions if some were skipped), compile the answers into a structured record:
- Each settled dimension: "Dimension: chosen option"
- Each skipped dimension: "Dimension: [existing finding] — respecting existing system"

Carry this record to Step 4 for guideline synthesis.

### Step 4: Guideline Synthesis

Combine scan findings (Step 2) and checkpoint answers (Step 3, or scan-only findings in headless mode) into tailored aesthetic guidelines. Emit as your own assistant message — this primes your context for all subsequent frontend code generation.

### Output Format

Structure the guidelines as a concise, actionable brief:

```markdown
## Frontend Design Guidelines

**Commit to the vision.** Pick an extreme and execute it with precision — bold maximalism and refined minimalism both work, timid middles don't. Match implementation complexity to the aesthetic: maximalist designs need elaborate animations and effects; minimalist designs need restraint, precision, careful spacing. Elegance comes from executing the vision well, not from playing it safe.

**Tone**: {chosen tone} — {1-sentence description of how it manifests}
**Color**: {chosen direction} — {specific palette suggestion: primary, accent, background}
**Typography**: {chosen direction} — {specific font suggestions: display + body}
**Motion**: {chosen level} — {specific approach: CSS transitions, scroll triggers, etc.}
**Spatial**: {chosen composition} — {layout approach: grid, whitespace, asymmetry}
**Backgrounds**: {chosen treatment} — {specific texture/gradient/solid approach}
**Differentiation**: {chosen differentiator} — {how to make it unforgettable}

{For each skipped dimension:}
**{Dimension}**: Respecting existing system — {brief description of what was found at `file:line`}

### NEVER Generate

- **Default fonts**: Inter, Roboto, Arial, system-ui as display type. Also avoid the "distinctive but overused" trap — Space Grotesk, Geist, Satoshi for sans; Fraunces, Cormorant, EB Garamond for editorial serif. These appear in every AI demo. Pick something with actual character for the chosen tone (Old Standard TT, Bodoni Moda, Newsreader, IBM Plex Serif, Tiempos, GT Sectra all carry more weight without being defaults yet).
- **Clichéd color**: purple-to-blue gradients on white, generic "SaaS blue" (#3B82F6 family), evenly-distributed pastel palettes. Commit to dominant colors with sharp accents.
- **Predictable layout**: centered card stacks, hero-then-three-columns, cookie-cutter navbars, every section wrapped in `max-w-7xl mx-auto`. Asymmetry, overlap, and grid-breaking beat symmetry.
- **Cookie-cutter components**: identical `rounded-xl shadow-md` cards, generic ghost buttons.
- **Generic motion**: fade-in on every scroll, identical bounce easings, scattered micro-interactions with no choreography. One well-orchestrated page-load reveal beats ten random hover effects.
- **Inert interactive surfaces**: anything that looks clickable/tappable must actually be. Web: real `<a href>` or `<button>`, not styled `<div>`/`<span>`. React/Vue: real `<Link>` or `@click` handler. SwiftUI: `Button`/`NavigationLink`, not styled `Text`. Native: real tap target. The visual affordance promises behavior — keep the promise or remove the affordance.

{If DESIGN.md was NOT found in Step 2:}

**Note**: No DESIGN.md found in this project. Consider creating one to codify these design decisions for future reference. See Google's DESIGN.md spec for format guidance.
```

### Injection

Emit the complete guidelines as your own assistant message. Do NOT write to a file. Do NOT use `pi.sendMessage`. The guidelines become part of the conversation transcript — they survive compaction and inform all subsequent turns.

If in headless mode, the guidelines should be briefer — focus on what the scan found and how to respect it, skip the full checkpoint synthesis.

## Important Notes

- **Frontmatter**: `allowed-tools` is intentionally omitted — the skill inherits `Agent`, `ask_user_question`, `Read`, `Write`, `Bash`, `Glob`, `Grep`. Do NOT re-add the line.
- **Always scan before asking**: Step 2 (style discovery) always runs before Step 3 (checkpoint). Never ask aesthetic questions without first checking what exists.
- **One question at a time**: Use `ask_user_question` for each dimension individually. Never batch multiple dimensions into one call.
- **Never ask confirmatory questions**: Do not ask "does this look good?" or "want to adjust?" at the end. The guidelines ARE the output — emit them and stop.
- **Skip logic is judgment, not rules**: The skip thresholds are examples. If a project has a partial system that's clearly intentional (e.g., 3 custom font variables but no full scale), skip and note it.
- **Headless mode exits after Step 2**: When `--headless` is passed, scan → inject findings → stop. Do not proceed to Step 3.
- **Anti-slop list is always included**: Every invocation (full or headless) includes the NEVER Generate list. This is not optional.
- **DESIGN.md takes precedence**: If a DESIGN.md file is found, its decisions override scan findings for the checkpoint. Read it fully before asking questions.
- **Guidelines are inline, not persisted**: The output is an assistant message, not a file. If the developer wants to persist the guidelines, they should create a DESIGN.md manually.
- **No template files**: This skill is a single SKILL.md. Do not create `templates/` or `examples/` subdirectories.
