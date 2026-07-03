---
slug: frontend-design
tagline: Forces a deliberate aesthetic *before* a line of frontend code. Scans the project's style system, asks only what isn't settled, and injects tailored design guidelines plus an anti-slop list.
purpose: |
  Stops AI-generated frontends from converging on the same Inter + SaaS-blue + three-centered-cards default. `frontend-design` scans the project for existing style context, asks an adaptive aesthetic checkpoint, then injects a guidelines brief that primes every subsequent turn in the session.
when_to_use:
  - You're building a page, a full layout, or a new application.
  - You explicitly want design direction before coding.
  - Skip for single-component requests in codebases with an established style system. The existing tokens already encode the decisions.
inputs:
  - name: --headless (flag)
    required: false
    source: Skips the interview; scans the project and injects findings as guidelines verbatim
  - name: design intent (inline)
    required: false
    source: Phrases like "editorial dark with copper accents" or referenced files (DESIGN.md, brand decks)
    notes: Vague adjectives ("modern", "clean") do not count. Only named directions settle a dimension.
outputs:
  - artifact: Aesthetic guidelines brief
    path: in-session message (system context)
    format: markdown guidelines + anti-slop list
key_steps:
  - title: Extract user-settled dimensions from input
    rationale: Files (DESIGN.md, style guides) and named inline aesthetic phrases pre-settle dimensions, so the interview only asks about what's genuinely open. Vague adjectives are explicitly rejected as non-commitments.
  - title: Scan the codebase for style context
    rationale: A `codebase-locator` agent finds DESIGN.md, token files, Tailwind/CSS configs, custom-property definitions, and component libraries. Scan findings merge with user-settled dimensions to determine the auto-resolution baseline.
  - title: Adaptive aesthetic checkpoint
    rationale: Empty scans get a 2-question micro-interview; established systems get scan-only injection; mid-state projects get a full 7-dimension checkpoint with skip logic. The interview size scales to what's actually unsettled.
  - title: Synthesize and inject the guidelines brief
    rationale: Output is the *product*, a tailored brief plus an anti-slop list that every subsequent turn references. Half-commitments produce the slop the skill exists to prevent, so the brief is deliberately opinionated.
related:
  upstream: []
  downstream: []
---
