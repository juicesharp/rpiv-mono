# test-utils (@juicesharp/rpiv-test-utils)

## Monorepo Context
Private workspace package under `packages/test-utils/`. Joins lockstep via `sync-versions.js readdirSync("packages")`; `"private": true` blocks `npm publish`. NOT a Pi sibling — no `pi.extensions` field, not listed in `siblings.ts`. Consumed only by `*.test.ts` files across the monorepo.

## Responsibility
Shared test fixtures: factory stubs for the Pi `ExtensionAPI` / `ExtensionContext` surface, detached-execution workflow-host doubles (`spawnChild` session chains, concurrency fakes), synthetic session-entry builders, tool-contract assertions, deterministic theme/TUI fixtures, host-environment doubles (filesystem state writers, child-process stubs, fetch interception, exec stubs), and ship-manifest verification (`verifyShipManifest` — proves a package's `files` array covers its on-disk production `.ts` tree). Keeps every test file from re-inventing capture buckets and ensures one canonical shape for tracking registrations (tools, commands, shortcuts, flags, events).

## Dependencies
- Pi runtime peers (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) — for the type surface tests assert against
- **`@juicesharp/rpiv-workflow`** — type-ONLY imports (`ModelSelection`, `WorkflowHostContext`, `WorkflowSessionContext`) in `pi.ts` and `concurrent-host.ts`, so fixtures satisfy the detached-execution host port
- `vitest` — for `vi` mocks and `expect` contract assertions
- `@earendil-works/pi-tui` and `typebox` — declared peers, never imported; `contract.ts` introspects `tool.parameters` structurally (`type`/`required`/`properties`), so tool-contract assertions stay schema-library-agnostic

## Consumers
- **`packages/*/**.test.ts`**: bare-name imports via `@juicesharp/rpiv-test-utils` only — the `exports` map enables per-concern subpaths, but no test uses them today
- **`test/setup.ts`**: does NOT import from here directly — setup drives resets via the production packages' own exports

## Module Structure
```
.                  — Flat: one module per concern — pi (Pi surface + spawnChild session chains), session,
                     contract, theme, fetch/exec/spawn/fs (host-env doubles), manifest (ship-manifest checker),
                     concurrent-host (WorkflowHostContext concurrency double).
                     Barrel re-export via index.ts; package.json `exports` map enables targeted subpath imports
                     so a test file can pull only the concern it needs — EXCEPT concurrent-host, which is
                     barrel-only today (absent from both `exports` and `files`).
```

## Capture-Bucket Factory Pattern
The Pi-surface factories return `{ pi, captured }` — every `registerTool`/`registerCommand`/`registerShortcut`/`on` call lands in a typed bucket (`CapturedPi`, including `shortcuts`) so tests inspect registrations after-the-fact instead of stubbing each call individually. The mock UI spies the `ExtensionUIContext` members tests actually exercise — 11 of them, including `setEditorComponent` for the lane-switcher dock — not the full surface. The contract: **callers should never need to override one call at a time**; if they do, a new factory variant is the right answer.

## Synthetic Session Branch (replay-axis tests)
Replay-axis tests build a `SessionEntry[]` from plain `Message` literals; the builders type-assert through `as unknown as AssistantMessage`/`ToolResultMessage` (pi-ai's internal discriminators aren't exported) and `as unknown as SessionEntry` (pi-coding-agent's). **Casts are acceptable in fixtures, never in production code** — that boundary is what keeps test ergonomics from leaking type holes into runtime.

## Detached-Execution Fixtures (spawnChild)
`createMockCommandCtx` and `createMockSessionChain` model the rpiv-workflow host port: both expose a `spawnChild` spy (the `newSession` mock is GONE — a breaking rename this cycle) that mints a distinct-sid child ctx by default (`${sessionId}-child`, overridable via `childSessionId`) so parent/child isolation is exercised, not masked; the parent ctx STAYS VALID across every spawn. `createMockSessionChain` dequeues one scripted `MockSessionStep` per spawn — `branch` (child transcript), `cancelled` (spawnChild REJECTS, replacing the old resolved `{ cancelled: true }`), `toolTimeout` (watchdog reason for soft-halt routing), `sessionFile` (real on-disk file for `sessionPolicy: "continue"`/fork coverage) — and aggregates `sentMessages`/`notifications`/`statusUpdates` across all children. `MockCtxOptions` also carries `mode` (`"rpc"` for ACP hosts) and `maxConcurrency`. For concurrency assertions, `createFakeConcurrentHost` (`concurrent-host.ts`) is a Pi-free `WorkflowHostContext` double: it records every spawn as a `FakeSpawnRecord` (`startOrder`/`endOrder`), tracks peak in-flight count (`maxActive`), and can freeze spawns mid-flight via `gate`/`release()`/`waitForActive(n)`. It deliberately deviates from the `{ pi, captured }` shape and uses plain closures instead of `vi.fn()`.

## Host-Environment Stubs
Each double fits its concern — they do NOT share one contract. `stubFetch` is **matcher-driven**: callers register `FetchMatcher[]` and it records every call (`url`/`init`/`AbortSignal`), so tests assert intent, not an ordered tape. `stubGitExec` hard-codes git-arg matching against a fixed `GitExecSpec` (inspect calls via the returned `vi.fn`); `makeSpawnStub` is a scripted `EventEmitter` that records nothing; `writeGuidanceTree` just writes real files.

## Architectural Boundaries
- **NO runtime production-code imports** — fixtures are test-only; importing them from production would leak `vi` into the runtime bundle. Sanctioned exception: type-ONLY imports of rpiv-workflow's host-port types (`pi.ts`, `concurrent-host.ts`) — types erase at compile time, so the runtime-leak rationale still holds
- **`"private": true` is load-bearing** — blocks publish even though lockstep bumps the version; never remove
- **NO `pi.extensions` or `siblings.ts` entry** — not a Pi plugin; the Pi host never loads this package
- **Peer deps pinned to `"*"`** — monorepo-internal; lockstep + workspace symlinks guarantee exact-match at resolve time
- **`as unknown as` casts permitted in fixtures** — pi-coding-agent's internal types aren't all exported; production code must NOT do this
- **`stubFetch` overrides `globalThis.fetch`** — restore in `afterEach` if the test file mixes fetch and non-fetch tests

<important if="you are adding a new test-utils helper">
## Adding a Helper
1. Pick the right module by concern (Pi surface / spawnChild chains, session shapes, contract assertions, TUI fixtures, host-env doubles, ship-manifest, concurrency fakes); create a new module only if none fit
2. If a new module: add it to the barrel, the `package.json` `exports` map (so subpath imports work), and the `files` array in the same change (`concurrent-host.ts` is the standing barrel-only exception — do not add more)
3. Return capture buckets where possible (`{ pi, captured }` shape) — callers should inspect, not stub-per-call
4. Keep `vi.fn()` defaults trivial; per-test overrides handle edge cases
</important>

<important if="you are wiring test-utils into a new package's test suite">
## Consuming test-utils From a New Package
1. No `devDependencies` entry needed — npm workspaces symlinks `@juicesharp/rpiv-test-utils` into `node_modules/` at install time
2. Import by bare name (`from "@juicesharp/rpiv-test-utils"`) for the barrel, OR via subpath (`from "@juicesharp/rpiv-test-utils/contract"`) for targeted concerns
3. If your production module owns module-level singleton state, export a reset AND wire it into `test/setup.ts` `beforeEach` — otherwise isolation leaks across files
4. For replay-axis tests, build a synthetic branch with `buildSessionEntries`, hand it to `createMockCtx`, then call your package's `reconstruct*State(ctx)`
5. For workflow-runner tests that spawn children, script `createMockSessionChain` steps (or use `createFakeConcurrentHost` for parallel-dispatch assertions) — do NOT hand-stub `spawnChild`
</important>
