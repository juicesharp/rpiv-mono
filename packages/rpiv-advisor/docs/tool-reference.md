# `advisor` tool reference

The exact surface rpiv-advisor registers: the tool's schema, its result envelope, what gets sent to the reviewer, and the rules that decide when the tool is visible to the executor model.

## Signature

```ts
advisor() // zero parameters
```

The parameter schema is an empty object. There is nothing for the executor model
to pass — the conversation branch is read live from the session manager at call
time and serialised automatically.

## What the reviewer receives

Each call assembles the request in this order:

1. **Tool inventory prefix** — one synthetic message listing every tool
   registered in the executor's session (Pi's `getAllTools()`, i.e. the full
   registry, not the active subset), so the reviewer knows what the executor can
   do. It is cached and only rebuilt when the registered tool-name set changes;
   the JSON is key-sorted so identical inventories serialise byte-identically
   and stay prompt-cache friendly.
2. **The conversation branch** — built from Pi's resolved LLM context, not a raw
   replay of history. Compaction summaries and branch summaries are forwarded as
   the model actually sees them, so a compacted session sends the summary rather
   than the pre-compaction detail.
3. **Tail massaging** — the in-flight `advisor()` tool call is stripped from the
   tail, and a user-role message is guaranteed at the end (falling back to
   `Please advise on the executor's situation above.`) so providers that reject
   non-user tails accept the payload.

The reviewer is invoked with the advisor system prompt, `tools: []`, and the
configured reasoning effort. It never calls tools and never writes to your
transcript — its answer comes back only as the tool result the executor reads.
The default prompt guidelines direct the executor to restate the advisor's key
guidance in its next visible reply, so the guidance is not left only in a
collapsed tool card.

While the call is in flight the executor streams
`Consulting advisor (<label>[, <effort>])…`.

## Result envelope

```ts
{
  content: [{ type: "text", text: string }], // reviewer's guidance, or an error message
  details: {
    advisorModel?: string,   // "<provider>:<modelId>" — colon-joined
    effort?: ThinkingLevel,  // the reasoning level actually sent
    usage?: Usage,           // token usage from the side-call
    stopReason?: StopReason, // pi-ai stop reason
    errorMessage?: string,   // populated on the no-model/auth/abort/error/empty paths
  }
}
```

`details.effort` is snapshotted once at entry, so it always matches the
`reasoning` value sent to the provider even if the selection changes mid-call.

Note that `details.advisorModel` uses the **colon** form (`provider:modelId`),
unlike the slash-form `modelKey` persisted in `advisor.json`.

## Failure paths

Every failure returns a normal tool result — the executor reads the text and
keeps going rather than crashing the turn.

| `content` text | `details.errorMessage` |
| --- | --- |
| `No advisor model is configured. The user can enable one with the /advisor command.` | `no advisor model selected` |
| `Advisor (<label>) is misconfigured: <err>` | the registry's auth error |
| `Advisor (<label>) has no API key available.` | `no API key for <provider>` |
| `Advisor call was cancelled before it completed.` | the provider's error message, or `aborted` |
| `Advisor call failed: <err>` | the provider's error message |
| `Advisor returned no text content.` | `empty response` |
| `Advisor call threw: <msg>` | the thrown message |

## When the tool is active

The tool is always **registered** — but it is stripped from the *active* tool
set, meaning the executor model cannot see it and its `promptSnippet` /
`promptGuidelines` drop out of the system prompt, whenever any of:

1. No advisor model is selected.
2. `modelKey` is absent, unparseable, or names a model that is no longer in Pi's
   registry at restore time. The stale in-memory selection is cleared too.
3. The current **executor** model matches a `disabledForModels` entry — see
   [configuration.md](./configuration.md#disabledformodels).

This is what "off costs nothing" means: with no model configured, none of the
advisor's prompt text ever enters the system prompt.

## Lifecycle hooks

| Event | What happens |
| --- | --- |
| `session_start` | Reload `advisor.json`, re-apply model / effort / blocklist, activate or strip, announce once per process. |
| `before_agent_start` | Per-turn reconcile: blocked when no model is selected or the executor is blocklisted. |
| `model_select` | Re-reconcile on executor model change. Skipped for `source === "restore"` to avoid a duplicate notification. |
| `thinking_level_select` | Re-reconcile on reasoning-effort change. |

The three mid-session hooks route through a shared strip-or-add hub
(`reconcileAdvisorTool`). `session_start` uses that hub for the strip path and
adds the tool directly on the restore path.

## `/advisor` picker keys

Both pickers (model, then reasoning level) show up to 10 rows and share the hint
`type to filter • ↑↓ navigate • enter select • esc cancel`.

| Key | Effect |
| --- | --- |
| any printable character | appends to the fuzzy filter and rebuilds the list |
| Backspace | deletes one character from the filter |
| ↑ / ↓ | navigate; ↑ from the first row wraps to the last |
| Enter | select |
| Esc | cancel — the command exits without changing anything |

The filter scores against both the visible label (`Name  (provider)`) and the
underlying `provider/modelId` value, ranking contiguous runs and word-boundary
matches higher — so `op4` and `anthropic` both narrow the list.

`/advisor` requires an interactive TTY. Without one it notifies
`/advisor requires interactive mode` and returns.

## Host compatibility

The reviewer call uses pi-ai's `completeSimple`, which moved between
entrypoints across host versions: Pi ≥ 0.80.1 exports it from
`@earendil-works/pi-ai/compat`, and ≤ 0.79.x from the package root. Because
pi-ai resolves against the *host's* copy at runtime, the loader tries `/compat`
first and falls back to the root **only** on a module-resolution failure
(`ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_MODULE_NOT_FOUND`, `MODULE_NOT_FOUND`,
walked through the `cause` chain). Any other `/compat` error is rethrown so the
real failure surfaces instead of being masked.

If neither entrypoint exposes it, the call throws
`pi-ai does not expose completeSimple on /compat or the package root — unsupported host pi-ai version`.
