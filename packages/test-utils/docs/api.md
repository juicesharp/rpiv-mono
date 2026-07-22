# API reference

Every export of `@juicesharp/rpiv-test-utils`, grouped by module. `index.ts` re-exports all ten
modules, so everything below is reachable from a single bare-name import:

```ts
import { createMockPi, makeTheme, stubFetch } from "@juicesharp/rpiv-test-utils";
```

`verifyShipManifest` has its own page: [ship-manifest.md](./ship-manifest.md).

## `pi.ts` — Pi `ExtensionAPI` doubles

| Export | Signature |
| --- | --- |
| `createMockPi` | `(options?: CreateMockPiOptions) => { pi: ExtensionAPI; captured: CapturedPi }` |
| `createMockUI` | `(overrides?: Partial<ExtensionUIContext>) => MockUI` |
| `createMockSessionManager` | `(branch?: SessionEntry[], sessionId?: string) => { getBranch, getEntries, getLeafId, getSessionFile, getSessionId }` |
| `createMockModelRegistry` | `(models?: Model<Api>[]) => { find, getAvailable, getApiKeyAndHeaders }` |
| `createMockCtx` | `(opts?: MockCtxOptions) => ExtensionContext` |
| `createMockCommandCtx` | `(opts?: MockCtxOptions) => ExtensionCommandContext & WorkflowHostContext` |
| `createMockSessionChain` | `(opts: MockSessionChainOptions) => MockSessionChain` |
| `mockAssistantMessage` | `(text: string, stopReason?: "stop" \| "length" \| "toolUse" \| "error" \| "aborted") => unknown` |

Types: `CapturedShortcut`, `CapturedPi`, `MockPi`, `CreateMockPiOptions`, `MockUI`, `MockCtxOptions`,
`MockSessionStep`, `MockSessionChainOptions`, `MockSessionChain`.

### What `createMockPi` captures

`captured` is a `CapturedPi` with eight buckets:

| Bucket | Filled by | Shape |
| --- | --- | --- |
| `tools` | `registerTool(tool)` | `Map<string, ToolDefinition>` |
| `commands` | `registerCommand(name, cmd)` | `Map<string, Omit<RegisteredCommand, "name" \| "sourceInfo">>` |
| `shortcuts` | `registerShortcut(keyId, opts)` | `Map<string, CapturedShortcut>` |
| `flags` | `registerFlag(name, value)` | `Map<string, unknown>` |
| `events` | `on(event, handler)` | `Map<string, Array<(...args) => unknown>>` |
| `eventsEmitted` | `events.emit(channel, data)` | `Map<string, unknown[]>` |
| `activeTools` | `registerTool`, `setActiveTools` | `string[]` |
| `allTools` | read by `getAllTools()` | `ToolInfo[]` |

Spied `ExtensionAPI` members: `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`,
`getFlag`, `on`, `sendMessage`, `sendUserMessage`, `exec`, `getActiveTools`, `setActiveTools`,
`getAllTools`, `getThinkingLevel`, `events.emit`, `events.on`, `getCommands`. Non-empty defaults:
`exec()` → `{ stdout: "", stderr: "", code: 0, killed: false }`, `getThinkingLevel()` → `"medium"`.
Anything you pass in `options` spreads over the defaults and wins.

`options.skills: readonly string[]` surfaces each name from `getCommands()` as a `RegisteredCommand`
shaped like a Pi skill — `name: "skill:<name>"`, `source: "skill"`,
`sourceInfo.path: "/mock/skills/<name>/SKILL.md"`, `sourceInfo.baseDir: "/mock/skills/<name>"`. An
explicit `getCommands` override in the same call replaces it entirely.

### `createMockUI`

Returns `vi.fn()` spies for the eleven `ExtensionUIContext` members tests actually exercise:
`notify`, `confirm`, `input`, `select`, `setWidget`, `setStatus`, `setWorkingMessage`,
`setHiddenThinkingLabel`, `onTerminalInput`, `pasteToEditor`, `setEditorComponent`.

### `MockCtxOptions`

| Option | Type | Default |
| --- | --- | --- |
| `hasUI` | `boolean` | `false` |
| `mode` | `string` | omitted (`"rpc"` for ACP hosts) |
| `cwd` | `string` | `"/tmp/test-cwd"` |
| `model` | `Model<Api>` | omitted |
| `branch` | `SessionEntry[]` | `[]` |
| `models` | `Model<Api>[]` | `[]` |
| `ui` | `Partial<ExtensionUIContext>` | `{}` |
| `maxConcurrency` | `number` | `1` (sequential) |
| `sessionId` | `string` | `"test-session"` |
| `childSessionId` | `string` | `` `${sessionId}-child` `` |

