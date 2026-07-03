---
title: "Right-size the model"
description: "Spend reasoning where it earns it: per-skill, per-stage, and per-agent model and effort overrides via /rpiv-models."
section: "guides"
order: 7
---

Not every step deserves your best model. A pipeline run is a chain of skills with very different jobs. `design` makes a handful of decisions that shape everything downstream; `code-review` reads the whole diff through several lenses; `commit` writes a sentence. And the skills fan out across subagents that are just as uneven: a `codebase-locator` greps for where code lives and barely reasons, while a `codebase-analyzer` traces how it works. Point one expensive, high-reasoning model at all of it and you overpay on the mechanical steps and wait longer than you need to. Point one cheap model at all of it and the steps that carry the run quietly degrade: `research`, whose artifact everything downstream reads, or `design`, which hands `implement` a plan it will fight. The fix isn't a better single choice. It's spending the budget unevenly, on purpose.

That's what `/rpiv-models` is for. It overrides two things, independently, at four different granularities: **which model** runs a given step, and **how hard it thinks**. Everything lives in one file, `~/.config/rpiv-pi/models.json`, that the command edits for you, or you hand-edit if you prefer.

## The four places to spend

The leverage is uneven, so the controls are too. From the everyday knob to the surgical one:

**Per-skill** (`skills.<name>`) pins a skill wherever it runs: a standalone `/skill:design` you type yourself *and* a `design-slice` stage inside a pipeline. This is the one you'll reach for most. "`design-slice` always gets the strong model with high reasoning; `commit` always runs cheap" is two lines, and it follows the skills everywhere, including into loop-stage units. Each unit of a fanout (a grade panel's dimensions, a design fanout's slices) resolves its model through the same `skills.<name>` cascade. The reasoning-dense skills are where the strong model earns back its cost: `design-slice`, `synthesize`, `grade`, `code-review`, and `research`, whose synthesized artifact every later stage builds on. The mechanical ones (`commit`, and script-shaped stages) are where you claw it back.

**Per-stage** (`stages.<name>`) keys on the workflow *graph position*, not the skill. Reach for it when the same skill should behave differently depending on where it sits in a chain, like a `validate` stage that needs more reasoning in one shape than another. Most of the time per-skill is enough; per-stage is there when the position, not the skill, is what matters.

**Per-preset stage** (`presets.<workflow>.stages.<stage>`) is the surgical one: it scopes an override to a single stage *of a single bundled pipeline*. `code-review` runs on a capable model everywhere through the per-skill default, but `vet` exists only to review, so its `code-review` is worth pushing to `xhigh`, past what the same stage gets inside `polish` where it's one gate among many steps. Same skill, same stage name, one pipeline singled out. Two migration notes: overrides under the retired preset keys (`presets.ship`, `presets.arch`, `presets["pr-triage"]`) warn once at session start and stop applying; a `presets.build` entry, by contrast, silently carries over to the redefined 19-stage build. Review it if you tuned it for the old 7-stage chain.

**Per-agent** (`agents.<name>`) reaches the subagents skills fan out across, and they aren't uniform, so neither should their models be. The locators (`codebase-locator`, `precedent-locator`) and the row-only auditors (`diff-auditor`, `claim-verifier`) are finders: they grep, rank, and emit evidence rows, barely reasoning, so a cheap default already serves them well and the parallel fan-out makes the savings add up. The analyzers (`codebase-analyzer`, `scope-tracer`) trace data flow and synthesize, so they earn a bump above that floor. Because it's keyed per agent, you can split them exactly that way. Note one boundary: agent overrides are **global**. There is no per-preset agent override, because the schema deliberately rejects one: agents are wired into their definition files long before any workflow context exists (more on that below). An agent runs the same model whether `research` reached it from `build`, from a custom pipeline, or standalone.

Under all four sits **`defaults`**, the floor. Set a default model and every scope inherits it unless it says otherwise, so you can lift the whole pipeline onto a new model with one key and then carve out the exceptions.

A `models.json` that does all of this at once:

```json
{
  "defaults": {
    "model": "z-ai/glm-5.2",
    "thinking": "low"
  },
  "skills": {
    "research": {
      "model": "anthropic/claude-opus-4-8",
      "thinking": "high"
    },
    "design": {
      "model": "anthropic/claude-opus-4-8",
      "thinking": "high"
    },
    "plan": {
      "model": "anthropic/claude-opus-4-8",
      "thinking": "high"
    },
    "code-review": {
      "model": "opencode-go/mimo-v2.5-pro",
      "thinking": "high"
    },
    "commit": {
      "thinking": "off"
    }
  },
  "agents": {
    "codebase-analyzer": {
      "model": "anthropic/claude-opus-4-8",
      "thinking": "medium"
    }
  },
  "presets": {
    "vet": {
      "stages": {
        "code-review": {
          "model": "opencode-go/mimo-v2.5-pro",
          "thinking": "xhigh"
        }
      }
    }
  }
}
```

