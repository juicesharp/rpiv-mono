# Workflow Basics

A workflow chains Pi skills into a typed multi-stage graph with audited JSONL state, predicate routing, and per-stage output validation. Workflows are **skill-agnostic** — they name skills by their installed name, and the runner dispatches `/skill:<name>` via Pi's native skill loader.

## Table of Contents

- [Running workflows](#running-workflows)
- [When `/wf` refuses](#when-wf-refuses)
- [File structure](#file-structure)
- [Where files resolve](#where-files-resolve)
- [Layer merging](#layer-merging)
- [Config files](#config-files)
- [Pack files](#pack-files)
- [Skill aliases](#skill-aliases)
- [Run state](#run-state)
- [Run caps](#run-caps)
- [Trusting overlay files](#trusting-overlay-files)
- [Legacy layouts](#legacy-layouts)
- [Example](#example)
- [Glossary](#glossary)

## Running workflows

```bash
/wf                              # Preview every loaded workflow
/wf <name>                       # Preview one workflow's stage graph
/wf <name> <input>               # Run a workflow with <input> piped to the start stage
/wf <input>                      # Run the default workflow with <input>
/wf <name> <input> --name <slug> # Run under a human-readable alias
/wf @<ref>                       # Resume a past run
```

Running `/wf` without arguments shows a list of every loaded workflow and its stages. Running `/wf <name>` without input shows that workflow's stage graph in detail. The `<input>` string becomes the start stage's prompt. When the first token is not a recognised workflow name, the whole argument is treated as input for the resolved default workflow.

`/wf` floats the run off the prompt and returns immediately — stages execute detached in their own child sessions.

### `--name <slug>`

Assigns a human-readable alias to the run, stored in the JSONL header and the sidecar `names.json` index. It is honored **only** in the leading or trailing token position (leading wins if both are present) — a `--name` in the middle of your input stays as prompt text (`/wf fix the --name handling bug`) and `/wf` warns that the flag was ignored.

Slugs must match `/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/`. A slug already in use is rejected, and the error names the run that holds it.

### `@<ref>` — resume

```bash
/wf @2026-07-21_14-03-22-9f2a
/wf @nightly-docs
/wf @.rpiv/workflows/runs/2026-07-21_14-03-22-9f2a.jsonl
```

The `@` sigil on the first token resumes a past run. `<ref>` is a run-id, a run name assigned with `--name`, or a path to a `.jsonl` trail. A leading space after `@` is tolerated; trailing tokens are ignored. `--name` has no meaning on a resume — it is dropped with a warning.

Resume folds the JSONL trail back into run state and re-enters at the pending step. Completed fan-out units replay from their journaled output instead of re-running.

## When `/wf` refuses

| Condition | What you see |
| --- | --- |
| Non-interactive session | `/wf requires interactive mode` |
| No workflows registered | A message telling you to install a sibling that bundles workflows or author one in `.rpiv/workflows/config.ts`. This is the standalone-install default state — the package ships zero workflows |
| Any load issue with `severity: "error"` | `/wf: N config errors — see warnings above (fix and re-run)`; execution is blocked until the config loads clean |
| A run recorded under an older state schema | Resume is refused with a version mismatch. `STATE_SCHEMA_VERSION` is `2`; there is no in-place migration |
| First `/wf` before the runtime pre-warms | One toast: `rpiv: loading workflow runtime (first /wf after load)…`. The runtime pre-warms 2000 ms after extension load |

## File structure

```
<cwd>/.rpiv/workflows/
├── config.ts                 # The project's workflow config (hand-edited)
├── packs/                    # Pack files (installable bundles)
│   ├── my-pipeline.ts
│   └── ship.ts
└── runs/                     # Audited JSONL run state
    ├── <run-id>.jsonl
    ├── names.json            # --name → run-id index
    └── <run-id>/sessions/    # Child session files for the run's stages

~/.config/rpiv-workflow/
├── config.ts                 # User-level config
└── packs/                    # User-level packs
```

Every workflow file is TypeScript, loaded via `jiti` (no build step required). Import the authoring DSL from `@juicesharp/rpiv-workflow`:

```typescript
import { defineWorkflow, produces, acts, gate, gt, eq } from "@juicesharp/rpiv-workflow";
```

## Where files resolve

| Layer | Path |
| --- | --- |
| User config | `$XDG_CONFIG_HOME/rpiv-workflow/config.ts`, defaulting to `~/.config/rpiv-workflow/config.ts` |
| User packs | `$XDG_CONFIG_HOME/rpiv-workflow/packs/*.ts`, defaulting to `~/.config/rpiv-workflow/packs/*.ts` |
| Project config | `<cwd>/.rpiv/workflows/config.ts` |
| Project packs | `<cwd>/.rpiv/workflows/packs/*.ts` |
| Run state | `<cwd>/.rpiv/workflows/runs/` |

`XDG_CONFIG_HOME` governs the **user** layer only. Unset, empty after trimming, whitespace-only, or **relative** values fall back to `~/.config`. `~` and `~/…` are tilde-expanded and then required to resolve absolute; `~user/…` is not expanded and routes to the default. Absolute values are used verbatim. Pi's own paths (`~/.pi/…`, `PI_CODING_AGENT_DIR`) are deliberately *not* unified with this. `XDG_CONFIG_HOME` is the only environment variable this package reads.

## Layer merging

The loader merges workflows from five layers. Each later layer overrides earlier by workflow name:

```
built-in (registered by sibling packages like rpiv-pi)
  ← user packs        (~/.config/rpiv-workflow/packs/*.ts, alpha-sorted)
  ← user config       (~/.config/rpiv-workflow/config.ts)
  ← project packs     (<cwd>/.rpiv/workflows/packs/*.ts, alpha-sorted)
  ← project config    (<cwd>/.rpiv/workflows/config.ts)
```

Within a layer, the config file wins by workflow name over pack files. Only the config file may set the `default` workflow (the one `/wf <input>` runs without specifying a name). Defaults cascade: `project config > user config > first registered workflow`. With nothing registered anywhere, there is no default.

## Config files

The config file (`config.ts`) is the one TypeScript file you hand-edit. It accepts three default-export shapes:

```typescript
// 1. A single Workflow
import { defineWorkflow, produces, acts } from "@juicesharp/rpiv-workflow";
export default defineWorkflow({
  name: "ship",
  start: "implement",
  stages: { implement: acts(), commit: acts() },
  edges: { implement: "commit", commit: "stop" },
});

// 2. A Workflow[] with a single entry
export default [/* one workflow */];

// 3. The envelope form — required when shipping multiple workflows
export default {
  workflows: [/* many */],
  default: "ship",   // which one `/wf <input>` runs without a name
};
```

The envelope needs at least one of `workflows`, `default`, or `skillAliases`.

## Pack files

Pack files (`packs/*.ts`) are installable bundles others can drop in. They accept only `Workflow | Workflow[]` — the envelope form is rejected, and both `default` and `skillAliases` are hard-rejected.

```typescript
// .rpiv/workflows/packs/my-pipeline.ts
import { defineWorkflow, produces, acts } from "@juicesharp/rpiv-workflow";
export default defineWorkflow({
  name: "my-pipeline",
  start: "research",
  stages: { research: produces({ outcome: myOutcome }), implement: acts() },
  edges: { research: "implement", implement: "stop" },
});
```

This is what makes installable workflow packs safe: a pack contributes new workflows without overriding the user's default.

## Skill aliases

`skillAliases` remaps a skill name everywhere — across built-in, user, and project workflows — with one declarative config entry. It lives in the config-file envelope (packs can't set it) and is applied at load time **before validation**, so `/wf` preview, the JSONL audit, and the runtime skill-registry preflight all see the final skill:

```typescript
// .rpiv/workflows/config.ts
export default {
  skillAliases: { commit: "attributed-commit" },
};

// composes with workflows + default:
export default {
  workflows: [myWorkflow],
  default: "ship",
  skillAliases: { commit: "attributed-commit", "code-review": "strict-review" },
};
```

Every dispatching stage whose effective skill (`stage.skill ?? <stage key>`) matches an alias key is remapped to the target — note the key is the **skill** name, not the stage id. The mapping is one hop only (no transitive chains), skips `run`/`prompt` stages (they don't dispatch a `/skill:`), and merges **project over user** per key. An alias-only config (no `workflows`) is valid. `/wf` shows a `Skill aliases in effect: commit → attributed-commit` banner; an alias key that matches no dispatched skill in any workflow surfaces a load-time warning (a harmless no-op). A bad alias **target** (a skill that doesn't exist) is caught by the existing runtime "skill not found" preflight.

## Run state

Each `/wf` invocation appends one row per step to `<cwd>/.rpiv/workflows/runs/<run-id>.jsonl` — the append-only system of record that makes runs resumable. Run ids are `YYYY-MM-DD_HH-MM-SS-<4 hex>`, e.g. `2026-07-21_14-03-22-9f2a`.

Alongside the trail:

- `runs/names.json` — the `--name` slug → run-id index.
- `runs/<run-id>/sessions/` — the child session files backing that run's stages.

Trails carry `STATE_SCHEMA_VERSION`, currently `2`. A run recorded under a different version cannot be resumed.

The package sets no explicit file modes; writes use the process umask. If a write fails, the error tells you to check filesystem permissions for `.rpiv/workflows/runs/`.

## Run caps

Two backstops bound every run regardless of what a workflow declares:

| Cap | Default | Effect |
| --- | --- | --- |
| `maxIterations` | `32` | Run-wide ceiling on loop units of every kind. The effective loop cap is `min(loop.max, run.maxIterations)` |
| Backward-jump budget | `2` per destination stage | At most 3 executions of any one stage across decision-edge loop-backs |

## Trusting overlay files

`config.ts` and `packs/*.ts` are TypeScript modules, loaded through `jiti`, which **synchronously evaluates each file's top-level code** on first load and again on every edit (invalidation is mtime-driven). The threat boundary is the same as `npm install` post-install scripts or `tsx script.ts`.

If you run Pi in a freshly-cloned repository you do not control, diff `.rpiv/workflows/config.ts` and `.rpiv/workflows/packs/*.ts` before running `/wf`.

## Legacy layouts

Three stale layouts from before the unified `.rpiv/workflows/` tree are probed at load time. Each fires a **warning** only — nothing blocks the run — and the old locations are **not** read:

| Detected | Migration |
| --- | --- |
| `<cwd>/.rpiv-workflow/` | Move `workflows.config.ts` → `.rpiv/workflows/config.ts` and `workflows/*.ts` → `.rpiv/workflows/packs/`, then `rm -rf .rpiv-workflow`. The full shell command is in the warning text |
| Top-level `*.jsonl` directly under `<cwd>/.rpiv/workflows/` | `mkdir -p .rpiv/workflows/runs && mv .rpiv/workflows/*.jsonl .rpiv/workflows/runs/` |
| `<userConfigDir>/workflows.config.ts` | `mv <userConfigDir>/workflows.config.ts <userConfigDir>/config.ts` |

`.rpiv/workflows/` is commonly gitignored because it holds run state, so a moved `config.ts` may be silently uncommittable. Add `!.rpiv/workflows/config.ts` and `!.rpiv/workflows/packs/` to your `.gitignore` to version-control team workflow config.

These advisories sunset roughly three release cycles after 1.0.

## Example

A minimal workflow that chains two skills:

```typescript
import { defineWorkflow, produces, acts } from "@juicesharp/rpiv-workflow";

export default defineWorkflow({
  name: "review-and-ship",
  start: "code-review",
  stages: {
    "code-review": produces({ outcome: myOutcome }),
    commit: acts(),
  },
  edges: {
    "code-review": "commit",
    commit: "stop",
  },
});
```

Save this as `.rpiv/workflows/config.ts` in your project, then run `/wf review-and-ship implement auth feature`.

## Glossary

One canonical name per concept. Where two words exist for the same thing, the split is deliberate: one is the **authoring surface** (what you type in a workflow file), the other is the **data vocabulary** (what lands in rows, envelopes, and types).

| Term | Meaning |
|------|---------|
| **Workflow** | The typed graph: a name, a `start` stage, a `stages` record, an `edges` table. Built with `defineWorkflow`, loaded from config layers or registered programmatically. |
| **Stage** | One node of the graph — a unit of dispatch (skill session, prompt, or script). Two kinds: `"produces"` and `"side-effect"`. |
| **Kind vs. factory** | `kind` is the persisted data discriminator (`"produces"` \| `"side-effect"`); the factories are authoring verbs: `produces()` → `"produces"`, `acts()` → `"side-effect"`, `terminal()` → `"side-effect"` + `inheritsArtifacts: false`. `acts` is a verb because it reads naturally in a stage record (`commit: acts()`); `"side-effect"` is descriptive because it reads naturally in rows and output envelopes. `terminal` is **not** a third kind — it's `acts` plus an artifact-isolation flag. |
| **Run** | One execution of a workflow: a `runId`, an append-only JSONL run file (the system of record for resume), and the in-memory state the runner threads. |
| **Chain** | The path a run walks through the graph — stage activations following `edges` from `start` until `"stop"` or a halt. Loops add generations *within* one chain position. |
| **Output** | The envelope one stage activation hands downstream: `{ kind, data, meta, artifacts }` (`Output<K, D>`, `output.ts`). What predicates, routes, downstream prompts, and the audit log see. |
| **Outcome** | The producer-side declaration of *how* a stage's Output gets built from a session: `{ collector, parser? }` (`Outcome`, `output-spec.ts`). The collector enumerates artifacts; the parser interprets them into `data`. |
| **Verdict** | A judge's Output (`type Verdict = Output`). In `assess` / `verify` loops the judge emits a verdict that `done` reads; verdicts are recorded for resume but never become the stage result. |
| **Contract** | A skill contract — what a skill `consumes` / `produces`. Declared by the skill's owner or harvested from stage declarations; adjudicated at load time (`canCompose`, the validator) to check composition. |

For the full DSL reference (all stage factories, loops, routing, outcomes, validators), see [workflow-authoring.md](./workflow-authoring.md). To drive the runtime from code, see [embedding.md](./embedding.md).
