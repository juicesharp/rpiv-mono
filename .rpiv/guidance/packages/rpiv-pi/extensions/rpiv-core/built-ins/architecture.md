# built-ins/

## Responsibility
Extracted leaf-cluster layer behind the four built-in `/wf` workflows (build / vet / polish / ship). The `workflows/` family (rpiv-core root: one module per workflow, cross-workflow factories in `workflows/shared.ts`, composed by the `built-in-workflows.ts` barrel) is the **DSL authoring layer** — the `defineWorkflow` graphs, stage tables, route edges (`gate()`/`match()`), and workflow-level prompts. `built-ins/` is the **compute layer**: pure gates, verdict collection, checks, and snapshot helpers the authoring layer composes via the `built-ins/index.ts` barrel. Rule: `built-in-workflows.ts` composes; `built-ins/` computes.

## Dependencies
- **`@juicesharp/rpiv-workflow`** — statically value-importing `/registration` (`fanout`, `handleToString`, `defineCollector`, `toolCallCollector`, `transcriptPathCollector`, `jsonBodyParser`, `acts`/`eq`/`gt`/`match`/`gate`, types `RunView`/`Output`/`ScriptContext`) and `/runner` (`StagePreflightError`). This is the sanctioned OFF-ENTRY-GRAPH peer import — these modules are reached only through `register-built-in-workflows.ts`'s guarded dynamic `/startup` import (lazy, built on first `/wf`; missing sibling ⇒ no-op). The entry graph itself has NO static peer edge (`sibling-import-graph.test.ts` enforces it)
- **`@earendil-works/pi-coding-agent`**: `parseFrontmatter` (plan-cite / slices / slice-checks)
- Internal: helpers import each other via relative `./x.js`; nothing here reaches back into lane/session modules

