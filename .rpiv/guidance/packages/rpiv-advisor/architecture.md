# rpiv-advisor

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. Listed in `siblings.ts`; peer-pinned by `rpiv-pi` as `"*"`.

## Responsibility
Single-tool extension implementing the advisor-strategy pattern: registers an `advisor` tool (zero parameters) and the matching slash command. When the executor calls `advisor()`, the tool serializes the current conversation branch and forwards it to a separately-configured reviewer model (typically a stronger reviewer). The tool is registered at load but kept inactive until a model is selected; selection persists at the XDG-resolved `configPath("rpiv-advisor", "advisor.json")` (chmod 0600); reads fall back one-way to the legacy `~/.config` file via `loadJsonConfigWithLegacyFallback` only when no file exists at the XDG path.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`, branch-to-LLM converter, dynamic border
- **`@earendil-works/pi-ai`** (peer): `Model`/`Api`/`ThinkingLevel` types plus a static value import of `getSupportedThinkingLevels` (`advisor/command.ts` effort picker); only `completeSimple` is resolved at runtime by `advisor/pi-compat.ts`
- **`@earendil-works/pi-tui`** (peer): containers, select list, layout primitives
- **`@juicesharp/rpiv-config`** (dependency): `validateGuidanceFields` (persisted prompt overrides), `modelKey`/`parseModelKey` (config codec + blocklist canonicalization)
- **`typebox`** (dependency, `^1.1.24`): empty parameter schema — a runtime dep, not a peer, so tools still register under installers that don't materialize peers

## Consumers
- **Pi extension host** loads via `pi.extensions: ["./index.ts"]`; **`rpiv-pi`** lists it in `peerDependencies` and `siblings.ts`

## Module Structure
```
index.ts         — Composer: registers tool + /advisor command + 4 lifecycle hooks. Pure wiring.
advisor/         — One-concern-per-file core, re-exported via advisor/index.ts barrel:
                     register/execute/prompt/command — tool reg, side-call, prompt loader, command
                     handlers/restore/state/policy — gating, restore, model+effort, blocklist
                     messages/config/context/inventory — strings, config codec, tail-massage, cache
                     pi-compat — host-version-tolerant completeSimple loader (/compat first, root fallback)
advisor-ui.ts    — Selector panel/picker/filter UI primitives.  fuzzy.ts — fuzzy model-name matcher for the picker.
prompts/         — System-prompt asset shipped via the `files` array. Loaded once at init.
```

## Tool Registration (Zero-Parameter + Config-Sourced Prompt Metadata)
```typescript
export function registerAdvisorTool(pi: ExtensionAPI): void {
    const guidance = validateGuidanceFields(loadAdvisorConfig().guidance); // persisted config, DEFAULT_* fallback
    pi.registerTool({
        name: ADVISOR_TOOL_NAME, label: TOOL_LABEL,
        description: ADVISOR_DESCRIPTION,             // long-form, when to escalate
        promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET, promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
        parameters: Type.Object({}),                  // zero params — branch comes from ctx
        execute: async (_id, _params, signal, onUpdate, ctx) =>
            executeAdvisor(ctx, pi, signal, onUpdate), // pi threaded for getAllTools()
    });
}
```

## Registered-but-Inactive Activation Gating
Tool stays registered (visible to `/advisor`) but stripped from active tools — invisible to the LLM — when no model is selected OR the executor model/effort hits the `policy.ts` `disabledForModels` blocklist (`handlers.ts` `reconcileAdvisorTool` strips-or-re-adds).
```typescript
// handlers.ts — before_agent_start; model_select/thinking_level_select re-run with notify; no-model routes through the reconcile hub too — strip logic is never re-inlined.
pi.on("before_agent_start", async (_event, ctx) => {
    const blocked = !getAdvisorModel() || isExecutorBlocked(ctx, pi.getThinkingLevel());
    reconcileAdvisorTool(pi, ctx, { blocked });
});
```

## System Prompt Loading (ESM-safe, once at init)
```typescript
// advisor/prompt.ts — new URL(..., import.meta.url) resolves relative to THIS file, so "../prompts/" climbs
// out of advisor/ to the package-root asset (works from source, dist, node_modules). Sync top-level read.
export const ADVISOR_SYSTEM_PROMPT = readFileSync(fileURLToPath(
    new URL("../prompts/advisor-system.txt", import.meta.url)), "utf-8").trimEnd(); // trimEnd() keeps cache prefix stable
```

## Side-Call Shape (executor branch + tool inventory → reviewer model)
```typescript
// execute.ts — buildSessionContext preserves Pi's RESOLVED LLM context (compaction + branch summaries).
const { messages: sessionMessages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
const inventoryMessage = getInventoryMessage(pi.getAllTools()); // signature-keyed cache on a globalThis Symbol — rebuilds only when the tool-name set changes
const messages = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;
const completeSimple = await loadCompleteSimple(); // first stmt in try — loader failures share errCallThrew
const response = await completeSimple(advisor, { systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] },
    { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort });
// Branch on response.stopReason: "aborted" | "error" | empty text | success
```

## Architectural Boundaries
- **NO main-transcript writes** — the advisor reply is returned as the tool result; never appended via `sendMessage`
- **NO tools for the advisor** — the system prompt forbids tool calls; `completeSimple` is single-shot
- **NO static `completeSimple` import** — pi >= 0.80.1 exports it from `@earendil-works/pi-ai/compat`, <= 0.79.x from the root; `pi-compat.ts` `loadCompleteSimple()` resolves against the HOST's copy (peer pinned `"*"`) and is the single migration point when `/compat` is deleted. Its root fallback fires only on resolution failures (`ERR_PACKAGE_PATH_NOT_EXPORTED`/`ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`, walked through the `cause` chain) so genuine `/compat` init errors surface instead of being masked
- **Sentinel values for selector choices** — collision-proof versus `provider:modelId` keys
- **Config file mode 0o600** — best-effort `chmod`; never throws on filesystems that lack chmod

<important if="you are tweaking the advisor's system prompt">
## Tweaking the System Prompt
1. Edit the prompt file under `prompts/` — plain text, reviewable as a diff
2. Keep contract clauses ("NEVER call tools", "NEVER produce user-facing output") — `executeAdvisor` does no post-filtering
3. `.trimEnd()` strips trailing newline only; internal blank lines preserved
4. No code change needed — restart Pi to pick up the new prompt
5. Behavioral changes about *when* the executor calls advisor go in the prompt-guidelines constants, not the prompt file
</important>
<important if="you are adding a new advisor variant (e.g., critic)">
## Adding a Variant
1. Add a new prompt file under `prompts/`; load it next to the existing system prompt
2. Parameterize the executor (`executeAdvisor(ctx, pi, signal, onUpdate, systemPrompt)`) and add a sibling executor for the variant
3. Clone the tool registrar with its own `name`/`label`/description/snippet/guidelines
4. Wire from the composer and extend the lifecycle gating (`handlers.ts` `reconcileAdvisorTool` + `before_agent_start`) to strip/re-add the new tool name independently
5. Extend the persisted config shape with the new variant's selection — `loadAdvisorConfig` returns `{}` on parse failure so old configs stay forward-compatible
6. Add a CHANGELOG entry under `[Unreleased]`
</important>
