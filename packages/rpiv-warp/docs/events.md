# Event reference

Every Pi lifecycle event `rpiv-warp` subscribes to, the Warp wire event it emits,
and the exact bytes and JSON that go out to the terminal.

## Lifecycle handlers

`rpiv-warp` registers exactly nine `pi.on(...)` handlers. It registers no tools,
no slash commands, no widgets, and no keyboard shortcuts.

| Pi event | Emits | Side effects |
| --- | --- | --- |
| `session_start` | `session_start` — only when `reason === "startup"` | none |
| `before_agent_start` | nothing | captures the prompt for `prompt_submit` and the heartbeat |
| `agent_start` | a stale-reason `tool_complete` if a block reason outlived a missed `agent_end`, then `session_start` (defensive re-announce), then `prompt_submit` | marks the turn active, starts the tab-title spinner, cancels the pending idle timer, starts the heartbeat |
| `agent_end` | the drain's `tool_complete` (see below), then `stop` | clears every block reason and marks the turn inactive, stops the spinner, stops the heartbeat, arms the 300 ms idle timer |
| `tool_call` | `question_asked` — only for a tool in `blockingTools`, and only on the 0→1 block-reason transition | records the call's input; on that transition, stops the spinner and pauses the heartbeat |
| `tool_execution_end` | `tool_complete` — only for a tool in `blockingTools`, and only on the 1→0 block-reason transition | restarts the spinner, resumes the heartbeat |
| `ui_prompt_start` | `question_asked` — for any extension UI prompt raised during a turn, and only on the 0→1 block-reason transition | stops the spinner, pauses the heartbeat |
| `ui_prompt_end` | `tool_complete` — only on the 1→0 block-reason transition | restarts the spinner and resumes the heartbeat, but only if the turn is still live |
| `session_shutdown` | nothing | cancels the idle timer, stops the heartbeat, stops the spinner, clears pending state |

`/new`, `/resume`, `/fork` and `/reload` all fire `session_start` with a reason
other than `"startup"`, so none of them notify — you are already looking at the
terminal in those cases.

### The block-reason set

The Blocked badge is driven by one `Set<string>` of reasons, not by the handlers
independently. A key is either `tool:<toolCallId>` — one per outstanding
tool_call of a name in `blockingTools` — or `prompt`, for an extension UI prompt.

Two helpers own every transition:

- `addBlockReason(reason)` returns `true` only when the set went from empty to
  non-empty. That is the moment Warp must be told `question_asked`.
- `removeBlockReason(reason)` returns `true` only when the reason was present and
  the set is empty again. That is the moment Warp must be told `tool_complete`.

