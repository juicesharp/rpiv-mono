/**
 * Compile-time tripwire: assert that Pi's concrete types structurally satisfy
 * the workflow runtime's host ports. This file is the SOLE coupling point to
 * `@earendil-works/pi-coding-agent` type names in rpiv-workflow's
 * test/typecheck pipeline — production source is Pi-name-free.
 *
 * Post-detachment the executor port (`spawnChild`/`maxConcurrency`) is
 * satisfied by `SdkWorkflowHost` in rpiv-pi, NOT by Pi's command ctx — and
 * rpiv-workflow must not import rpiv-pi, so that satisfaction assertion lives
 * in `rpiv-pi/extensions/rpiv-core/sdk-workflow-host.test.ts`. Here we assert
 * only what Pi's interactive ctx still satisfies: the OBSERVER surface the
 * decoupled `/wf` launcher relays progress through.
 *
 * Not a runtime test — `it("compiles")` is a sentinel so Vitest's discovery
 * glob picks up the file without dead assertions.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { it } from "vitest";
import type { WorkflowHost, WorkflowHostContext } from "./host.js";

// The subset of WorkflowHostContext the launcher uses as an OBSERVER — it
// notifies / sets status, reads hasUI, and may read the session transcript,
// but never calls spawnChild (that is the executor host's job).
type WorkflowObserverContext = Pick<
	WorkflowHostContext,
	"cwd" | "hasUI" | "ui" | "sessionManager" | "waitForIdle" | "signal"
>;

// Each `Satisfies` evaluates to `true` iff the LHS is assignable to the RHS.
// The `const _foo: true = ...` line is what triggers the type error if
// assignability fails.
type Satisfies<Concrete, Port> = Concrete extends Port ? true : false;

const _hostOk: Satisfies<ExtensionAPI, WorkflowHost> = true;
const _observerOk: Satisfies<ExtensionCommandContext, WorkflowObserverContext> = true;

void _hostOk;
void _observerOk;

it("host ports are structurally satisfied by pi-coding-agent types (see compile-time asserts above)", () => {});
