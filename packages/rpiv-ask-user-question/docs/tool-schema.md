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
    globalNote?: string,          // Submit-tab note; present even when cancelled is true
    error?: QuestionnaireError,    // one of the codes above
  }
}
```

### Envelope text

On success the text reads `User has answered your questions: "<question>"="<answer>". …
You can now continue with the user's answers in mind.` A chosen option's `preview` is
appended as `selected preview: <markdown>`, a per-question note as `user notes: <text>`,
and the Submit tab's global note as a trailing `global note: <text>` segment. A global
note alone still yields the answered envelope — it counts as an answer even when every
question is blank.

Cancelling, and any result with neither answer segments nor a global note, both collapse
to the single string `User declined to answer questions` so the model sees one canonical
signal. Partial submission is allowed: unanswered questions simply contribute no segment.
A cancelled result always reads as the decline in text; its note, if any, survives only
in `details.globalNote`.

## Event contract

Everything here imports from the `/events` subpath.

### Outbound

`rpiv:ask-user:prompt` carries the questionnaire, emitted after validation passes and
before the dialog is shown:

```ts
import { ASK_USER_PROMPT_EVENT, type AskUserPromptEventPayload } from "@juicesharp/rpiv-ask-user-question/events";

pi.events.on(ASK_USER_PROMPT_EVENT, (payload: AskUserPromptEventPayload) => {
  // payload.questions[].{ question, header, multiSelect, options[] }
  // payload.questions[].options[].{ label, description, hasPreview }
});
```

Preview *content* is deliberately not shipped in the payload — only `hasPreview: boolean` —
so listeners forwarding the event across a process or network boundary stay cheap.

`rpiv:ask-user:blocked` brackets the wait for input: `{ active: true }` before the dialog
opens, `{ active: false }` in a `finally` when it closes for any reason, so a listener can
tell blocked-on-human apart from working.

### Inbound

`rpiv:ask-user:answer` resolves the questionnaire currently awaiting input, without
synthesizing keystrokes. It exists for programs driving Pi from outside — a pane
supervisor, a test harness — that would otherwise have to send arrow keys and count rows
against a rendered overlay:

```ts
import { ASK_USER_ANSWER_EVENT, ASK_USER_ANSWER_RESULT_EVENT } from "@juicesharp/rpiv-ask-user-question/events";

pi.events.emit(ASK_USER_ANSWER_EVENT, {
  requestId: "r1", // optional, echoed back on the result
  answers: [
    { questionIndex: 0, optionIndexes: [1] },              // single-select: exactly one index
    { questionIndex: 1, optionIndexes: [0, 2], notes: "" }, // multi-select
    { questionIndex: 2, text: "something else" },           // the `Type something.` row
  ],
});
```

Answers are all-or-nothing: every question must be present and every index in range, or
nothing is submitted. A partially applied answer would reach the model indistinguishable
from one the user gave, so a rejection leaves the dialog untouched and open — fix the
payload and emit again.

Every attempt gets a verdict on `rpiv:ask-user:answer-result` — `{ ok, reason?, requestId? }`
— accepted or not. The payload carries no callback because payloads must stay JSON-safe (see
below). Emitting when no questionnaire is awaiting input is rejected, not queued.

Only the terminal dialog honours this event. RPC/ACP hosts run the sequential dialog walker
described in [Hosts and runtime behavior](./hosts.md), which owns its own prompts; an
inbound answer there is rejected with `no questionnaire is awaiting input`.

### Stability

Stability policy for the `rpiv:*` namespace: channel names are immutable, payload changes
are append-only and always optional, payloads stay JSON-safe, and any breaking change ships
as a new channel (e.g. `rpiv:ask-user:prompt.v2`) rather than a version field.
