# rpiv-goal

`@solforged/rpiv-goal` is a small Pi extension for one session-scoped objective.
It keeps the agent under an active `/goal` until the agent calls
`goal_complete`, the user pauses or clears it, the run is interrupted, or a
guard stops continuation.

It is intentionally narrower than a task list or workflow runner: goal owns the
objective, `rpiv-todo` owns decomposition, and `rpiv-workflow` owns phased
pipelines.

## Install

```bash
pi install npm:@solforged/rpiv-goal
```

Try locally from this repository:

```bash
pi -e ./packages/rpiv-goal
```

## Commands

```text
/goal
/goal implement the missing validation and verify it
/goal --tokens 100k fix the failing test
/goal status
/goal edit ship the smaller fix first
/goal pause
/goal resume
/goal clear
```

- `/goal <objective>` starts goal mode. Replacing an unfinished goal asks for
  confirmation.
- `/goal --tokens 100k <objective>` adds a token budget.
- `/goal edit <objective>` changes the objective without resetting usage.
- `/goal pause` stops prompt injection and auto-continuation.
- `/goal resume` restarts a paused or budget-limited goal.
- `/goal clear` removes the current goal from the session.

## Completion

The extension registers one agent tool:

```json
{
  "summary": "What changed.",
  "evidence": "Tests, files, command output, or other proof."
}
```

`goal_complete` terminates the turn. The prompt tells the agent to call it only
after every explicit requirement is satisfied and verified.

## Guards

- State is stored in Pi session custom entries, not project files.
- Active goals are replayed on reload, compaction, and session tree navigation.
- Continuation prompts are skipped when messages are pending.
- Aborted or errored assistant turns pause the goal.
- Empty turns pause the goal instead of looping forever.
- A hard continuation limit prevents runaway sessions.

## Package shape

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

The package publishes raw TypeScript like the rest of `rpiv-mono`.
