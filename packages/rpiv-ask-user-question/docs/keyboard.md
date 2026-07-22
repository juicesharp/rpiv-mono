# Keyboard and dialog layout

Every key the questionnaire dialog reacts to, the rows it appends for you, and how it
adapts to the size of your terminal.

## Keys

| Key | What it does | Where it applies |
| --- | --- | --- |
| `↑` / `↓` | Move between rows. Wraps at both ends. | Option list, Submit picker |
| `Enter` | Confirm the focused option, commit typed text, or activate the focused Submit-picker row. | Everywhere |
| `Esc` | Cancel the whole questionnaire. | Everywhere except the notes editor, where it closes notes |
| `Tab` / `Shift+Tab` | Next / previous tab, wrapping. `→` / `←` do the same. | Multi-question dialogs only |
| `Space` | Toggle the focused checkbox. | Multi-select questions |
| `n` | Open the notes editor for the current question. | Every question tab |
| `Ctrl+]` | Collapse or expand the dialog. Configurable via `collapseKey`. | Everywhere, including while collapsed |

In a multi-select question, `Enter` on a regular row toggles its checkbox exactly like
`Space` — it does not submit. Committing the question means focusing the `Next` row and
pressing `Enter`. That is deliberate: it makes `Enter` a zero-cost way to flip boxes
without leaving the home row.

`Space` is suppressed on two rows: `Next` (it is a command, not a choice) and
`Type something.` (it is an inline text input, so the space character belongs to your
answer).

## The rows the dialog adds

| Row | Label | Appended to |
| --- | --- | --- |
| Custom answer | `Type something.` | Every question — single-select and multi-select, with or without previews |
| Commit | `Next` | Multi-select questions only |

Focusing `Type something.` switches the row into an inline text input. In preview mode it
expands to the full pane width while you type, so a long custom answer is not squeezed
into the narrow options column. Confirming it produces an answer of `kind: "custom"`.

Both labels are reserved — the model cannot author an option that collides with them.
Both localize with the rest of the UI chrome; the reserved-label check always compares
against the canonical English strings.

## Notes

`n` opens a notes editor on any question tab, whether the question is single- or
multi-select and whether or not its options carry previews. Notes are stored in a
side-band keyed by tab index, not inside the answer, so writing a note does not mark a
question as answered — the Submit tab still lists it as outstanding. The note merges into
the answer when you confirm it, and reaches the model as `user notes: <text>`.

Inside the editor, `Esc` and `Enter` both close it and every other keystroke goes to the
text buffer, so `n` types an `n`.

## Collapse mode

`Ctrl+]` gets the dialog out of the way: the overlay is marked hidden in Pi's overlay
stack and shrinks to a single dim hint row, so the transcript it was covering becomes
readable and chat scrolling resumes. Press the same key to bring the questionnaire back
with your answers intact. The first time you collapse, Pi notifies you with the key to
press — that message names your configured key.

Because Pi routes no input to a hidden overlay, the collapse key is additionally captured
at the raw terminal level. It only acts when the questionnaire is hidden or focused, so a
different overlay on top of it (for example `/btw`) keeps its keystrokes.

While collapsed, every keystroke other than cancel is ignored, so you cannot mutate
answers you cannot see.

The default `ctrl+]` is free in Terminal.app, iTerm2, Warp, tmux, zellij and screen. On
keyboard layouts where `]` sits on the shifted layer — Latin American `es-AR` / `es-MX`,
among others — set a different `collapseKey`, or `"off"` to disable the shortcut.

## Layout

Options render in a vertical list. When any option in a single-select question carries a
`preview`, the dialog splits into a side-by-side layout with the option list on the left
and a bordered monospace preview box on the right — but only when both the terminal and
the dialog pane are at least 100 columns wide. Below that, the preview stacks underneath
the options instead.

When the dialog is taller than the terminal, the body scrolls between a sticky heading and
a sticky footer, and an overflow indicator shows which direction is clipped: `↑` for
content above, `↓` for content below, `↕` for both.

The footer hint line adapts to context — it drops the notes hint while the notes editor or
the inline input has the keyboard, and adds the tab hint only in multi-question dialogs.
On narrow terminals the collapse hint at the end of the line clips with `…` so the core
hints survive.
