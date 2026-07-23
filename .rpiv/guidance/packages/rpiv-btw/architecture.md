# rpiv-btw

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. Not in `rpiv-pi`'s auto-install bundle (dropped from `siblings.ts` and its `peerDependencies`) — installed and loaded independently.

## Responsibility
Slash-command-only Pi extension. Spawns a one-off side call to the same primary model with a read-only clone of the current conversation as context, renders the answer in a bottom-anchored ephemeral overlay, and never writes back to the main agent's transcript or to disk. Per-session history is process-scoped via a `globalThis` Symbol-keyed singleton.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`/`ExtensionContext`, branch-to-LLM converter (`convertToLlm`), `SessionEntry`/`Theme` types
- **`@earendil-works/pi-ai`** (peer): the side-call entry (`completeSimple` with `tools: []`, resolved lazily via `pi-compat.ts` — never a static import) and message types
- **`@earendil-works/pi-tui`** (peer): overlay/component types (`OverlayOptions`, `Component`, `TUI`), key-matching (`matchesKey`), ANSI-safe width/wrap helpers

## Consumers
- **Pi extension host**: loads via `pi.extensions: ["./index.ts"]` — the sole consumer

## Module Structure
```
.                — Flat package. Logic + state in one source module; overlay controller in another;
                   host-version-tolerant `completeSimple` loader in `pi-compat.ts` (shipped via `files`);
                   composer (index.ts) wires command registrar + lifecycle hooks.
prompts/         — System-prompt asset shipped via `files`. Loaded once at module init.
```

## No-Pollution Architecture
Five layered constraints keep the main transcript untouched:
1. **Read-only branch clone** — a snapshot of session messages is taken at `message_end` and held until invalidation; calls work off the clone (cold-start only: a live `ctx.sessionManager.getBranch()` read before the first `message_end`)
2. **Direct LLM call bypasses the agent loop** — the call runs **without** tools (no `registerTool` here; the call site MUST pass an empty tool set) so no tool turn lands in transcript
3. **Own `AbortController`** — never reuse the caller's session signal; Esc cancels only the side-question
4. **Bottom-slot overlay via `ctx.ui.custom`** — no agent-message emission, so nothing surfaces in transcript
5. **Process-scoped, session-keyed storage** — history lives on a well-known `globalThis` Symbol cell, never on disk

## Stable-Reference Prompt-Cache Discipline
History stores **actual** `UserMessage`/`AssistantMessage` object references (never re-fabricated) and concatenates them in a deterministic order so the prefix bytes stay byte-identical across turns — this is what keeps prompt-cache hits warm. The architectural rule: **no copy, no mutate, no reorder** of any message the LLM has already seen.

## Snapshot Invalidation
The cached branch clone is dropped on `session_compact` and `session_tree`. Without invalidation, post-compact callers would see a stale view of the conversation. Invalidation is event-driven — never time- or size-based.

## Version-Tolerant `completeSimple` Resolution
`executeBtw` awaits `loadCompleteSimple()` from `pi-compat.ts` — never a static import, because pi-ai resolves against the HOST's copy (peer `"*"`). It tries `@earendil-works/pi-ai/compat` first (Pi >= 0.80.1 moved the global dispatch API there), falling back to the package root ONLY on module-resolution failures (`ERR_PACKAGE_PATH_NOT_EXPORTED` / `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`, walking the error `cause` chain); any other `/compat` error rethrows so real init failures surface instead of being masked. `/compat` is temporary — when pi's ModelManager migration deletes it, `pi-compat.ts` is the single place to migrate.

## Architectural Boundaries
- **NO disk persistence** — `globalThis` only; lost on Pi exit by design
- **NO `ctx.signal` reuse** — own `AbortController` so Esc cancels only this command, not the main session
- **NO tool registration** — slash command + lifecycle hooks only
- **NO runtime imports of sibling packages** — `pi-compat.ts` deliberately duplicates rpiv-core's `isModuleNotFound` (plus the subpath-export code); siblings never import each other at runtime
- **System prompt is frozen** — dynamic context appended via a hint helper; never mutate the static prefix (cache parity)

<important if="you are customizing the BTW overlay">
## Customizing the Overlay
Architectural rules for overlay edits:
- **Mode set is a closed union** — extending modes requires a matching setter + render trigger so state and view never desync
- **Styling goes through `theme.fg/bg(...)`** and width-safe pi-tui helpers — never raw ANSI; visible-width math must be SGR-aware
- **Keys via `matchesKey`** — never compare raw key bytes; Esc must abort the controller AND resolve `done()`
- **Scroll is layout-driven** — natural rows are laid out first, then clipped from the top when overflowing; never a separate scroll model
</important>

<important if="you are adding a new side-question variant">
## Adding a Variant
1. Add an identity constant next to the existing command name (e.g., `BTW_DEEP_COMMAND_NAME`)
2. Add new `MSG_*`/`errXxx` constants in the existing Messages/Errors blocks — never inline strings
3. Drop a new prompt file under `prompts/`; mirror the `readFileSync` + `fileURLToPath(new URL(...))` + `.trimEnd()` recipe
4. Write a registrar mirroring the existing one; wire from the composer
5. Reuse the storage helper; pick a different storage key only if isolation from the existing variant is required
6. Keep the four-branch `StopReason` shape: aborted | error | empty | success
7. Always own the `AbortController`; never reuse `ctx.signal`
</important>
