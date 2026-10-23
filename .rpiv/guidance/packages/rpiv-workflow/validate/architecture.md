# validate/

## Responsibility
Static validation of `defineWorkflow` graphs before any run. Topology (graph.ts), per-stage-kind semantics (stage-rules.ts), and skill-contract / JSON-Schema compatibility (contract-compat.ts) all emit one uniform `WorkflowValidationIssue` stream defined by the issue model (issue.ts). `validate-workflow.ts` (package root) is the thin orchestrator. Runtime CLI caps (`--max-jumps`/`--max-laps`) are NOT validated here — validate/ covers definition-field budgets only (`loop.max`, `concurrency`, `retryHaltedUnits`, `depArtifactFlag`).

## Dependencies
- **Inbound**: `../api` (Workflow, StageDef, EdgeTarget, STOP, LOOP_KINDS, STAGE_KINDS, SESSION_POLICIES, ON_INVALID_VALUES, marksReadsData), `../stage-def`, `../stage-identity` (isDispatchingStage, resolveSkill, publish-name resolvers), `../judge`, `../loop-constructors` (shape-issue sources, loopSpecOf, panelVerdictChannel), `../skill-contract` + `../skill-contracts` (adjudicateChannel, comparators), `../json-schema`, `../validation-bounds` (dependency-free leaf shared with the runtime retry loop). **`issue.ts` imports nothing** — pure leaf.
- **Consumed by**: `validate-workflow.ts` (the only orchestrator), `load/issues.ts` (type-only wrap adding layer/path attribution), `load/index.ts` (runs it per merged workflow), `registration.ts` (public re-export), tests at `validate-workflow.test.ts`.

## Module Structure
```
issue.ts           — Leaf: ISSUE_DEFS (severity + message template per rule), WorkflowValidationIssue,
                     ValidationIssueCode, issueReporter() — the ONE renderer
graph.ts           — Workflow-as-graph: name, start existence, edge keys/targets, implicit terminals,
                     BFS reachability; pure enumerateTargets walks string/EdgeFn edges
stage-rules.ts     — Stage semantics: bounds/enums jiti erases (maxRetries, validateTimeoutMs, onInvalid,
                     kind, sessionPolicy), loop/verify/prompt/script exclusion matrices, assess judge shape,
                     verdict-channel collisions, named-channel wiring; exports publishedNamesOf /
                     fanoutPublishedChannels (computed once, threaded)
contract-compat.ts — Skill-contract compatibility: checkPredicateSchemas (route-reads-unvalidated-data),
                     checkEdgeSchemaCompat, checkReadsChannelCompat. The only module importing the
                     skill-contract domain
```

## One Def-Table Row Per Rule
```ts
export const ISSUE_DEFS = {
  "start-stage-missing": def<{ start: string }>("error", (p) => `start stage "${p.start}" is not declared in stages`),
  "edge-missing":        def<{ stage: string }>("warning", (p) => `${p.stage} has no edge — treated as terminal`),
} satisfies Record<string, IssueSpec<never>>;
export type ValidationIssueCode = keyof typeof ISSUE_DEFS;
```
Severity is a property of the RULE, never the call site; the params shape is inferred so `report(code, params)` is compile-checked. Messages never embed the stage name — `stage` is a structural field and `command-run.ts` composes attribution.

## Reporter Binding (construction in one place)
```ts
const r = issueReporter(workflowName, sink);   // { report: ReportFn, forStage(s): ReportFn }
r.report("start-stage-missing", { start });    // workflow-level
const report = r.forStage(stageName);          // stage-bound — severity lookup + render only in issue.ts
```

## Orchestrator: Aggregate, Never Short-Circuit
`validateWorkflow` runs checks in fixed order, gates cascade-prone checks on CODE (`if (!issues.some(i => i.code === "edge-fn-no-targets")) checkReachability(...)`), computes the published-names set once, and returns the list — the CALLER decides fatality (loader wraps each as `{ kind: "validation", layer, path }`; the runner blocks on `severity === "error"`).

## Issue-Code Domains (stable contract)
`workflow-name-invalid` / `start-stage-missing` / `edge-{key,target}-unknown` / `edge-fn-no-targets` (topology; warns: `edge-missing`, `stage-unreachable`) · `*-out-of-range` / `*-unknown` bounds+enums (`max-retries`, `validate-timeout`, `on-invalid`, `stage-kind`, `session-policy`; `produces-without-outcome`; warns: `inherits-artifacts-on-produces`, `progress-not-function`) · `loop-*` (`kind`, `max`, `concurrency`, `dep-flag`, `retry-halted-units` invalid; `loop-requires-produces`, `loop-outcome-name-required`, `loop-continue-session`; warn `loop-source-unpublished`) · `assess-*` judge shape + channel collisions · `verify-*` shape/exclusion/outcome-name · `panel-{member,verdict}-channel-collision` · `prompt-*` / `script-*` exclusion matrices · `reads-unpublished` (warn `reads-latest-from-fanout`) · contract-compat (warns `route-reads-unvalidated-data`, `edge-schema-incompatible`, `reads-comparator-threw`; error `reads-channel-incompatible`)

## Architectural Boundaries
- **Never throws, never short-circuits** — pure walks; aggregate everything; the caller gates
- **Code, not message text** — codes/params are the stable contract for filtering, assertions, and cascade gating; prose lives only in `ISSUE_DEFS`
- **No I/O, no clocks** — load-time only; runtime enforcement is a separate layer (contract-compat.ts header: `reads` → load-time complete; `data`/`status` → runtime; `produces` → produce-time)
- **issue.ts stays a leaf** — bounds come from the dependency-free `validation-bounds.ts`, never runtime modules
- **Degrade, don't false-positive** — unsigned contracts, predicate edges, and STOP edges skip with warnings at most

<important if="you are adding a new validation rule">
1. Add one `ISSUE_DEFS` row: kebab-case code with a domain prefix (`loop-…`, `verify-…`), severity (`"error"` = runner-blocking), typed params, message template without the stage name
2. Pick the module by footprint: topology → `graph.ts`; stage-record semantics → `stage-rules.ts` (a `checkX(stage, report)` helper called from the stage loop); contracts/schemas → `contract-compat.ts`. Reuse `checkRange`/`checkEnum`/type-guard predicates and shared shape-issue sources to avoid wording drift
3. Wire into the orchestrator ONLY for workflow-level ordering or cascade gating; stage rules need no orchestrator edit
4. Cover in `validate-workflow.test.ts`: pin `code` + `params` via the `errors()`/`warnings()` helpers (never message text), plus a clean-fixture negative; simulate jiti-erased invalid literals with `as unknown as …` casts
5. Cascade skips gate on `issues.some(i => i.code === "…")` — never on message text
</important>