It reads as the philosophy: a cheap, low-effort default drives the bulk of the run; the reasoning-dense skills (`research`, `design`, `plan`, `code-review`) are bumped up; `commit` keeps the cheap default model but switches reasoning off; the one analyzer that earns more than the finder floor gets a bump; and `vet`'s review is pushed all the way to `xhigh`, since reviewing the diff is the only thing `vet` does.

Each leaf is either a bare model string (`"z-ai/glm-5.2"`, which sets the model and lets reasoning inherit) or an object that sets `model`, `thinking`, or both. `commit` above sets only `thinking`, keeping the inherited default model and just switching reasoning off. One note on the keys themselves: they're illustrative. Use the exact `provider/modelId` strings your own `/rpiv-models` picker lists, since those come from the providers you actually have installed.

## Effort is its own dial

Model and reasoning effort are separate axes, and the second one is easy to under-use. There are five graded levels (`minimal`, `low`, `medium`, `high`, `xhigh`) plus a real `off`. The distinction that trips people up:

- **Omit `thinking` entirely** and the step inherits your session's baseline level. This is "I care about the model here, not the effort."
- **Set `thinking: "off"`** and reasoning is *disabled* for that step. This is a deliberate "don't think, just do it," the right call for a mechanical `commit` or a script-shaped stage, where reasoning tokens are pure latency.

So a cheap model with `high` reasoning and an expensive model with `off` are both reasonable, opposite trades. Pick per step.

## When two rules overlap

The scopes nest, so a single step can match more than one. The most specific wins, in this order:

```
presets.<wf>.stages.<stage>   →   stages.<stage>   →   skills.<skill>   →   defaults
```

A `code-review` stage running inside `polish` checks the preset-stage rule first, then the flat stage rule, then the per-skill rule, then defaults, and stops at the first hit. `defaults` is folded into every entry as it loads, so falling through never loses a field you set there. The layers do not merge with *each other*, though: the first match wins whole. If you set only `thinking` on a preset stage, its model comes from `defaults`, not from the per-skill entry one rung down, which is why the `vet` override above names its model explicitly.

## The one thing that bites

Stage and skill overrides apply **live**: the runner sets the model at each stage boundary, and a standalone `/skill:` invocation picks up its override the moment you run it. Change one, and the next run uses it.

Agents are different. An agent's model and effort live in its **frontmatter on disk**, written at sync time rather than read at runtime. (That's also why there's no per-preset agent override to give: the sync that writes that frontmatter runs with no workflow in hand.) A fresh session re-syncs and picks up your latest `agents.*` edits on its own, but mid-session they won't land until you run **`/rpiv-update-agents`**. That command re-reads `models.json` and rewrites the agent files on the spot. One wrinkle: if you've hand-edited an agent file yourself, the session-start sync leaves it untouched, and `/rpiv-update-agents` is what forces your config over that manual edit. Everything else in this guide applies the moment the config loads.

## The picker, and the file

`/rpiv-models` is the front door. It walks you down a cascade (pick a **scope** of defaults / agents / stages / skills / presets, then the **key** for which skill, which stage, which workflow-and-stage, then the **model**, then the **effort**) and writes the result. It marks every place an override is already set with a `✓` and floats those to the top, so the picker doubles as a view of what you've configured. You can clear a single override from any scope, or reset everything behind a confirm.

The skill and stage lists are live: third-party and user skills show up alongside the bundled ones, and the stage list comes from your actually-loaded workflows. The effort picker offers `inherit (no override)` and `off (disable reasoning)` as distinct choices, matching the two-meanings-of-off distinction above.

Prefer to hand-edit? The file is plain JSON at `~/.config/rpiv-pi/models.json`, and edits take effect on the next session (or the next `/rpiv-update-agents` for agents). One safety net worth knowing: a record-key typo like `skills.committ` or `presets.vett` passes JSON validation but would silently never apply, so a session-start check warns you once when a configured key matches no real skill, stage, agent, or workflow. If an override isn't taking and you didn't get a warning, the key is right and the cause is elsewhere (usually a forgotten `/rpiv-update-agents`).

## Next steps

- [Pick your path](/docs/guides/pick-a-path): where the cheap-driver, strong-where-it-matters split comes from, and the plan-review move this makes permanent
- [Run a workflow](/docs/guides/run-a-workflow): the bundled chains whose stages these overrides target
- [Compose skills as skills](/docs/guides/compose-skills-as-skills): authoring your own chains, whose stages and skills the same overrides reach
