/**
 * Compile-time tripwire: assert that Pi's concrete types structurally
 * satisfy the workflow runtime's host ports. This file is the SOLE
 * coupling point to `@earendil-works/pi-coding-agent` type names in the
 * test/typecheck pipeline — production source is Pi-name-free.
 *
 * If Pi's API drifts (rename `newSession`, tighten a signature, drop a
 * method we depend on), `npm run check` fails here with an exact
 * "Type 'ExtensionCommandContext' does not satisfy ..." pointer.
 *
 * Not a runtime test — `it("compiles")` is a sentinel so the file is
 * picked up by Vitest's discovery glob without contributing dead
 * assertions to a future test refactor.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { it } from "vitest";
import type { WorkflowHost, WorkflowHostContext, WorkflowSessionContext } from "./host.js";

// Pi keeps `ReplacedSessionContext` (the withSession parameter type)
// internal — derive it from `newSession`'s signature so we don't depend
// on Pi's private export surface.
type WithSessionParam<T> = T extends { withSession?: (ctx: infer C) => Promise<void> } ? C : never;
type PiReplacedSessionContext = WithSessionParam<Parameters<ExtensionCommandContext["newSession"]>[0]>;

// Each `Satisfies` evaluates to `true` iff the LHS is assignable to the
// RHS. The `const _foo: true = ...` line is what triggers the type
// error if assignability fails.
type Satisfies<Concrete, Port> = Concrete extends Port ? true : false;

const _hostOk: Satisfies<ExtensionAPI, WorkflowHost> = true;
const _cmdOk: Satisfies<ExtensionCommandContext, WorkflowHostContext> = true;
const _sessionOk: Satisfies<PiReplacedSessionContext, WorkflowHostContext> = true;
// The replacement ctx must satisfy the STRONGER session port: Pi wires a
// `sendUserMessage` into freshly-opened sessions. If Pi ever drops it from
// the withSession ctx, this fails — and the `FRESH_HANDLER.spawn` guard we
// removed would need restoring.
const _sessionSenderOk: Satisfies<PiReplacedSessionContext, WorkflowSessionContext> = true;

void _hostOk;
void _cmdOk;
void _sessionOk;
void _sessionSenderOk;

it("host ports are structurally satisfied by pi-coding-agent types (see compile-time asserts above)", () => {});
