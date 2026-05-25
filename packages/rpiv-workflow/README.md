# @juicesharp/rpiv-workflow

Pi extension. Chain Pi skills into typed multi-stage workflows with audited JSONL state, predicate routing, and per-stage manifest validation.

**Skill-agnostic.** The runner sends `/skill:<name>` via Pi's native dispatch — it doesn't know or care who shipped the skill. Install on its own and write workflows over your own `~/.pi/agent/skills/`, or pair with [`@juicesharp/rpiv-pi`](../rpiv-pi) to use rpiv-pi's bundled `mid`, `large`, `small` workflows over rpiv-pi's bundled skills.

## Install

```sh
pi install @juicesharp/rpiv-workflow
```

## Use

```
/wf                        # preview every loaded workflow
/wf <name>                 # preview one workflow's stage graph
/wf <name> <input>         # run a workflow with <input> piped to the start node
```

## Configure

The loader merges workflows from three layers (each later layer overrides earlier by workflow name):

```
built-in (programmatic — registered by sibling packages like rpiv-pi)
  ← user drop-ins      (~/.config/rpiv-workflow/workflows/*.ts, alpha-sorted)
  ← user canonical     (~/.config/rpiv-workflow/workflows.config.ts)
  ← project drop-ins   (<cwd>/.rpiv-workflow/workflows/*.ts, alpha-sorted)
  ← project canonical  (<cwd>/.rpiv-workflow/workflows.config.ts)
```

**Canonical files** accept three default-export shapes:

```ts
// 1. A single Workflow
import { defineWorkflow, artifact, action } from "@juicesharp/rpiv-workflow";
export default defineWorkflow({
  name: "ship",
  start: "implement",
  nodes: { implement: action(), commit: action() },
  edges: { implement: "commit", commit: "stop" },
});

// 2. A Workflow[] with a single entry
export default [ /* one workflow */ ];

// 3. The envelope form — required when shipping multiple workflows
export default {
  workflows: [ /* many */ ],
  default: "ship",   // which one `/wf <input>` runs without a name
};
```

**Drop-in files** accept only `Workflow | Workflow[]`. They cannot set `default` — that lives in the canonical file (one source of truth per layer). This makes installable workflow packs safe: a pack can contribute new workflows without overriding the user's default.

## Programmatic registration

Sibling packages contribute workflows at extension load:

```ts
import { registerBuiltIns, type WorkflowHost } from "@juicesharp/rpiv-workflow";
import { myWorkflows } from "./my-workflows.js";

export default function (pi: WorkflowHost): void {
  registerBuiltIns(myWorkflows);
}
```

You can keep using `ExtensionAPI` from `@earendil-works/pi-coding-agent` in the
signature instead — it structurally satisfies `WorkflowHost`. Either choice
works; the published types name only the workflow-owned port.

These workflows are merged into the lowest layer (`built-in`); user/project overlays still override by name.

## Host boundary

`rpiv-workflow`'s public type surface names **zero** `@earendil-works/pi-coding-agent`
types. The runtime declares three workflow-owned port interfaces in
`./host.js`:

- `WorkflowHost` — registry-level host (default export, continue-policy
  sends, skill-registration preflight).
- `WorkflowCommandHost` — per-command ctx for `runWorkflow`.
- `WorkflowSessionHost` — the replacement ctx delivered to
  `newSession`'s `withSession` callback.

Pi's `ExtensionAPI` / `ExtensionCommandContext` structurally satisfy these
ports, so existing embedders pass their Pi handles through unchanged. A
compile-time tripwire (`host.test.ts`) fails immediately if Pi's API ever
drifts below the port shape. A future non-Pi host implements the three
port interfaces and drives the runtime without any pi-coding-agent
dependency.

## Outcomes — resolvers and readers

Each `artifact-emit` node wires an `Outcome` that tells the runtime two things:

```ts
interface Outcome<Baseline, Kind, Data> {
  resolver: ArtifactResolver<Baseline>;     // ENUMERATE — what did the stage produce?
  reader?:  ArtifactReader<Baseline, Kind, Data>; // INTERPRET — what's the typed data channel?
}
```

`resolver.resolve(ctx)` returns the artifacts the stage emitted. `reader.read(ctx)` (optional) turns them into the typed `manifest.data` downstream stages narrow on. With no reader, `manifest.data` is the artifact list itself (`kind = "artifacts"`).

There is no framework default for `artifact-emit` — load-time validation rejects a node without an outcome. The `.rpiv/artifacts/<bucket>/<file>.md` layout is an rpiv convention, not a framework truth; pair with [`@juicesharp/rpiv-pi`](../rpiv-pi) for `rpivArtifactMdOutcome`, or wire your own.

### Authoring a resolver

The resolver is the user-supplyable primitive — one method, one return type:

```ts
import { defineResolver, opaque, type Artifact } from "@juicesharp/rpiv-workflow";

export const linearTicketResolver = defineResolver((ctx) => {
  const id = parseLinearIdFromBranch(ctx.branch);
  if (!id) return { kind: "fatal", message: "stage did not emit a Linear ticket id" };
  return { kind: "ok", artifacts: [{ handle: opaque(id), role: "ticket" }] };
});
```

Resolvers that need a pre-stage snapshot declare a `baseline` hook — its return value lands on `ctx.baseline` for the matching `resolve` call. Compose the bundled `gitHeadSnapshot` into any baseline:

