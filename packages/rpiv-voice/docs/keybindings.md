# Keys and screens

Every key the `/voice` overlay reacts to, on both of its screens, and what the footer
hint line is telling you at the time.

## The two screens

`/voice` opens on the **dictation** screen. `Tab` flips to the **settings** screen and
`Tab` (or `Esc`) flips back. The overlay stays open across the flip — the microphone
keeps running and the session timer keeps counting while you are in settings.

## Dictation screen

| Key | Action |
| --- | --- |
| `Enter` | Close the overlay and paste the transcript into Pi's editor |
| `Esc` | Close the overlay and paste nothing |
| `Space` | Pause / resume |
| `Tab` | Open the settings screen |

Footer: `Enter to paste · Space to pause · Tab for settings · Esc to cancel`. The second
hint reads `Space to resume` while you are paused.

Any other keystroke is ignored — there is no text input on this screen.

## Settings screen

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move focus between the two toggles. Wraps at both ends |
| `Enter` | Toggle the focused setting |
| `Ctrl-S` | Save to disk and confirm with a `Voice settings saved` notification |
| `Esc` | Return to dictation |
| `Tab` | Return to dictation |

Footer: `↑↓ to select · Enter to toggle · Ctrl-S to save · Esc to go back`.

Focus starts on **Filter Whisper noise** and cycles between it and **Equalizer**. The
**Microphone** and **Language** rows are read-only and are skipped by focus.

`Esc` and `Tab` persist your changes silently on the way out, so a
toggle-then-leave flow never loses the change. `Ctrl-S` is the explicit path that also
tells you it worked — and only tells you when the disk write actually succeeded. If the
write fails, either path notifies
`Failed to save voice settings — change not persisted` at error level.

## `Enter` and `Esc` follow your Pi keybindings

Confirm and cancel are not hardcoded. They route through Pi's configurable keybinding
names:

| Binding name | Pi default | Dictation | Settings |
| --- | --- | --- | --- |
| `tui.select.confirm` | `Enter` | Paste and close | Toggle focused setting |
| `tui.select.cancel` | `Esc` / `Ctrl-C` | Cancel and close | Return to dictation |

If you have remapped either binding, `/voice` follows the remap — your cancel key still
cancels, and the footer hints still say `Enter` / `Esc` because they are static labels.

`↑`, `↓`, `Tab`, `Space` and `Ctrl-S` are hardcoded and are not affected by Pi
keybindings — remapping `tui.select.up` / `tui.select.down` does not move settings focus.

## What `Enter` actually pastes

The transcript has two parts on screen: committed text, and a dim trailing partial. The
partial is a rolling re-decode of the utterance you are still speaking, refreshed about
once a second.

`Enter` pastes **both**, joined with a space. That is deliberate — waiting for a final
decode of the open utterance would add half a second to two seconds between your
keypress and the paste, and the partial is already a complete Whisper reading of that
audio. So you can press `Enter` the moment you stop talking.

`Esc` discards everything, committed and partial alike. Nothing reaches the editor.

## What `Space` actually pauses

`Space` gates the speech-to-text pipeline, not the microphone. Audio keeps streaming, so
the level meter behind the equalizer stays live, but no audio is buffered for
recognition and no new text appears. The session timer stops accumulating and picks up
where it left off when you resume.

The equalizer, if you have turned it on, freezes and dims while paused instead of
animating against silence.
