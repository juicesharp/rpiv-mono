# rpiv-ask-user-question / tool

## Responsibility
The LLM tool contract surface: TypeBox parameter schemas, pure runtime parameter validation, the canonical `{ content, details }` result envelope builder, and the per-answer scalar formatter that bridges runtime state into the LLM-visible text channel.

## Dependencies
- **`typebox`** (regular dep, moved out of peers — installers that skip peer deps must still get it): `Type` builder + `Static` type extraction
- **`../state/row-intent.js`**: `LABELS_BY_KIND` / `ROW_INTENT_META` — the ONLY outbound state dep in this layer (the `i18n-bridge` dep left with the chat escape hatch; the tool layer is now fully i18n-free)

## Inbound / Outbound
- **Imported by** `ask-user-question.ts` (the tool registrar): `QuestionParamsSchema`, `validateQuestionnaire`, `buildQuestionnaireResponse`, `buildToolResult`
- **Imported by** `rpc-fallback.ts` (RPC/ACP native-dialog walker): `QuestionAnswer`/`QuestionData`/`QuestionnaireResult`/`QuestionParams` types only — its results are funneled through the shared `buildQuestionnaireResponse` envelope (`ask-user-question.ts:164, 251`)
- **`validate-questionnaire.ts`** imports purely from `./types.js` — no state/view reach
- **`response-envelope.ts`** imports `formatAnswerScalar` from `./format-answer.js` + types from `./types.js`

## Module Structure
```
types.ts                  — TypeBox schemas (OptionSchema, QuestionSchema, QuestionsSchema, QuestionParamsSchema),
                            length/cardinality constants, RESERVED_LABELS, QuestionAnswer discriminated union,
                            QuestionnaireError codes, QuestionnaireResult + isQuestionnaireResult guard
format-answer.ts          — Scalar formatter; multi/custom/option branches (variant param retained but inert)
response-envelope.ts      — Envelope assembly (buildQuestionnaireResponse), per-answer segment (buildAnswerSegment), buildToolResult
validate-questionnaire.ts — Pure post-schema runtime guard returning discriminated ValidationResult
types.test.ts             — Schema accept/reject, QuestionAnswer kind union, isQuestionnaireResult guard, reserved label order
```

## TypeBox Params Schema (`description` doubles as prompt copy)
```ts
export const QuestionSchema = Type.Object({
    question: Type.String({ description: "The complete question…" }),
    header:   Type.String({ maxLength: MAX_HEADER_LENGTH, description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS…` }),
    options:  Type.Array(OptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS, description: "…2-4 options…" }),
    multiSelect: Type.Optional(Type.Boolean({ default: false, description: "Set to true to allow multiple…" })),
});
export const QuestionParamsSchema = Type.Object({ questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }) });
```
Every field carries a `description` — these are the LLM-facing prompt; hard limits are embedded as `MAX N CHARACTERS` text to teach the model. The `options` description ends with "The 'Type something.' row is appended automatically — do NOT author it." — a model-conditioning guard tied to free-text now being offered on every question type, including multi-select.

## Result Envelope (canonical builder)
```ts
export function buildToolResult(text: string, details: QuestionnaireResult) {
    return { content: [{ type: "text" as const, text }], details };
}
```
Tool-result envelope MUST be built only through this helper — no inline `{ content, details }` literals at call sites.

## Answer Formatter (per-kind dispatch)
```ts
export function formatAnswerScalar(a: QuestionAnswer, _variant: FormatAnswerVariant): string {
    switch (a.kind) {
        case "multi":  return a.selected && a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
        case "custom": return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
        case "option": return a.answer ?? NO_INPUT_PLACEHOLDER;
    }
}
```
`QuestionAnswer.kind` is a three-variant union (`"option" | "custom" | "multi"`, `types.ts:109`) — the `"chat"` kind left with the escape hatch. `variant` no longer affects any branch (the chat branch was the only consumer); it is retained as `_variant` for signature stability — a deliberate decision documented in `format-answer.ts:13-18`.
`buildAnswerSegment` wraps as `"Q"="A"` + optional `selected preview:` / `user notes:` suffixes; `buildQuestionnaireResponse` brackets with `ENVELOPE_PREFIX`/`SUFFIX`, falling back to `DECLINE_MESSAGE` on null/cancelled/empty.

## Validator Ordering (short-circuit, in order)
`no_questions` → `too_many_questions` → `duplicate_question` → `empty_options` → **`reserved_label`** → `duplicate_option_label`. Reserved-label MUST short-circuit before duplicate. Four codes are intentionally excluded here — produced only in `ask-user-question.ts`, never by `validateQuestionnaire`: `no_ui` (requires runtime `ctx.hasUI`), `no_custom_ui` (RPC/ACP host has `hasUI` but no dialog sub-protocol), `session_load_failed` and `stale_module_cache` (lazy session import failures, including the plugin-reinstall/jiti poisoned-cache case).

## Unified Error Type
```ts
export type QuestionnaireError =
    | "no_ui" | "no_custom_ui" | "no_questions" | "empty_options"
    | "too_many_questions" | "duplicate_question" | "duplicate_option_label"
    | "reserved_label" | "session_load_failed" | "stale_module_cache";
```
Shared between the static validator (`ValidationResult.error`) and the runtime envelope (`QuestionnaireResult.error`) — one error type covers both layers.

## Architectural Boundaries
- **No inline user-facing strings** — every token is a module-level const (`DECLINE_MESSAGE`, `ENVELOPE_PREFIX/SUFFIX`, `NO_INPUT_PLACEHOLDER`, `ERROR_*`)
- **`RESERVED_LABELS` is `["Other", ROW_INTENT_META.other.label, ROW_INTENT_META.next.label]`** — the two runtime-kind labels come from `ROW_INTENT_META` (never re-encoded); `"Other"` is a hardcoded CC-parity literal with no runtime kind. Order is pinned by `types.test.ts` as `["Other", "Type something.", "Next"]`
- **Envelope built only via `buildToolResult`** — see "Tool-result envelope" boundary in package root
- **TypeBox descriptions ARE the prompt copy** — keep them prescriptive, not narrative
