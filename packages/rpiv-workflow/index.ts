/**
 * rpiv-workflow — public API barrel for embedders. The Pi extension `default`
 * entry lives in the thin `./extension.ts` (not here); startup-time siblings
 * should import the runner-free `@juicesharp/rpiv-workflow/registration` entry.
 *
 * Skill-agnostic: the runner sends `/skill:<name>` via Pi's native skill
 * dispatch — workflows can name any skill installed in Pi's search path
 * (`~/.pi/agent/skills/`, `<cwd>/.pi/skills/`, or settings-declared
 * `skillPaths[]`). This package ships ZERO built-in workflows. Bundles
 * like `@juicesharp/rpiv-pi` opt in by calling `registerBuiltIns(...)`
 * from their own extension entry.
 *
 * ─── Audience map ────────────────────────────────────────────────────────
 *
 * `registration.ts` is the SINGLE enumeration of the runner-free public
 * surface — this header only routes you to the right module. (A previous
 * symbol-by-symbol catalog here drifted from reality twice; it is gone on
 * purpose.)
 *
 *   - Authoring a workflow (config/pack files) → `./api.js` (DSL barrel:
 *     `defineWorkflow` + the stage/loop/routing factories),
 *     `./predicates.js`, `./typebox-adapter.js`.
 *   - Driving runs programmatically → `./runner/index.js` (`runWorkflow`,
 *     `resumeWorkflow` + by-name/by-run-id sugar); host ports in `./host.js`.
 *   - Loading the merged registry → `./load/index.js` (`loadWorkflows`).
 *   - Contributing built-in workflows (sibling packages) → `./built-ins.js`
 *     (`registerBuiltIns`).
 *   - Output envelope + bundled collectors/parsers → `./output.js`,
 *     `./outcomes/index.js`, `./handle.js`; custom-outcome authoring →
 *     `./output-spec.js` (`Outcome`, `defineCollector` / `defineParser`).
 *   - Validation → `./validate-workflow.js`, `./validate-output.js`.
 *   - Observing runs → `./events.js` (`registerLifecycle`, per-call
 *     `RunWorkflowOptions.lifecycle`).
 *   - Inspecting past runs (JSONL) → `./state/index.js` (`listRuns`,
 *     `readHeader`, `runFileFor`, …). Row WRITES are runner-owned;
 *     `recordStage` lives on `@juicesharp/rpiv-workflow/internal`
 *     (test-only).
 *
 * Per-module deep imports (`from "@juicesharp/rpiv-workflow/api.js"`)
 * are NOT supported across the package boundary.
 *
 * ─── Pi-coupling boundary ───────────────────────────────────────────────
 *
 * The package's public type surface names ZERO `@earendil-works/pi-coding-agent`
 * types. Every host capability the runtime needs is declared as a
 * workflow-owned port in `./host.js`:
 *
 *   • `WorkflowHost`     — registry-level (default export + continue sends)
 *   • `WorkflowHostContext`  — per-command ctx for `runWorkflow`; also the
 *                          base shape of the replacement ctx delivered to
 *                          `newSession`'s `withSession` callback.
 *                          `sendUserMessage` is optional at the type level
 *                          (the outer command ctx omits it); the runtime
 *                          guarantees it is present inside `withSession`.
 *   • `WorkflowSessionContext` — the narrower subtype delivered inside
 *                          `withSession`, where `sendUserMessage` is
 *                          GUARANTEED present (optional → required).
 *
 * Pi's `ExtensionAPI` / `ExtensionCommandContext` are structurally
 * compatible with these ports — embedders pass their existing Pi handles
 * directly. A future non-Pi host implements the three port interfaces.
 *
 * The package no longer imports any value from
 * `@earendil-works/pi-coding-agent` — `parseFrontmatter` moved to
 * `@juicesharp/rpiv-pi` along with the rpiv-flavoured outcome
 * (`rpivArtifactMdOutcome`). The peer dep stays for `pi-tui` types
 * structural-compatibility only.
 *
 * `host.test.ts` carries a compile-time tripwire that fails immediately
 * if Pi's types drift below the port's required shape.
 */

// Runner-free surface (DSL, registrars, loader, outcomes, …) lives in
// `./registration.js`; startup-time siblings import that to skip the ~530ms
// engine. This entry layers the runner on top for embedders.
export * from "./registration.js";

// The execution engine — the only re-export unique to this entry. The budget
// defaults and `validateRunBudgets` ride along: the runner refuses a malformed
// `maxBackwardJumps`/`maxLaps`/`maxIterations` pre-flight, so an embedder
// must be able to pre-validate and read the defaults the refusal math uses.
export {
	MAX_BACKWARD_JUMPS,
	MAX_ITERATIONS,
	MAX_LAPS,
	type ResumeWorkflowByRunIdOptions,
	type ResumeWorkflowOptions,
	type RunBudgetOptions,
	type RunWorkflowByNameOptions,
	type RunWorkflowOptions,
	type RunWorkflowResult,
	resumeWorkflow,
	resumeWorkflowByRunId,
	runWorkflow,
	runWorkflowByName,
	validateRunBudgets,
} from "./runner/index.js";

// NOTE: the Pi extension `default` entry is `./extension.ts`, not this barrel,
// so loading the extension doesn't evaluate the runtime re-exports above.
