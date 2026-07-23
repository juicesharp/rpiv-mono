# Skills reference

Every skill `@juicesharp/rpiv-pi` ships, what it consumes, what it writes, and
whether the model may reach for it on its own.

## How to read these tables

- **Invoke** — `/skill:<name>` from inside a Pi session, or as a stage of a `/wf`
  workflow (see [workflows.md](./workflows.md)).
- **Auto** — ✓ means the model may select the skill by itself from your prompt.
  18 of the 27 skills set `disable-model-invocation: true` and are marked —;
  those run *only* on an explicit `/skill:<name>` or a workflow dispatch. A short
  stage index is injected at session start so the model still knows they exist and
  can suggest one.
- **Writes** — the artifact bucket under `.rpiv/artifacts/`. "side-effect" means the
  skill changes the repo (code, commits, docs) rather than emitting an artifact.
- Every skill declares a `contract:` block (`produces` / `consumes`) in its
  frontmatter. `/wf` uses those contracts to route each stage's output into the next
  stage's input without you naming paths.

## Intent and research

| Skill | Auto | Consumes | Writes | What it does |
| --- | :---: | --- | --- | --- |
| `discover` | — | free text, or an existing artifact path | `discover/` | Interviews you one question at a time and synthesizes a Feature Requirements Document. The first question is intent-only, before any codebase probe; later ones ground in what the probe found. Its Decisions block flows through `research` into `design`. |
| `research` | — | free text, or a `discover` artifact | `research/` | Dispatches `scope-tracer` to formulate trace-quality questions, answers them with parallel analysis agents, and synthesizes a research document. |
| `explore` | — | a `research` artifact | `solutions/` | Compares solution approaches with pros, cons, trade-offs, and a recommendation. Use when several implementations are valid. |
| `slice` | — | a `research` artifact | `slices/` | Cuts the work into independent vertical slices, each separately designable, with a machine-readable `slices:` frontmatter array. Also runs in re-slice mode to structurally re-cut a map that failed a readiness gate. |

## Design

| Skill | Auto | Consumes | Writes | What it does |
| --- | :---: | --- | --- | --- |
| `design` | — | `research` or `solutions` | `designs/` | Decomposes a feature into vertical slices, generates code slice by slice with per-slice `slice-verifier` dispatch, and emits architecture decisions, slice breakdown, and file map. |
| `design-slice` | — | `slices` (+ upstream `design`) | `designs/` | Designs exactly ONE slice in isolation — decisions, file map, key interfaces, integration points, success criteria. A fanout unit, not standalone. |
| `design-review` | — | every per-slice `design` + the `slices` map | in-place edits | One consolidated developer checkpoint over a whole design fanout: accept or adjust the proposed shape, adjustments applied surgically and cascaded to dependent slices. |
| `synthesize` | — | N `designs` (or N `subplans`) | `plans/`, `subplans/` | Merges independent per-slice designs into one coherent phased plan, reconciling overlaps and ordering phases by slice dependency. Runs hierarchically for large slice maps via `--as-subplan`. |

## Planning

| Skill | Auto | Consumes | Writes | What it does |
| --- | :---: | --- | --- | --- |
| `plan` | — | a `design` artifact | `plans/` | Converts a design into parallelized atomic phases with explicit success criteria. Prefer it when a straightforward phased breakdown is enough. |
| `blueprint` | — | `research` or `solutions` (optional) | `plans/` | Fuses design + plan in one pass: vertical-slice decomposition with developer micro-checkpoints between phases, emitting an implement-ready plan. Lighter subagent fan-out than `design` — it trusts the research artifact's integration and precedent sections. |
| `elaborate` | — | a `plan` artifact | `elaborations/` | Writes implement-ready code into ONE phase of a synthesized plan. A fanout unit; the results are stitched back into the plan. |
| `revise` | — | a `plan` (+ optional `reviews`) | `plans/` | Surgically updates an existing plan after review feedback, a mid-implement blocker, or a scope change — preserving structure instead of rewriting. |
| `amend` | — | one artifact + its `grade` verdicts | same artifact | Fixes only the failing dimensions a grade panel flagged and re-emits the artifact in place. Single-pass, no subagents; a gate's revise stage. |

## Execution and verification

| Skill | Auto | Consumes | Writes | What it does |
| --- | :---: | --- | --- | --- |
| `implement` | — | a `plan` artifact | code changes | Executes a plan phase by phase, verifying each phase against its success criteria before moving on. |
| `validate` | — | a `plan` + the working tree | `validation/` | Runs each phase's success criteria against the working tree and reports a `pass` / `fail` verdict. |
| `code-review` | ✓ | the working tree, a branch, or a PR | `reviews/` | Parallel specialist agents audit the diff, compare against peer code, and verify claims. Emits `blockers_count` plus severity-tagged findings. Scope argument accepts `staged`, `working`, a hash, `A..B`, or a branch; empty scope defaults to feature-branch vs default-branch. |
| `architecture-review` | — | a file, directory, or module path | `architecture-reviews/` | Top-down, layer-by-layer audit with a uniform 10-dimension checklist per layer, triaged through a developer checkpoint. Emits a phased polish plan `blueprint` can consume per phase. Language-agnostic. |
| `grade` | — | one artifact + one dimension name | `verdicts/` | Judges ONE artifact along ONE named quality dimension and writes a verdict JSON. It only judges — no fixes. A panel member, not standalone. |
| `commit` | ✓ | a dirty working tree | git commits | Groups staged and unstaged changes into one or more logical commits with descriptive messages. |

## Repository utilities

| Skill | Auto | Consumes | Writes | What it does |
| --- | :---: | --- | --- | --- |
| `pr-triage` | ✓ | a PR number, URL, or the current branch | `triage/` | Read-only triage of a GitHub PR: disposition (Review / Request changes / Hold / Decline), a security tier (0–2), and convention drift. Never checks out or mutates the working tree. |
| `create-handoff` | ✓ | the current session | `handoffs/` | Compacts the current task, decisions, in-flight changes, and open questions into one file a fresh session can pick up. |
| `resume-handoff` | ✓ | a `handoff` document | continues work | Reads the handoff, verifies repo, branch, and state, and continues from where the previous session stopped. |
| `annotate-guidance` | ✓ | the source tree | `.rpiv/guidance/**/architecture.md` | Generates architecture guidance in a shadow tree alongside the source. rpiv-pi injects these automatically — see [architecture.md](./architecture.md). |
| `annotate-inline` | ✓ | the source tree | `CLAUDE.md` files | Same analysis, written inline next to the code instead of into a shadow tree. |
| `migrate-to-guidance` | ✓ | existing `CLAUDE.md` files | `.rpiv/guidance/` | Finds every `CLAUDE.md`, transforms internal references, and creates equivalent `architecture.md` files. `--delete-originals` removes the sources. |
| `changelog` | ✓ | git history + the working tree | `CHANGELOG.md` edits | Regenerates the `[Unreleased]` section of every affected changelog in Keep a Changelog style from Conventional Commit prefixes. Monorepo-aware and idempotent. |
| `frontend-design` | — | the project's style system | injected guidance | Injects tailored visual design guidance for web frontend work. Auto-adapts: empty scan → 2-question micro-interview; established design system → scan-only injection. |

## Artifact buckets

Everything lands under `.rpiv/artifacts/` in the project you are working in:

```
.rpiv/artifacts/
├── goal/                   discover/            research/
├── solutions/              slices/              designs/
├── elaborations/           plans/               subplans/
├── verdicts/               reviews/             validation/
└── architecture-reviews/   triage/              handoffs/
```

The directory is created lazily by the first skill that writes into it.
