# @juicesharp/rpiv-test-utils

The shared fixture library the tests in this monorepo import — mock [Pi Agent](https://github.com/badlogic/pi-mono) extension APIs, scripted child sessions, synthetic transcripts, and host-environment stubs. It is internal to this repo: `private: true`, never published to npm, and never loaded by the Pi host.

## What it provides

- **A mock Pi you inspect instead of stub** — `createMockPi()` hands back `{ pi, captured }`, and every `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `on` and `events.emit` call lands in a typed bucket you assert on afterwards.
- **Scripted child sessions** — `createMockSessionChain({ steps })` dequeues one step per `spawnChild()` call (`branch`, `cancelled`, `toolTimeout`, `sessionFile`) and aggregates `sentMessages`, `notifications` and `statusUpdates` across every child.
- **Real concurrency assertions** — `createFakeConcurrentHost()` is a Pi-free `WorkflowHostContext` double that records per-spawn `startOrder`/`endOrder`, tracks the peak in-flight count as `maxActive`, and freezes a run mid-flight with `gate: true` plus `waitForActive(n)` and `release()`.
- **Synthetic transcripts from plain literals** — `buildSessionEntries()` with `makeUserMessage`, `makeAssistantMessage` and `makeToolResult` gives you `SessionEntry[]` while the `as unknown as` casts stay here, out of your test file.
- **One host stub per concern** — `stubFetch` (matcher-driven, records every call), `stubGitExec`, `makeSpawnStub`, `writeGuidanceTree`, and `makeTheme`/`makeTui` for ANSI-free view tests.
- **Structural tool-contract checks** — `assertToolContract(tool, { name, requiredFields, optionalFields })` verifies the name, description, `execute` and the exact `required` set without depending on a schema library.
- **Ship-manifest verification** — `verifyShipManifest(import.meta.url)` diffs a package's on-disk production `.ts` tree against `package.json` `files` in both directions: `missing` and `stale`.

Full export list with signatures and defaults: [docs/api.md](./docs/api.md). Ship-manifest rules and this package's own manifest: [docs/ship-manifest.md](./docs/ship-manifest.md). Deeper design notes: [architecture.md](../../.rpiv/guidance/packages/test-utils/architecture.md).

## Used by

Every workspace package except [rpiv-site](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-site) — 13 packages, 89 files, all of them `*.test.ts`. npm workspaces symlinks the package into `node_modules/`, so no `devDependencies` entry is needed. Import it by bare name:

```ts
import { createMockPi, stubGitExec } from "@juicesharp/rpiv-test-utils";
```

The fixtures are vitest-only — every factory calls `vi`, and the package is consumed as TypeScript source, so plain node or another runner will not load it. A test file has to match `packages/*/**/*.test.ts` for the root `vitest.config.ts` to pick it up. Run from the repo root:

```sh
npm test              # whole suite
npx vitest run packages/rpiv-workflow/api.test.ts   # one file
```

## Conventions

- **Fixtures never enter production code.** Importing them would leak `vi` into the runtime bundle. The one sanctioned coupling is the type-only import of rpiv-workflow's host-port types in `pi.ts` and `concurrent-host.ts`.
- **`as unknown as` casts are allowed here and nowhere else.** pi-ai and pi-coding-agent do not export every internal discriminator; keeping the casts in fixtures is what stops them leaking into runtime types.
- **Factories return capture buckets.** If you find yourself overriding one call at a time, add a factory variant instead.
- **Globals restore themselves.** The repo sets `unstubGlobals: true`, so `stubFetch` needs no manual teardown.
