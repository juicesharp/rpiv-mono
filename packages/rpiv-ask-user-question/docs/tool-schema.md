# Tool schema

The complete programmatic surface of `ask_user_question`: what the model sends, what
validation rejects, what comes back, and the event other extensions can listen to.

## Parameters

```ts
ask_user_question({
  questions: [
    {
      question: string,            // full question text, ends with "?"
      header: string,              // chip label, max 16 chars
      options: [
        {
          label: string,           // 1-5 words, max 60 chars
          description: string,     // what the choice means / its trade-off
          preview?: string,        // markdown rendered next to the options
        },
        // … 2-4 options total
      ],
      multiSelect?: boolean,       // default false
    },
    // … 1-4 questions total
  ]
})
```

### Limits

| Field | Constraint | Enforced by |
| --- | --- | --- |
| `questions` | 1-4 entries | TypeBox schema + `validateQuestionnaire` |
| `questions[].header` | max 16 characters | TypeBox schema only |
| `questions[].options` | 2-4 entries | TypeBox schema (both bounds) + `validateQuestionnaire` (minimum only) |
| `options[].label` | max 60 characters | TypeBox schema only |
| `options[].preview` | single-select questions only | tool description (multi-select tabs render checkbox rows) |

The two `maxLength` limits are checked by the parameter schema before `execute` runs;
the runtime validator does not re-check them.

### Reserved option labels

Authoring any of `"Other"`, `"Type something."`, or `"Next"` as an option label is
rejected with `reserved_label`. The last two are the runtime sentinel rows the dialog
appends itself; `"Other"` is reserved because models are conditioned to reach for it.
Reservation is unconditional — a single-select question rejects `"Next"` even though
that row is never appended there.

## Validation errors

Every rejection returns `cancelled: true`, an empty `answers` array, and an `error`
code. The `content[0].text` string is written for the model, not for a log.

| `error` | Cause |
| --- | --- |
| `no_questions` | `questions` was empty |
| `too_many_questions` | more than 4 questions in one call |
| `duplicate_question` | two questions with identical text |
| `empty_options` | a question carried fewer than 2 options |
| `reserved_label` | an option used a reserved label |
| `duplicate_option_label` | two options in one question share a label |
| `no_ui` | the run has no UI (`ctx.hasUI === false`) |
| `no_custom_ui` | the host cannot render custom UI and exposes no `select`/`input` dialogs |
| `session_load_failed` | the dialog module failed to import (dependencies changed on disk mid-session) |
| `stale_module_cache` | the loader cached a broken module after an earlier failed import; needs a Pi restart |

`reserved_label` short-circuits before `duplicate_option_label`.

## Result

```ts
{
  content: [{ type: "text", text: string }], // envelope prose, or the decline message
  details: {
    answers: Array<{
      questionIndex: number,
      question: string,
      kind: "option" | "custom" | "multi",
      answer: string | null,       // option label, typed text, or null for multi
      selected?: string[],         // chosen labels, multi-select only
      notes?: string,              // free-text note, when you wrote one
      preview?: string,            // echoed back when the chosen option carried a preview
    }>,
    cancelled: boolean,
    error?: QuestionnaireError,    // one of the codes above
  }
}
```

### Envelope text

On success the text reads `User has answered your questions: "<question>"="<answer>". …
You can now continue with the user's answers in mind.` A chosen option's `preview` is
appended as `selected preview: <markdown>`, and a note as `user notes: <text>`.

Cancelling, and any result that produces no answer segments, both collapse to the single
string `User declined to answer questions` so the model sees one canonical signal.
Partial submission is allowed: unanswered questions simply contribute no segment.

## Event contract

The package publishes one event on Pi's event bus, emitted after validation passes and
before the dialog is shown. Import it from the `/events` subpath:

```ts
import { ASK_USER_PROMPT_EVENT, type AskUserPromptEventPayload } from "@juicesharp/rpiv-ask-user-question/events";

pi.events.on(ASK_USER_PROMPT_EVENT, (payload: AskUserPromptEventPayload) => {
  // payload.questions[].{ question, header, multiSelect, options[] }
  // payload.questions[].options[].{ label, description, hasPreview }
});
```

The channel name is `rpiv:ask-user:prompt`. Preview *content* is deliberately not shipped
in the payload — only `hasPreview: boolean` — so listeners forwarding the event across a
process or network boundary stay cheap.

Stability policy for the `rpiv:*` namespace: channel names are immutable, payload changes
are append-only and always optional, payloads stay JSON-safe, and any breaking change ships
as a new channel (e.g. `rpiv:ask-user:prompt.v2`) rather than a version field.