## Consumers
- `built-in-workflows.ts` + its test (the composition surface); `register-built-in-workflows.ts` (indirectly, via the lazy provider)
- `__fixtures__/` — golden data consumed by `built-in-workflows.test.ts` and `verdict-collector.test.ts` (`run-*.json` per-round blocking counts + halt rows for whole-lap replay; `design-readiness-corpus.json` grader corpus; a wire-transcript `.jsonl` exercising the collector's tool-args arm; `/repo` prefixes rewritten to a tmp cwd at load). Fixtures are DEV-ONLY — `rpiv-pi/package.json` `files` excludes `built-ins/__fixtures__/` from the tarball

## Module Structure
```
verdict-core.ts     — Gate layer 1: dimension rosters (SLICE/PLAN/SHIP/RISK_DIMENSIONS + GOAL_DIMENSIONS), channel
                      micro-readers (latestChannelData/channelNumber), latestArtifactPath, freshness folds
                      (freshVerdicts/latestVerdictPerDimension), the anchor-nit clamp, and VerdictRecord +
                      verdictBlocks (THE shared blocking predicate). Pure state folds — no fs, no LLM.
gate-rosters.ts     — Gate layer 2: adaptive gate scaling (gateTier/gateRoster, LIGHT_ROSTER floor) + dispatch
                      rosters (panelRoster/shipRoster) + the risk-duty cluster (verdictRiskRulings,
                      planAuthoredRisks, evidenceCitesFileLine, procedureSatisfiesDuty, rulingEffectivePass,
                      RiskRecord). GateTier/RiskRuling/tier constants stay private.
gate-passes.ts      — Gate layer 3: dimensionsToRegrade, allDimensionsPass, per-lane *GatePasses, confirmDue,
                      unitFailedDimensions, seed-lift classification (SeedOnlyVerdict/seedOnly*), and the
                      panelProgress/progressFromRoundCounts whole-lap progress hooks
gates.ts            — Conservation facade: pure named re-exports of the exact 36-symbol surface over the three
                      layers (zero logic, no `export *`); consumers keep importing `./gates.js`
verdict-collector.ts — Disk-first collector, three arms: (1) newest `<basename>__<dimension>__*.json` under
                      VERDICT_DIR written since snapshot; (2) transcript text; (3) toolCallCollector write-args
                      arm pinned by isWriteTool (write/edit only) so a prior round's read-back collects nothing.
                      ctx.unitLabel (the fanout dimension sentinel) tightens arm 1; absent ⇒ loose degrade.
verdict-outcome.ts  — verdictOutcome(name, sourceChannel) factory wiring verdictCollector + jsonBodyParser;
                      stateless per dispatch (grade + confirm twins share one instance per channel)
grade-panel.ts      — gradePanelFanout + lane fanout constants + shipVerdictOutcome; threads --context/--goal/--prior,
                      haltWhenAllFailed; fanout retryHaltedUnits: 1 on the grade loops
citations.ts        — verifyCitations: file:line citation verification against the working tree (basename-suffix
                      fallback + declared-files:/prose tiebreaks; arrow-pair revision notes skipped). ALL findings advisory.
priors.ts           — Pre-fix snapshots (planSnapshot/codeSnapshot), section diffs, surgical-fix guard,
                      risk-duty demotion stamps (planDemote/codeDemote)
remediation.ts      — remediationOutcome + gitTreeDigest (git subprocess, wall-clock ceiling)
scope-checks.ts     — implementScopeCheck(/Vet): declared write-set (full plans channel; vet's fix loop appends
                      distinct plans) vs git dirty set; tiered pass/untracked-only/excess; scopeQuarantine arm;
                      fail-closed — an unreadable plan never widens the declared set. Accepts validate-report-named
                      writes as declared scope.
slice-checks.ts     — sliceStructureCheck (brief conservation, citeDischarged stamp), subplanCoverageCheck,
                      sliceSeedLift (deterministic seed append)
shared.ts           — VERDICT_DIR, writeStructureVerdict (one shape for all deterministic checks; blocking⇒high,
                      all-advisory⇒low; idempotent basename-keyed overwrite), haltPreflight (StagePreflightError
                      re-export), MAX_PHASES, containedPath escape guard, TEST_PATH_RE
markdown-fence.ts   — FENCE_LINE_RE, fencedSpans, forEachLineOutsideFences, openFenceLine — mirrors the fence-aware
                      scan in skills/_shared/stitch-elaborations.mjs (shared predicate shape, deliberately NOT a shared import)
elaboration.ts      — elaborationOutcome: the elaborations bucket collector + a parser adding body-derived
                      fence_walk / phase_headings beside the frontmatter, which the elaborate contract's enums refuse
                      (in-session validation retry, then one retryHaltedUnits re-dispatch) before the stitch runs
design.ts           — designOutcome: the designs bucket collector + a parser adding path-derived filename_slice
                      (`matches` iff the basename's slice-<N> token equals frontmatter slice_n), which the design-slice
                      contract's enum refuses in-lane; slices.ts designSliceOf resolves identity slice_n-first, token second
plan-phases.ts      — phases: frontmatter parsing (planPhaseRecords, MAX_PHASES cap), phaseFiles, withTestTwins,
                      FRONTMATTER_PHASE_FANOUT / ELABORATE_PHASE_FANOUT / IMPLEMENT_DAG_FANOUT / REVIEW_PHASE_ITERATE
                      wiring tables
plan-cite.ts, slices.ts, goal-baseline.ts, reconcile.ts (+ reconcile-directives.mjs/.d.mts loader-free ESM twin)
                    — plan citation-check gate skill-input; slice-map fanout + synth clusters; goal capture
                      prompts + scopeExcess; post-implement reconcile with test-path-only write allowlist
index.ts            — Barrel only, no logic
__fixtures__/       — Golden fixture data (see Consumers)
```

## Quality-Lane Whole-Lap Hook (grade/confirm/snapshot share ONE instance — a lap is one unit)
```ts
// built-in-workflows.ts — per lane; factory in gates.ts
"plan-grade": produces({
    skill: "grade",
    loop: PLAN_DIMENSION_FANOUT,
    outcome: planVerdictOutcome,
    progress: PLAN_PANEL_PROGRESS,   // panelProgress("plan-verdicts", PLAN_DIMENSIONS, { snapshotChannel: "plan-snapshot" })
    reads: ["plans", "research", "goal", "acceptance"],
}),
// progressFromRoundCounts counts BLOCKERS per round, never scores — "improved" waives the jump cap, not the lap ceiling
```

## verdictOutcome Factory + Write-Pinned Match Predicate
```ts
export const verdictOutcome = (name: string, sourceChannel: string): Outcome<unknown, "json", unknown> => ({
    name,                                                    // default publish slot in state.named
    collector: verdictCollector({ dir: VERDICT_DIR, sourceChannel }),
    parser: jsonBodyParser,                                  // MUST stay jsonBodyParser
});
// verdict-collector.ts — the shared predicate pinning the tool-args fallback to write calls:
const isWriteTool = (tc: { name: string }): boolean => tc.name === "write" || tc.name === "edit";
```

## Shared Blocking Predicate + Adaptive Gate Roster
```ts
// verdict-core.ts — THE shared blocking predicate (deliberately risk-blind):
const verdictBlocks = (v: VerdictRecord | undefined): boolean =>
    !(v?.pass === true || v?.severity === "low" || v?.severity === "none" || anchorNitsOnly(v));
// gate-passes.ts — the live composition: cite floor AND panelRoster (tier + risk join) AND risk flags:
const codeGatePasses = (state: RunView): boolean => {
    const fresh = freshVerdicts(state.named["code-verdicts"], latestArtifactPath(state, "plans"));
    const roster = panelRoster(state, "plans", "code-verdicts", PLAN_DIMENSIONS);
    const risks = planAuthoredRisks(state, "plans");
    return (
        allDimensionsPass(state.named["code-cite-check"]) &&
        allDimensionsPass(fresh, roster) &&
        allRiskFlagsPass(fresh, risks)
    );
};
// Ship binds shipRoster(state) — SHIP_DIMENSIONS verbatim (+ risk unit), never gateTier-wrapped
```

## Architectural Boundaries
- **No static peer import from the entry graph** — only the guarded dynamic `/startup` chain reaches this folder; off-entry `built-ins/*` MAY statically import `/registration` + `/runner` (chicken-and-egg rationale in `register-built-in-workflows.ts` header)
- **Pi tool-name literals live HERE** (convention layer: `isWriteTool`, `.rpiv/` paths, verdict dirs) — never in rpiv-workflow's host-agnostic collectors
- **rpiv-workflow knows nothing about phases** — the `phases:` convention lives in `plan-phases.ts`
- **Fail-safe defaults everywhere** — missing verdict ⇒ blocking; missing tier signal ⇒ never light; malformed trail ⇒ toward counting; unreadable plan ⇒ never widens the declared set (`containedPath` runs on the same resolved string the fs sinks use)
- **Advisory vs blocking severity tiers are load-bearing** — citation findings are always advisory (`low` rides the gate floor); any blocking structural finding rates `high` or it ships
- **Invariant binding** — `skills/elaborate/_helpers/validate-workflow-invariant.mjs` jiti-loads the live workflows and runs rpiv-workflow's `validateWorkflow` over each, failing on errors AND warnings (flagship defect: `route-reads-unvalidated-data`). Built-ins carry no inline `outputSchema` — outcomes are contract-sourced; every `reads:` entry must point at a validated/derived channel

<important if="you are adding a new gate or check to a quality lane">
1. Add the pure fold to its gate layer (`verdict-core.ts` rosters/verdict micro-folds · `gate-rosters.ts` tier/roster/risk-duty · `gate-passes.ts` pass predicates/progress hooks) and add its name to the `gates.ts` facade's named re-exports (barrel via `index.ts` only for symbols the barrel already surfaces); emit verdicts via `writeStructureVerdict` or a `verdictOutcome` channel
2. Wire in the owning `workflows/<name>.ts` module — a `produces.script` stage (`reads`, `run`) + route edge `gate(...)`/`match(...)` folding `verdictBlocks`
3. If the stage is re-entered, attach the lane's shared `progress` instance (grade/confirm/snapshot share ONE hook instance — a lap is one unit)
4. Unit tests in the module's `.test.ts` + routing tests in `built-in-workflows.test.ts`; if the write-set touched `built-in-workflows.ts` or any `workflows/*.ts` module, run `node packages/rpiv-pi/skills/elaborate/_helpers/validate-workflow-invariant.mjs`
</important>

<important if="you are adding a fixture">
1. Drop JSON/JSONL into `__fixtures__/` — `run-<hash>-<topic>.json` cap fixtures carry per-round blocking counts + expected halt rows
2. Load in `built-in-workflows.test.ts` via the `loadRunFixture(file)` URL helper; assert per-lap `progressFromRoundCounts` verdicts and counted-lap halts
3. `/repo` prefixes in fixtures are rewritten to a tmp cwd at load — keep path fixtures repo-relative
4. Fixtures never ship: the package `files` array excludes `__fixtures__/` — keep `verifyShipManifest` green
</important>