Other ctx stub defaults: `getSessionFile()` → `"/tmp/test-session.jsonl"`, `isIdle()` → `true`,
`getApiKeyAndHeaders()` → `{ ok: true, apiKey: "test-key", headers: {} }`, `confirm()` → `true`,
`input()` → `""`, `select()` → `undefined`. `exec` and `getThinkingLevel` live on the `pi` double
from `createMockPi`, not on the ctx.

`createMockCommandCtx` adds `waitForIdle`, `maxConcurrency`, and a `spawnChild` spy that mints a
child ctx with a distinct session id and runs `withSession` on it. The parent ctx stays valid — no
swap. Use it when your test mocks the runner or never spawns for real.

### `createMockSessionChain`

Scripts a queue of child sessions. Every `spawnChild` call — on the outer ctx or on a child handed
to a prior `withSession` — dequeues one `MockSessionStep`.

| `MockSessionStep` field | Effect |
| --- | --- |
| `branch?: unknown[]` | Entries the child's `sessionManager.getBranch()` returns |
| `cancelled?: boolean` | `spawnChild` **rejects** without invoking `withSession`; mutually exclusive with `branch` |
| `toolTimeout?: { reason: string }` | Child ctx's `toolTimeout()` reports this reason (watchdog soft-halt routing) |
| `sessionFile?: string` | The child's `getSessionFile()`; needed when a later `sessionPolicy: "continue"` stage must fork a real file |

`MockSessionChainOptions` extends `MockCtxOptions` with `steps`, an optional `pi`, and `outerBranch`
(pre-populated entries for the outer ctx, so `branchOffset` slicing is exercised).

The returned `MockSessionChain` exposes `ctx`, `sentMessages`, `notifications`, `statusUpdates`,
`pi`, `remaining()`, and the shared spies `notifyFn`, `setStatusFn`, `sendUserMessageFn`. The initial
`prompt` is pushed to `sentMessages` on every spawn **except** `reattach` and `fork` modes, which
open or copy a persisted session without replaying it.

Two errors it throws by design:

```
createMockSessionChain: spawnChild called but no more scripted steps remain (chain consumed too many).
createMockSessionChain: scripted child cancellation (spawnChild rejected).
```

## `concurrent-host.ts` — concurrency assertions

`createFakeConcurrentHost(opts?: FakeConcurrentHostOptions) => FakeConcurrentHost`

A `WorkflowHostContext` double with no Pi import, built to prove parallel-fanout behaviour end to
end. It deliberately deviates from the `{ pi, captured }` shape and uses plain closures rather than
`vi.fn()`.

| Option | Default |
| --- | --- |
| `maxConcurrency` | `1` |
| `cwd` | `"/tmp/fake-concurrent-cwd"` |
| `hasUI` | `false` |
| `gate` | `false` — when `true`, every spawn blocks until `release()` |
| `bucket` | `"audits"` |
| `childBranch(rec, index)` | one assistant message reading `` `wrote .rpiv/artifacts/${bucket}/unit-${index}.md` `` |

The host reports `ctx`, `spawns: FakeSpawnRecord[]`, `maxActive` (peak in-flight), `active()`,
`notifications`, `statusUpdates`, `setMaxConcurrency(n)`, `release()`, and `waitForActive(n)`. Each
`FakeSpawnRecord` carries `prompt`, `model`, `signal`, `reattach`, `fork`, `startOrder`, and
`endOrder` (`-1` until settled). The outer session file is `` `${cwd}/.session.jsonl` `` and
`getSessionId()` returns `"fake-session"`.

To simulate an abort, return a `childBranch` whose assistant message carries
`stopReason: "aborted"`. A `reattach` spawn is modelled as an empty resumed transcript.

Freeze a run mid-flight:

```ts
const host = createFakeConcurrentHost({ maxConcurrency: 3, gate: true });
const run = runWorkflow(host.ctx, spec);
await host.waitForActive(3);
expect(host.maxActive).toBe(3);
host.release();
await run;
```

## `session.ts` — synthetic transcripts

