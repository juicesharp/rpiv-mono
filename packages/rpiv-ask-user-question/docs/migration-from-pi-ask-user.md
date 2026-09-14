# Migration from pi-ask-user

Status: optional migration procedure. The lifecycle fixes described here require this
patched version; they are not present in published version 2.10.1.

## Ownership and connections

`pi-ask-user` supplies the `ask_user` tool and its bundled decision-gate skill.
This package supplies `ask_user_question`, with a different schema and event protocol.
The optional [Herdr adapter](./herdr-adapter.ts) forwards waiting-state events to
Herdr's managed integration. It does not send question or answer text.

```text
Decision-gate skill → ask_user_question → terminal UI or RPC dialogs → answer
                             ↓
                   rpiv:ask-user:blocked
                             ↓ optional adapter
                       herdr:blocked
                             ↓
                  Herdr managed integration
```

Do not edit Herdr's managed integration. Load the adapter exactly once. It balances
its own waiting-state contributions, including during extension shutdown/reload.

## Boundaries and prerequisites

- Keep the current installation until a separate terminal trial passes.
- Use a fresh Pi process for the trial. Existing sessions retain loaded code and prompts.
- Do not load both question tools in the same trial. They have competing guidance.
- Preserve any locally customized decision-gate policy before removing `pi-ask-user`.
  Its bundled skill disappears when that package is removed.
- The example [decision-gate skill](./decision-gate/SKILL.md) is opt-in. It is not
  registered automatically and must not override higher-priority host instructions.
- The adapter requires the existing Herdr integration. It does not create or control panes.
- Native RPC hosts must honor Pi's dialog `signal` option to dismiss pending dialogs.
  The extension checks abort state between dialogs and never accepts an aborted answer.

The reconciler restores only a tool that it previously removed because UI was absent.
It does not enable an initially excluded tool. Pi exposes no provenance for tool-list
changes while a tool is already absent; a new exclusion during that hidden interval
cannot be distinguished from the reconciler's own exclusion.

## Configure the trial

Use a separate `XDG_CONFIG_HOME` directory for this configuration. The global Pi
installation and its normal questionnaire configuration need not change.

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "promptSnippet": "Ask one focused question before making a consequential assumption.",
    "promptGuidelines": [
      "Gather evidence first. Summarize the relevant context in the conversation before opening the dialog.",
      "Ask exactly one focused question per call. Do not batch unrelated decisions.",
      "Supply 2–4 distinct options with short labels and clear descriptions. Do not author Other or Type something. rows; the tool appends its custom-answer row.",
      "Use multiSelect only for independent choices. Use previews only for concrete single-select comparisons.",
      "Cancellation or a tool error is not approval. Do not proceed with a consequential action without a clear decision."
    ]
  }
}
```

Save this as `<trial-config>/rpiv-ask-user-question/config.json`. These guidelines replace,
not append to, the package defaults. They preserve the one-question policy.

From a trusted, empty trial directory, launch an explicit-resource session. Replace all
placeholders with absolute paths. These commands are instructions, not an automatic installer.

```sh
XDG_CONFIG_HOME="<trial-config>" pi --no-extensions --no-skills \
  -e "<checkout>/packages/rpiv-ask-user-question/index.ts" \
  --skill "<checkout>/packages/rpiv-ask-user-question/docs/decision-gate/SKILL.md"
```

For the Herdr check, also explicitly load its existing managed integration and the adapter:

```sh
  -e "<existing-herdr-integration.ts>" \
  -e "<checkout>/packages/rpiv-ask-user-question/docs/herdr-adapter.ts"
```

Verify the loaded resources and tool list in the new process. `ask_user_question` should
be available; `ask_user` should not. Use the existing login rather than copying credentials.

## Acceptance before replacement

1. Ask one single-select question. Confirm the selected answer and optional note reach the model.
2. Compare two code previews at wide and narrow terminal sizes. Confirm neither is clipped
   in a way that prevents making the decision.
3. Enter multiline custom text. Browse away and back; confirm the draft survives.
4. Open the configured external editor. Confirm normal exit returns the text and restores input.
   Abort while editing: confirm Pi stays stopped until that process exits. Cancellation gives
   the editor one second after SIGTERM before SIGKILL; unsaved editor changes may be lost.
5. Select multiple choices. Confirm an empty selection and a custom answer remain distinguishable.
6. Cancel with Escape. Confirm the model does not treat cancellation as permission.
7. Abort the agent call while the overlay is visible and while it is collapsed. Put another
   extension's overlay above the questionnaire and repeat. Confirm only the questionnaire
   closes, the other overlay still works, and Herdr clears this call's blocked state after
   any active editor has exited.
8. Confirm Herdr's waiting state clears after submit, cancellation, error, and reload.
9. In the RPC client you actually use, abort a pending select and input dialog. Confirm
   it dismisses, does not open the next question, and ignores late replies.
10. Restart the trial. Confirm the expected tools, skill, shortcut, and guidance load again.

Automated coverage does not replace these terminal and client checks. In particular,
external-editor cancellation signals the directly spawned process; it does not guarantee
termination of detached descendants or Windows shell child trees.

## Product trade-offs

Every question requires 2–4 options. There is no standalone free-text prompt, separate
context parameter, timeout parameter, or inline-display option. Previews support single
selection only. RPC dialogs do not provide the TUI notes or review tab. Decide whether
these restrictions fit your everyday workflow before replacing the old package.

## Promotion and rollback

Replacement needs an explicit decision after the trial. At that point:

1. Save before-copies of the package settings, relevant instructions, and question-tool config.
2. Move the selected decision-gate skill to an independent user-owned location. Remove stale
   `ask_user` references only in instruction files you own; do not edit generated harness prompts.
3. Select the validated candidate, disable/remove the old package, and enable the adapter once.
4. Start a fresh process and repeat the tool-list and waiting-state checks.

For rollback, close the trial and resume normal Pi: no default settings changed during the
isolated trial. After a promoted replacement, restore the before-copies and the old package,
disable the candidate and adapter, then restart. Do not update dependencies beneath a live Pi process.