```ts
import { defineResolver, fs, gitHeadSnapshot, type GitHeadSnapshot } from "@juicesharp/rpiv-workflow";

const codegenResolver = defineResolver<GitHeadSnapshot | undefined>({
  baseline: gitHeadSnapshot,
  resolve: async (ctx) => {
    if (!ctx.baseline) return { kind: "ok", artifacts: [] };
    const files = await diffWorkspace(ctx.cwd, ctx.baseline.baselineSha);
    return { kind: "ok", artifacts: files.map((p) => ({ handle: fs(p), role: "generated" })) };
  },
});
```

### Bundled resolver catalog

The framework ships only host-agnostic primitives — no Pi tool-name defaults, no `.rpiv/artifacts/` defaults, no domain helpers. Wrap them or compose with `unionResolvers` to build your own conventions.

| Resolver | Signature | What it does |
| --- | --- | --- |
| `transcriptPathResolver` | `({ pattern: RegExp })` | Scans assistant text for the last regex match; emits one `fs` artifact. Pattern is required — no framework default. |
| `toolCallResolver` | `({ match, toHandle })` | Walks every `tool_use` part; emits N artifacts via the author's mappers. Universal across any Pi tool name. |
| `workspaceDiffResolver` | `({ filter? })` | Captures `git status --porcelain` pre-stage, diffs post-stage. One `fs` artifact per file the stage touched. Fail-soft when not a git repo. |
| `gitCommitResolver` | — | Detects a new HEAD commit vs. the pre-stage snapshot; emits an `opaque(sha)` artifact tagged `role: "commit"`. |
| `directoryPathResolver` | `({ dir, ext? })` | Ergonomic wrapper over `transcriptPathResolver` for the `<dir>/<file>.<ext>` shape. |
| `urlResolver` | `({ pattern? })` | Scans for `https?://…`; emits a `url` handle. Default pattern is RFC-3986-flavoured; override for narrower hosts. |
| `unionResolvers(...rs)` | — | Composition: run N resolvers, concatenate artifacts. Fatal only when every sub-resolver fataled. |
| `noopResolver` | — | Always returns `{ kind: "ok", artifacts: [] }`. The primitive `sideEffectOutcome` is built from it. |

Handle constructors:`fs(path)`, `url(href)`, `opaque(id)`, `inline(bytes, mime?)` — replace the verbose `{ kind: …, … }` literal at call sites. Serialise any handle to its canonical string with `handleToString`.

### Bundled reader catalog

| Reader | Output `kind` | Output `data` |
| --- | --- | --- |
| `jsonBodyReader` | `"json"` | `JSON.parse` of the primary `fs` artifact's body (`unknown` — narrow via `outputSchema`). |
| `gitCommitReader` | `"git-commit"` | `GitCommitData` (sha, prevSha, subject, filesChanged) parsed from `git`. |

Format-specific readers (markdown frontmatter, YAML, TOML, …) live in the convention layer that owns them — rpiv-pi ships its own `frontmatterReader`.

### Wiring an outcome onto a node

```ts
import {
  artifact, defineWorkflow,
  toolCallResolver, jsonBodyReader, fs,
} from "@juicesharp/rpiv-workflow";

const writeFileResolver = toolCallResolver({
  match: (tc) => tc.name === "write_file" || tc.name === "edit",
  toHandle: (tc) => ({ handle: fs(String(tc.input.path ?? tc.input.target_file)) }),
});

export default defineWorkflow({
  name: "scaffold",
  start: "generate",
  nodes: {
    generate: artifact({
      outcome: { resolver: writeFileResolver, reader: jsonBodyReader },
    }),
  },
  edges: { generate: "stop" },
});
```

## Validators: sync vs async

`inputSchema` and `outputSchema` are [Standard Schema v1](https://standardschema.dev) values — Zod, Valibot, ArkType, TypeBox (via `typeboxSchema`), or hand-rolled `{ "~standard": { validate } }` objects. The runner awaits the schema's `~standard.validate` at both seams, so it works with sync and async schemas alike.

**Default to sync.** Pure shape contracts (`Type.Object({ … })`, `z.object({ … })`) resolve in one microtask, give the agent precise retry diagnostics, and have no failure mode beyond "this isn't the shape you said." For 95% of nodes this is the right answer.

**Reach for async when correctness needs I/O.** Examples that don't fit the sync model:
- "the path in the manifest must actually exist on disk" — `fs.access` is async.
- "the spec the agent emitted must validate against a live endpoint" — `fetch` is async.
- you're already on an async-by-default schema lib (ArkType's deeply-async paths).

The contract is identical — author an async `~standard.validate` and the runner awaits it. A schema whose Promise never settles is bounded by the node's `validationRetryTimeoutMs` (default 5 min); a rejected Promise surfaces as a clean stage halt, attributed to the node, with the same error class as a shape-failure halt. No opt-in flag, no parallel code path.

> Keep validation separate from the resolver + reader. The resolver's job is "what did the agent produce?" (enumerate); the reader's job is "parse it into typed data" (shape). The validator's job is "is the result correct?" (check + verify). With async validators available you don't have to push I/O verification into a custom resolver/reader — keep them pure and put correctness checks on `outputSchema`.

## Architecture

See [`.rpiv/guidance/packages/rpiv-workflow/architecture.md`](../../.rpiv/guidance/packages/rpiv-workflow/architecture.md).
