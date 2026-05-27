# Workflow Authoring Reference

Complete reference for the `@juicesharp/rpiv-workflow` authoring DSL. A workflow is a typed graph: named entry point, a `stages` record, and an `edges` table that maps each stage to another stage name, `"stop"`, or a predicate function.

## Table of Contents

- [defineWorkflow](#defineworkflow)
- [Stage factories](#stage-factories)
  - [produces](#produces)
  - [acts](#acts)
  - [terminal](#terminal)
  - [Script stages](#script-stages)
- [Edge targets](#edge-targets)
- [Conditional routing](#conditional-routing)
  - [gate](#gate)
  - [defineRoute](#defineroute)
  - [Predicate helpers](#predicate-helpers)
- [Outcomes](#outcomes)
  - [Collector catalog](#collector-catalog)
  - [Parser catalog](#parser-catalog)
  - [Custom outcomes](#custom-outcomes)
- [Analyzing skills before wiring](#analyzing-skills-before-wiring)
- [Multi-input stages](#multi-input-stages)
- [Carrying knowledge across stages](#carrying-knowledge-across-stages)
- [Validators](#validators)
- [Complete example](#complete-example)
- [Validation rules](#validation-rules)

## defineWorkflow

Identity passthrough for type inference. Same idiom as `defineConfig` in Vite/Astro — zero runtime cost.

```typescript
import { defineWorkflow } from "@juicesharp/rpiv-workflow";

export default defineWorkflow({
  name: "my-workflow",       // What users type: /wf my-workflow
  description: "...",        // Optional: shown in /wf preview
  start: "research",         // Entry stage name
  stages: { /* ... */ },     // Stage record (key = stage name)
  edges: { /* ... */ },      // Edge table (key = stage name)
});
```

## Stage factories

Three factories for two stage kinds. Each factory returns a `StageDef` — pass overrides as needed.

### produces

`kind: "produces"`. The skill writes a file the next stage reads. Halts the chain if the path doesn't appear in the transcript. **Requires an `outcome`** — load-time validation rejects a `produces` stage without one.

```typescript
import { produces, typeboxSchema } from "@juicesharp/rpiv-workflow";
import { Type } from "@sinclair/typebox";

// Basic — just declare the outcome
produces({ outcome: myOutcome })

// With output schema (enables gate routing on output.data)
produces({
  outcome: myOutcome,
  outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Integer() })),
})

// With fanout (one Pi session per unit)
produces({
  outcome: myOutcome,
  fanout: myFanoutFn,
})

// With validation retry
produces({
  outcome: myOutcome,
  outputSchema: typeboxSchema(Type.Object({ planPath: Type.String() })),
  onInvalid: "retry",    // default; "halt" to fail fast
  maxRetries: 3,
})
```

**Stage options:**

| Option | Default | Description |
|--------|---------|-------------|
| `skill` | record key | Pi skill to invoke. Override when stage id ≠ skill name. |
| `outcome` | (required) | `OutputSpec` — how the runtime collects + parses the artifact. |
| `outputSchema` | none | Standard Schema v1 validator for `output.data`. Enables gate routing. |
| `inputSchema` | none | Standard Schema v1 validator for inherited upstream `output.data`. Rejection halts immediately. |
| `reads` | none | `ReadonlyArray<string>` — names this stage consumes from `state.named`. Switches the prompt to the labelled-flag form. See [Multi-input stages](#multi-input-stages). |
| `onInvalid` | `"retry"` | `"retry"` (re-invoke up to `maxRetries`) or `"halt"` (fail fast). |
| `maxRetries` | — | Max retries on schema rejection. |
| `validateTimeoutMs` | — | Timeout for async schemas. |
| `fanout` | none | `FanoutFn` — decomposes work into N units, one Pi session per unit. |
| `sessionPolicy` | `"fresh"` | `"fresh"` (new session) or `"continue"` (reuse prior session). |

### acts

`kind: "side-effect"`. The skill's side effect IS the work (commit, implement). The next stage inherits the prior artifact list forward.

```typescript
import { acts } from "@juicesharp/rpiv-workflow";

// Basic side-effect
acts()

// With a different skill name
acts({ skill: "implement" })

// With fanout
acts({ fanout: phaseFanout })

// With outcome (e.g., git commit detection)
acts({ outcome: gitCommitOutcome })
```

**Stage options:** Same as `produces` except `outcome` is optional and `kind` is `"side-effect"`.

### terminal

`kind: "side-effect"` with `inheritsArtifacts: false`. A side-effect stage that does NOT inherit the upstream artifact. Its prompt receives `originalInput` (the run's brief) instead of an upstream artifact handle. The rolling primary slot is cleared on success so anything downstream also starts without an inherited handle.

```typescript
import { terminal } from "@juicesharp/rpiv-workflow";

// Final notification stage
terminal()
```

The right answer for a final cleanup / summary / post-run notification stage that shouldn't be coupled to the upstream chain.

### Script stages

Some stages don't need an LLM. The `.script` accessor on each factory runs a pure TS function in place of a Pi skill body. No `/skill:<name>` dispatch, no session.

**`produces.script`** — returns the `Output` envelope's value-channel fields directly:

```typescript
import { produces, fs, type ScriptContext } from "@juicesharp/rpiv-workflow";

const merge = produces.script({
  outputSchema: typeboxSchema(Type.Object({ planPath: Type.String() })),
  run: async (ctx: ScriptContext) => {
    const upstream = ctx.input?.artifacts ?? [];
    const bodies = await Promise.all(
      upstream
        .filter((a) => a.handle.kind === "fs")
        .map((a) => readFile(join(ctx.cwd, (a.handle as { path: string }).path), "utf-8")),
    );
    const planPath = `plans/${Date.now()}.md`;
    await writeFile(join(ctx.cwd, planPath), bodies.join("\n\n---\n\n"));
    return {
      kind: "plan",
      artifacts: [{ handle: fs(planPath), role: "primary" }],
      data: { planPath },
    };
  },
});
```

**`acts.script`** — returns `void`:

```typescript
import { acts, type ScriptContext } from "@juicesharp/rpiv-workflow";

const bumpVersion = acts.script({
  run: async (ctx: ScriptContext) => {
    const path = join(ctx.cwd, "package.json");
    const pkg = JSON.parse(await readFile(path, "utf-8")) as { version: string };
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    pkg.version = `${major}.${minor}.${(patch ?? 0) + 1}`;
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  },
});
```

**`terminal.script`** — like `acts.script` but clears the rolling primary slot:

```typescript
import { terminal, type ScriptContext } from "@juicesharp/rpiv-workflow";

const notifySlack = terminal.script({
  run: async (ctx: ScriptContext) => {
    await fetch(process.env.SLACK_WEBHOOK!, {
      method: "POST",
      body: JSON.stringify({ text: `Run ${ctx.state.originalInput} complete.` }),
    });
  },
});
```

**Constraints on script stages:**
- Cannot declare `skill`, `outcome`, `fanout`, or `sessionPolicy: "continue"` — load-time validation rejects the combination.
- `produces.script` may declare `outputSchema`, `maxRetries`, `onInvalid`.
- `acts.script` / `terminal.script` may declare `inputSchema`.

## Edge targets

Each edge maps a stage name to one of:

```typescript
// 1. Another stage name
edges: { research: "implement" }

// 2. The terminal sentinel
edges: { commit: "stop" }

// 3. A predicate function (via gate or defineRoute)
edges: { "code-review": gate("blockers_count", { revise: gt(0), commit: eq(0) }) }
```

**`STOP`** (or `"stop"`) is the terminal edge sentinel. Every workflow path should eventually reach `"stop"`.

## Conditional routing

### gate

Conditional routing keyed on a numeric field in `output.data`. Branches evaluated against `Number(output.data[field])` in declaration order; first matching predicate wins. Last declared branch is the fallback when no predicate matches.

```typescript
import { gate, gt, eq } from "@juicesharp/rpiv-workflow";

edges: {
  "code-review": gate("blockers_count", {
    revise: gt(0),   // value > 0 → "revise"
    commit: eq(0),    // value = 0 → "commit"
  })
}
// value < 0  → "commit" (no match, falls to last)
// missing/NaN → "commit" (no match, falls to last)
```

### defineRoute

Hand-rolled multi-branch routing. Returns an `EdgeFn` with `.targets` metadata for graph introspection. Auto-marks the route as reading `output.data` — pass `{ readsData: false }` for state-only routes.

```typescript
import { defineRoute } from "@juicesharp/rpiv-workflow";

edges: {
  "decide": defineRoute(
    ["fast-path", "slow-path"],           // All possible returns (required)
    ({ output }) => {
      const data = output?.data as { complexity: string };
      return data?.complexity === "high" ? "slow-path" : "fast-path";
    },
  )
}
```

### Predicate helpers

| Helper | Returns true when |
|--------|-------------------|
| `gt(n)` | value > n |
| `gte(n)` | value >= n |
| `lt(n)` | value < n |
| `lte(n)` | value <= n |
| `eq(n)` | value === n |

## Outcomes

Each `produces` stage wires an `OutputSpec` with an optional `name` (the publish key in `state.named` — see [Multi-input stages](#multi-input-stages)), a collector (enumerate what the stage produced) and optional parser (interpret into typed data):

```typescript
interface OutputSpec<Snapshot, Kind, Data> {
  name?:     string;                                // CATEGORISE — publish slot in state.named
  collector: ArtifactCollector<Snapshot>;          // ENUMERATE
  parser?:   ArtifactParser<Snapshot, Kind, Data>; // INTERPRET (optional)
}
```

There is no framework default — load-time validation rejects a `produces` stage without an outcome.

### Collector catalog

Grouped by discovery model:

**Scan the agent's text:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `transcriptPathCollector` | `({ pattern: RegExp })` | Scans assistant text for the last regex match; emits one `fs` artifact. |
| `directoryPathCollector` | `({ dir, ext? })` | Wrapper over `transcriptPathCollector` for `<dir>/<file>.<ext>`. |
| `urlCollector` | `({ pattern? })` | Scans for `https?://…`; emits a `url` handle. |

**Observe tool use:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `toolCallCollector` | `({ match, toArtifact })` | Walks every `tool_use` part; emits N artifacts via author's mappers. |

**Diff the filesystem:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `workspaceDiffCollector` | `({ filter? })` | `git status --porcelain` pre-stage, diffs post-stage. One `fs` artifact per touched file. |

**Git:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `gitCommitCollector` | — | Detects new HEAD commit vs. pre-stage snapshot; emits `opaque(sha)`. |

**Composition + empty:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `unionCollectors(...cs)` | — | Run N collectors, concatenate artifacts. Fatal only when every sub-collector fataled. |
| `noopCollector` | — | Always returns `{ kind: "ok", artifacts: [] }`. |

### Parser catalog

| Parser | Output `kind` | Output `data` |
|--------|---------------|---------------|
| `jsonBodyParser` | `"json"` | `JSON.parse` of the primary `fs` artifact's body. |
| `gitCommitParser` | `"git-commit"` | `GitCommitData` (sha, prevSha, subject, filesChanged). |

### Custom outcomes

Use `defineCollector` and `defineParser` to build your own:

```typescript
import { defineCollector, opaque } from "@juicesharp/rpiv-workflow";

export const myCollector = defineCollector((ctx) => {
  // ctx.branch, ctx.cwd, etc.
  const id = parseIdFromBranch(ctx.branch);
  if (!id) return { kind: "fatal", message: "stage did not emit an id" };
  return { kind: "ok", artifacts: [{ handle: opaque(id), role: "primary" }] };
});
```

Handle constructors: `fs(path)`, `url(href)`, `opaque(id)`, `inline(bytes, mime?)`.

Composite outcomes: `sideEffectOutcome` (built from `noopCollector`), `gitCommitOutcome` (built from `gitCommitCollector` + `gitCommitParser`).

## Analyzing skills before wiring

Before writing any workflow DSL, analyze each skill you plan to chain. The runner only sees what collectors enumerate — everything else (transcript reasoning, session state) is lost across `fresh` session boundaries. Bad collector/parser/session choices are silent: the workflow runs but downstream stages receive nothing useful.

### The four questions per skill

Answer these before writing DSL for any stage:

**Q1 — Input contract.** What does this skill require to start?
- Free-text prompt only (the run's original input or a composed prompt)?
- A specific file path it reads explicitly?
- A typed upstream artifact (structured data the prior stage produced)?

This determines what the stage's prompt should provide and whether to wire `inputSchema` on the downstream stage to validate the handoff.

**Q2 — Output locus.** Where does the knowledge live when the skill finishes?
- Files on disk at a predictable path
- Files on disk at an unpredictable path announced in the transcript
- Every file the skill touched (diffable via git)
- Files written via specific tool calls
- Narrative text only in the transcript (rationale, decisions, analysis)
- A URL emitted in the transcript
- A new git commit
- Multiple of the above simultaneously
- Session memory only (nothing observable after the stage ends)
- Nothing (pure side effect, nothing to extract)

This determines which collector to wire (or whether to author a custom one).

**Q3 — Downstream need.** What does the next stage actually consume from this one?
- File paths only (the downstream reads the files itself)
- Structured fields for routing (numeric counts, categories, pass/fail)
- Narrative rationale (why decisions were made)
- The full conversation (questions asked, context built)
- Nothing (the downstream is independent)

This determines session policy and whether you need a parser + `outputSchema`.

**Q4 — Session requirement.** Can downstream start fresh, or does it need the prior conversation?
- Fresh is fine when all knowledge is captured in files or transcript markers.
- Continue is needed when reasoning isn't recoverable from disk + transcript alone.

This determines `sessionPolicy`.

### Translation table: output locus → collector

| Knowledge lives in… | Stage kind | Collector | When downstream routes, add parser… |
|---|---|---|---|
| Files at a predictable path (directory + extension) | `produces` | `directoryPathCollector` | `jsonBodyParser` if body is JSON; custom otherwise |
| Files at a path announced in transcript | `produces` | `transcriptPathCollector` with a path-matching regex | Custom, keyed to the extracted path |
| Every file the stage touched (deliverable IS files) | `produces` or `acts` with outcome | `workspaceDiffCollector` | Custom, over the diff artifact list |
| Files written via specific tool calls | `produces` or `acts` with outcome | `toolCallCollector` | Custom, over the tool-call artifact list |
| Narrative section in transcript | `produces` | `transcriptPathCollector` with a section-scoped regex | Custom, parsing the materialized text |
| A URL in transcript | `produces` | `urlCollector` | — |
| A new git commit | `acts` with outcome | `gitCommitCollector` (or composite `gitCommitOutcome`) | `gitCommitParser` (included in `gitCommitOutcome`) |
| Multiple of the above | `produces` or `acts` | `unionCollectors(collA, collB, ...)` | Per sub-outcome, composed |
| None of the built-ins fit efficiently | `produces` or `acts` | Custom `defineCollector` | Custom `defineParser` as needed |
| Pure side effect, nothing to extract | `acts()` without outcome | — (no outcome needed) | — |
| Nothing, and downstream must not inherit | `terminal()` | — | — |
| Session memory only | Upstream `acts`, downstream `sessionPolicy: "continue"` | — (no outcome on upstream) | — |

**When to author a custom collector.** The built-in collectors cover transcript scanning, tool-call observation, filesystem diffing, and git state. If the skill's output pattern doesn't map cleanly to any of these — for example, it writes a structured artifact with frontmatter you want to parse, or it produces an identifier embedded in a branch name — author a custom collector via `defineCollector` and an optional `defineParser`. Custom collectors are first-class; they receive the same `CollectCtx` and emit the same artifact shapes as built-ins.

### Validation decision rules

When to add schemas:

- **Add `outputSchema`** whenever a downstream edge uses `gate` or a `defineRoute` that reads `output.data`. The load-time validator enforces this — but fix it at authoring time, not after.
- **Add `outputSchema`** when you want the runner to retry the stage on shape drift (`onInvalid: "retry"`, the default). This is useful when the skill's output is non-deterministic and might need a second attempt.
- **Add `inputSchema`** when the downstream stage genuinely cannot proceed without specific upstream fields. A rejection on `inputSchema` halts immediately (no retry) — use it as a hard contract, not a soft warning.
- **Default to sync** schemas for pure shape contracts. **Reach for async** only when correctness needs I/O (file existence checks, endpoint validation).

### Session-policy decision rules

- **Default to `"fresh"`.** It is compatible with `fanout`, script stages, and keeps context bounded.
- **Use `"continue"` only when Q3 demands reasoning that isn't capturable on disk or via a transcript marker.** `"continue"` is incompatible with `fanout` and script stages — load-time validation rejects the combination.
- Every `"continue"` stage grows context monotonically. Long chains of continued sessions become expensive and fragile.

### Authoring protocol

Follow this sequence when composing a new workflow:

**1. List skills in execution order.** Write down each skill name and a one-line description. Don't write DSL yet.

**2. Answer Q1–Q4 for every skill.** Record in a table:

| Skill | Input (Q1) | Output locus (Q2) | Downstream need (Q3) | Fresh? (Q4) |
|-------|-----------|-------------------|---------------------|------------|
| ... | ... | ... | ... | ... |

**3. Assign stage kind per skill.** Based on Q2: `produces` when the skill's primary output is a file the next stage reads; `acts` when the side effect IS the work; `terminal` when nothing should carry forward.

**4. Pick collector + optional parser.** Use the translation table above. If no built-in fits cleanly, reach for `defineCollector`.

**5. Add `outputSchema` where needed.** Required for `gate`/`defineRoute` routing; recommended when the collector/parser pair produces structured data you want to validate.

**6. Set `sessionPolicy`.** Default `"fresh"`. Document the justification for any `"continue"`.

**7. Draw edges.** Linear chains → string targets. Branching logic → `gate` (numeric field) or `defineRoute` (arbitrary). Every path must eventually reach `"stop"`.

**8. Validate.** Run `validateWorkflow()` before shipping — it catches missing outcomes, dangling edges, and schema/routing mismatches.

### Common pitfalls

| Smell | Fix |
|-------|-----|
| `acts()` with no outcome, but the skill clearly writes files | The side effect IS the artifact. Add `outcome: workspaceDiffCollector(...)` or switch to `produces`. |
| `produces` with `noopCollector` | `produces` exists to extract something. If there's nothing to extract, use `acts`. |
| `sessionPolicy: "continue"` on every stage | Revisit Q3 for each stage. Context grows monotonically with continued sessions; default to fresh. |
| `transcriptPathCollector` regex never tested against real output | Test the regex against a sample transcript before wiring it. A non-matching regex produces a fatal collector result silently. |
| `gate` without `outputSchema` on the source stage | Caught by the validator, but cheaper to fix at authoring time. |
| `terminal()` chosen because "it's the last stage" | `terminal` clears the rolling primary slot. If post-run inspection needs the artifact, use `acts` instead. |
| Custom collector that doesn't handle the "nothing found" case | Return `{ kind: "fatal", message: "..." }` — the runner halts and surfaces the message. Don't silently return an empty artifact list from a `produces` stage. |
| `reads:` references a name no `produces` stage publishes | Load-time validator catches the typo. Confirm the upstream stage's `outcome.name ?? <record-key>` matches the name you're reading. |
| Two stages publishing under different names when you wanted them to converge | Give both stages the same `OutputSpec.name` (typically via a shared outcome). The named-publish registry collapses convergent producers into one slot — there is no per-stage `publishes:` override knob. |

## Multi-input stages

The default prompt to a stage is `/skill:<name> <handle>` — exactly one positional arg, the upstream rolling primary artifact. When a stage needs more than one upstream artifact (the canonical case: a "revise plan based on review" step that needs both the plan and the review), declare `reads:` against names in the named-publish registry:

```typescript
revise: produces({
  outcome: planOutcome,
  reads: ["plans", "reviews"],
})
```

When `reads:` is set the runner replaces the default prompt with a labelled-flag form:

```
/skill:revise --plans .rpiv/artifacts/plans/p.md --reviews .rpiv/artifacts/reviews/r.md
```

Multi-artifact stages get flag repetition: an upstream with two `fs` artifacts expands to `--plans <a> --plans <b>` so skill arg-parsers collect repeated flags into arrays the same way `argparse`/`clap`/shell utilities do.

### The named-publish registry — `state.named`

Every `produces` stage APPENDS its full `Output` envelope onto `state.named[key]` after each successful run. The key is computed once at write time:

```
key = stage.outcome?.name ?? stage.<record-key>
```

Two layers, no override knob:

- **Outcome carries a name.** Multiple stages wiring the same outcome converge — both stages append onto the same slot, latest-wins on read. This is how a workflow expresses "two stages both produce the canonical plan" without restating the name on each stage.
- **Outcome has no name.** Stages publish under their record key. Downstream `reads: ["blueprint", "code-review"]` references stage record keys directly.

Slots are **arrays** — iteration history is preserved across backward-jump loops; the default read resolves to `array.at(-1)`. Side-effect stages don't write to the registry. The slot is never cleared by `terminal()` either: it's an additive channel orthogonal to the rolling primary.

### Validation + preflight

- **Load-time** (`validateWorkflow`) — every `reads:` reference must match some `produces` stage's publish key. Catches typos and rename drift before the workflow runs.
- **Runtime** (`ensureNamedReads` preflight) — halts the chain when a `reads:` name's slot is empty (the producer hasn't fired yet on this path). Distinct from the typo case: the workflow is well-formed but the stage was placed before its producer in the edge graph.

### Interaction with the rolling primary

A stage with `reads:` opts out of the rolling-primary contract entirely — `ensureUpstreamArtifact` is skipped, the labelled-flag prompt replaces the single-handle prompt, and `state.primaryArtifact` is ignored for prompt construction. The stage's own produces output (if any) still updates `state.primaryArtifact` for downstream stages that DO use the rolling chain.

## Carrying knowledge across stages

A fresh-session stage starts a clean Pi conversation. It only sees (1) the rolling primary artifact, (2) the inherited artifact list, (3) `output.data` when an `outputSchema` is declared, and (4) any named slots wired via `reads:`. Anything the upstream stage only *spoke* in its transcript is lost. Author the handoff deliberately — five paths:

| # | Mechanism | What downstream sees | Trade-off |
|---|-----------|----------------------|-----------|
| 1 | `sessionPolicy: "continue"` on the downstream stage | Full prior Pi conversation (messages + tool calls) | Incompatible with `fanout` and script stages. Context grows monotonically. |
| 2 | `workspaceDiffCollector` outcome on the upstream stage | Every file the stage touched, as `fs` artifacts | Free when the work IS files on disk. Captures *what*, not *why*. |
| 3 | `transcriptPathCollector` outcome on the upstream stage | The last regex-matched chunk of assistant text, written to disk | Captures narrative knowledge. Needs the skill to emit a recognizable marker. |
| 4 | Custom collector / parser (+ optional `outputSchema`) | Author-defined typed shape | Most precise; most authoring effort. Enables gate routing. |
| 5 | `reads:` on the downstream stage referencing named-publish slots | Latest `Output` per declared name, woven into a labelled-flag prompt | Reaches further back than the rolling primary; survives intermediate produces stages overwriting the chain. See [Multi-input stages](#multi-input-stages). |

**Picking between them — where does the knowledge live after the stage finishes?**

- **On disk (the stage's deliverable IS files)** → path 2. Frame the stage as `produces({ outcome: workspaceDiffCollector(...) })` or `acts({ outcome: workspaceDiffCollector(...) })`. "Side-effect with no outcome" is a smell here — the side effect IS the artifact.
- **Only in the assistant's words (rationale, decisions)** → path 3 to materialize it, or path 1 to keep the conversation alive.
- **Both, and the downstream stage needs the full conversation, not just files** → path 1 is the only honest answer. Fresh + a diff collector gives the next stage filenames but no reasoning.

**Combining mechanisms.** `unionCollectors` lets path 2 and path 3 coexist:

```typescript
import {
  acts, unionCollectors,
  workspaceDiffCollector, transcriptPathCollector,
} from "@juicesharp/rpiv-workflow";

acts({
  skill: "frontend-design",
  outcome: unionCollectors(
    workspaceDiffCollector({ filter: (p) => /\.(tsx?|css|md)$/.test(p) }),
    transcriptPathCollector({ pattern: /## Design Notes\n([\s\S]+?)(?=\n##|$)/ }),
  ),
})
```

The fresh downstream session now receives the touched files *and* a notes file capturing the rationale.

**What `acts` without an outcome actually does.** The rolling primary slot from the last upstream `produces` is passed through unchanged — downstream still receives that prior artifact, it just learns nothing about what this stage did. If no `produces` stage has run yet upstream, `ensureUpstreamArtifact` halts the next non-terminal stage with `MSG_MISSING_ARTIFACT`. Use `terminal()` for stages that should explicitly carry nothing forward.

## Validators

`inputSchema` and `outputSchema` are Standard Schema v1 values (Zod, Valibot, ArkType, TypeBox via `typeboxSchema`). The runner awaits `~standard.validate` at both seams.

**Default to sync** for pure shape contracts. **Reach for async** when correctness needs I/O (file existence checks, endpoint validation).

```typescript
import { typeboxSchema } from "@juicesharp/rpiv-workflow";
import { Type } from "@sinclair/typebox";

outputSchema: typeboxSchema(Type.Object({
  blockers_count: Type.Integer({ minimum: 0 }),
}))
```

A schema rejection on `outputSchema` honours `onInvalid` (`"retry"` by default, `"halt"` to fail fast). A rejection on `inputSchema` halts immediately (no retry — the upstream stage is already frozen).

## Complete example

A full workflow with custom outcomes and conditional routing. This example uses only `@juicesharp/rpiv-workflow` primitives — no external convention packages:

```typescript
import {
  defineWorkflow, produces, acts, gate, gt, eq,
  typeboxSchema, gitCommitOutcome,
  directoryPathCollector, jsonBodyParser, transcriptPathCollector,
  toolCallCollector, fs,
} from "@juicesharp/rpiv-workflow";
import { Type } from "@sinclair/typebox";

// Custom outcome: detect a markdown file the agent writes to a plans directory
const planOutcome = {
  collector: directoryPathCollector({ dir: "plans", ext: "md" }),
  parser: jsonBodyParser,
};

// Custom outcome: detect files the agent writes or edits via tool calls
const writeFileOutcome = {
  collector: toolCallCollector({
    match: (tc) => tc.name === "write" || tc.name === "edit",
    toArtifact: (tc) => ({ handle: fs(String(tc.input.path ?? tc.input.target_file ?? "")) }),
  }),
};

const REVIEW_SCHEMA = typeboxSchema(
  Type.Object({ blockers_count: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
);

export default defineWorkflow({
  name: "mid",
  start: "research",
  stages: {
    research:      produces({ outcome: planOutcome }),
    blueprint:     produces({ outcome: planOutcome }),
    implement:     acts(),
    validate:      produces({ outcome: writeFileOutcome }),
    "code-review": produces({
      outcome: writeFileOutcome,
      outputSchema: REVIEW_SCHEMA,
    }),
    revise:        produces({ outcome: writeFileOutcome }),
    "implement-after-revise": acts({ skill: "implement" }),
    commit:        acts({ outcome: gitCommitOutcome }),
  },
  edges: {
    research: "blueprint",
    blueprint: "implement",
    implement: "validate",
    validate: "code-review",
    "code-review": gate("blockers_count", {
      revise: gt(0),
      commit: eq(0),
    }),
    revise: "implement-after-revise",
    "implement-after-revise": "commit",
    commit: "stop",
  },
});
```

## Validation rules

Generated workflows must pass `validateWorkflow()` before writing. The validator checks:

- `start` references a declared stage
- Every edge key exists in `stages`
- Every edge target exists in `stages` or is `"stop"`
- Stage kinds are valid (`"produces"` or `"side-effect"`)
- `produces` stages have an `outcome`
- `gate` / data-reading `defineRoute` source stages have `outputSchema`
- Every `reads:` name is published by some `produces` stage in the workflow (publish key = `outcome.name ?? stage.<record-key>`)
- Fanout is incompatible with `sessionPolicy: "continue"`
- Script stages cannot declare `skill`, `outcome`, `fanout`, or `sessionPolicy: "continue"`

> **Important:** The `/wf` command blocks execution on any `severity: "error"` issue. Always validate before writing.
