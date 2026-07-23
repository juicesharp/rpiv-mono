# Event reference

Every Pi lifecycle event `rpiv-warp` subscribes to, the Warp wire event it emits,
and the exact bytes and JSON that go out to the terminal.

## Lifecycle handlers

`rpiv-warp` registers exactly seven `pi.on(...)` handlers. It registers no tools,
no slash commands, no widgets, and no keyboard shortcuts.

| Pi event | Emits | Side effects |
| --- | --- | --- |
| `session_start` | `session_start` — only when `reason === "startup"` | none |
| `before_agent_start` | nothing | captures the prompt for `prompt_submit` and the heartbeat |
| `agent_start` | `session_start` (defensive re-announce), then `prompt_submit` | starts the tab-title spinner, cancels the pending idle timer, starts the heartbeat |
| `agent_end` | one `tool_complete` per outstanding blocking call, then `stop` | stops the spinner, stops the heartbeat, arms the 300 ms idle timer |
| `tool_call` | `question_asked` — only for a tool in `blockingTools` | records the call's input, stops the spinner, pauses the heartbeat |
| `tool_execution_end` | `tool_complete` — only for a tool in `blockingTools` | restarts the spinner, resumes the heartbeat |
| `session_shutdown` | nothing | cancels the idle timer, stops the heartbeat, stops the spinner, clears pending state |

`/new`, `/resume`, `/fork` and `/reload` all fire `session_start` with a reason
other than `"startup"`, so none of them notify — you are already looking at the
terminal in those cases.

### Why `agent_end` drains blocking calls

Pressing ESC during a blocking tool aborts it, and an aborted tool never fires
`tool_execution_end`. Without a drain, Warp's Blocked badge would stay lit for the
rest of the session. `agent_end` therefore emits a `tool_complete` for every call
still outstanding — carrying the tool name and the input captured at `tool_call`
time — before it emits `stop`.

## Timer-driven emissions

| Emission | Trigger |
| --- | --- |
| `idle_prompt` | 300 ms after `agent_end`, unless `agent_start` or `session_shutdown` cancels first. Carries the last assistant message as `summary`. |
| `prompt_submit` | Re-emitted every `heartbeatMs` (default 15000) while a turn is active, so Warp does not decide the session went idle mid-task. Paused for blocking tools, stopped at turn end. |

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
| OSC 0 | `ESC ] 0 ; <title> BEL` | writing the animated tab title |
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