| Export | Signature |
| --- | --- |
| `makeUserMessage` | `(text: string) => UserMessage` |
| `makeAssistantMessage` | `(input: AssistantMessageInput) => AssistantMessage` |
| `makeToolResult` | `(input: ToolResultInput) => ToolResultMessage` |
| `makeMessageEntry` | `(message: Message) => SessionEntry` |
| `buildSessionEntries` | `(messages: Message[]) => SessionEntry[]` |
| `buildLlmMessages` | `(messages: Message[]) => Message[]` — keeps `user`, `assistant`, `toolResult` |
| `makeTodoToolResult` | `(details: unknown, text?: string) => ToolResultMessage` — `text` defaults to `"ok"` |
| `makeInflightAdvisorAssistant` | `() => AssistantMessage` — one `advisor` tool call, id `"advisor-inflight"` |

`AssistantMessageInput` is `{ text?, toolCalls? }`; `ToolResultInput` is
`{ toolCallId?, toolName, text?, details?, isError? }`, where `toolCallId` defaults to
`` `call-${toolName}-${Date.now()}` `` and `isError` defaults to `false`.

These builders cast through `as unknown as` because pi-ai and pi-coding-agent do not export their
internal discriminators. Keeping the casts here is the point — your test file stays clean.

## `contract.ts` — tool-contract assertions

| Export | Signature |
| --- | --- |
| `assertToolContract` | `(tool: ToolDefinition, expected: ToolContract) => void` |
| `describeRegisteredTools` | `(factory: (pi: ExtensionAPI) => void \| Promise<void>) => Promise<ToolDefinition[]>` |
| `roundTripBranchState` | `<TDetails>(spec: BranchRoundTripSpec<TDetails>) => Promise<{ before: unknown; after: unknown }>` |

`ToolContract` is `{ name, requiredFields, optionalFields? }`. `assertToolContract` checks the name,
a non-empty string description, a callable `execute`, `parameters.type === "object"`, and an exact
match on the `required` set; `optionalFields` are checked for presence in `properties`. The
introspection is structural, so it holds whichever schema library built `parameters`.

`roundTripBranchState` resets, snapshots, replays synthesised `toolResult` entries, and snapshots
again — the standard shape for "does this module rebuild its state from the session branch?".

## `theme.ts` — deterministic TUI fixtures

`makeTheme(overrides?: Partial<MockTheme>) => MockTheme` returns identity `fg`, `bg`, `bold`, and
`strikethrough`, so view tests assert plain text with no ANSI. `makeTui() => MockTui` returns a
`requestRender` spy.

## `fetch.ts` — matcher-driven fetch stub

`stubFetch(matchers: FetchMatcher[]) => FetchStub`

Each `FetchMatcher` is `{ match(url, init), response(url, init) }`, tried in order. Every call is
recorded on `FetchStub.calls` as `{ url, init, signal }`. An unmatched URL throws
`` `stubFetch: no matcher for ${url}` ``. The stub installs via `vi.stubGlobal("fetch", …)`; the
repo's `unstubGlobals: true` restores it automatically between tests.

## `exec.ts` — git exec stub

`stubGitExec(spec?: GitExecSpec) => vi.fn`

`GitExecSpec` is `{ branch?, commit?, user?, userError? }`. The returned spy answers three git
invocations and returns an empty success for everything else (including non-`git` commands):

| Args | Result |
| --- | --- |
| `rev-parse --abbrev-ref HEAD` | `stdout: "<branch>\n"` |
| `rev-parse --short HEAD` | `stdout: "<commit>\n"` |
| `config user.name` | `stdout: "<user>\n"`, or throws `userError` when set |

Results use the real `ExecResult` shape: `{ stdout, stderr, code, killed }`.

## `spawn.ts` — child-process stub

`makeSpawnStub(script?: SpawnScript) => SpawnStub`

An `EventEmitter` with `stdout`/`stderr` emitters, a `killed` flag, `kill()`, and
`settleAfterKill(code)` (emits `close`). On the next tick it emits any scripted `stdout`/`stderr`
data, then either `error` (when `script.error` is set) or `close` with `script.exitCode ?? 0`. Set
`neverSettles: true` to model a hung process and drive it manually.

## `fs.ts` — guidance-tree writer

`writeGuidanceTree(projectDir: string, spec: Record<string, string>) => void`

Writes each `relPath → content` pair under `projectDir`, creating parent directories as needed.
Paths in `spec` use `/` and are re-joined with the platform separator, so the same spec works on
every OS.