Raising on 0→1 and clearing on 1→0 is the same convention the
[workflow-question transport](#workflow-question-transport) already uses: it emits
`question_asked` and `tool_complete` for something that is not a tool call, and
attributes the clear to `tool_name: "ask_user_question"`.

A set of reasons, rather than a boolean or a counter, is what keeps the handlers
correct:

- `ask_user_question` fires **two** events in a single episode: `tool_call` (its
  name is in the default `blockingTools`) and `ui_prompt_start` (the tool renders
  through `ctx.ui`). Two independent per-handler booleans would raise
  `question_asked` twice and clear the badge on the first of the two ends.
- Keying tool calls by `toolCallId` stops a second, still-open call of the same
  tool from clearing the badge when the first one finishes.
- It tolerates event ordering. Pi delivers `ui_prompt_start` / `ui_prompt_end`
  through `queueMicrotask`, so a `ui_prompt_end` can land after an overlapping
  `tool_execution_end`; the badge clears only when the *last* reason goes away,
  whichever that turns out to be.

`ui_prompt_start` no-ops outside a live turn, so a config modal raised between
turns never lights the badge. `ui_prompt_end` no-ops whenever its `prompt` reason
is absent — which is what makes the late end that arrives after `agent_end`
drained the reason emit nothing.

### Why `agent_end` drains blocked state

Pressing ESC during a blocking tool aborts it, and an aborted tool never fires
`tool_execution_end`. Without a drain, Warp's Blocked badge would stay lit for the
rest of the session. `agent_end` therefore emits a `tool_complete` for every call
still outstanding — carrying the tool name and the input captured at `tool_call`
time — before it emits `stop`.

A permission prompt reaches the drain by a different route: it blocks a tool that
is *not* in `blockingTools`, so no `tool_call` was ever captured for it and the
drain loop above has nothing to emit. When the turn ends with a prompt reason open
and the drain emitted nothing, `agent_end` emits one `tool_complete` itself —
`tool_name: "ask_user_question"`, no `tool_input` — to clear the badge.

Either route ends the same way: exactly one clear for one block episode, emitted
before `stop`. A late `ui_prompt_end` after that drain is a no-op, because its
reason was already removed. A reason that outlives its turn entirely — a crash or
reload that skipped `agent_end` — is reset at the next `agent_start`, which clears
the set and emits the same `tool_complete` before re-announcing the session.

## Timer-driven emissions

| Emission | Trigger |
| --- | --- |
| `idle_prompt` | 300 ms after `agent_end`, unless `agent_start` or `session_shutdown` cancels first. Carries the last assistant message as `summary`. |
| `prompt_submit` | Re-emitted every `heartbeatMs` (default 15000) while a turn is active, so Warp does not decide the session went idle mid-task. Paused while a block reason is open — a blocking tool or an extension UI prompt — and stopped at turn end. |

Both timers, and the spinner's interval, are `unref()`d — a stray timer can never
hold the process open.

## Wire format

Every notification is one OSC 777 write to the controlling terminal, with the
literal title `warp://cli-agent` and a JSON body:

```
ESC ] 777 ; notify ; warp://cli-agent ; <json> BEL
```

The tab-title spinner uses three more sequences:

| Sequence | Bytes | Used for |
| --- | --- | --- |
| OSC 0 | `ESC ] 0 ; <title> BEL` | writing the animated tab title — `<frame> - <repo>`, or `<frame> - <session> - <repo>` for a named session |
| CSI 22;0t | `ESC [ 22;0t` | pushing the current title onto the xterm title stack on spinner start |
| CSI 23;0t | `ESC [ 23;0t` | popping it on spinner stop, restoring Pi's `π - <repo>` title verbatim |

The spinner is four braille frames rewritten every 160 ms, so a full cycle takes
~640 ms. Terminals that do not implement the title stack ignore both CSI
sequences silently.

## Payload fields

Every payload carries the same envelope:

| Field | Value |
| --- | --- |
| `v` | negotiated protocol version (see [detection.md](./detection.md)) |
| `agent` | `"pi"` |
| `event` | one of `session_start`, `prompt_submit`, `stop`, `question_asked`, `tool_complete`, `idle_prompt` |
| `session_id` | Pi's session id — or the workflow run id, for workflow-question badges |
| `cwd` | absolute working directory |
| `project` | `basename(cwd)` |

Per-event additions:

| Event | Extra fields |
| --- | --- |
| `prompt_submit` | `query` — the prompt you submitted |
| `stop` | `query` — last user message; `response` — last assistant message |
| `idle_prompt` | `summary` — last assistant message |
| `tool_complete` | `tool_name`, plus `tool_input` when the input was captured at `tool_call` |
| `session_start`, `question_asked` | none |

A `tool_complete` that clears a prompt-driven block — or that resets a stale
reason at `agent_start` — carries `tool_name: "ask_user_question"` and no
`tool_input`: the same shape the workflow-question transport emits to clear a
run's badge.

Example `stop` body:

```json
{
  "v": 1,
  "agent": "pi",
  "event": "stop",
  "session_id": "0199c0d5-...",
  "cwd": "/Users/you/src/rpiv-mono",
  "project": "rpiv-mono",
  "query": "/skill:commit the config change",
  "response": "Committed as 4f2a1c9."
}
```

### Text normalization

- Fields read back from the session branch — `stop.query`, `stop.response` and
  `idle_prompt.summary` — are truncated to 200 characters with a trailing `...`.
  The `query` on `prompt_submit` is the prompt as submitted, untruncated.
- A `<skill name="…" location="…">…</skill>` wrapper is collapsed back to
  `/skill:<name> <args>`, and the internal `Skill input: ` label is stripped, so a
  toast shows what you typed rather than the expanded LLM input.

## Workflow-question transport

`rpiv-warp` also exports a direct-call API used by
[`@juicesharp/rpiv-pi`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-pi)
to badge parked workflow questions independently of the launcher session:

```ts
import { createWorkflowQuestionTransport } from "@juicesharp/rpiv-warp";

const transport = createWorkflowQuestionTransport(process.cwd());
transport.asked("run-1");     // session_start + question_asked, session_id = "run-1"
transport.resolved("run-1");  // tool_complete, tool_name = "ask_user_question"
```

Keying `session_id` on the workflow run id is what lets concurrent `/wf` runs
badge and clear independently. Both methods check the Warp environment on every
call and no-op outside it, so a caller can invoke them unconditionally.
`resolved` carries no `tool_input` — the bridge aggregates questions and has no
per-question input to report.
