---
title: "v2.15: a questionnaire for every keyboard"
description: "v2.14.1 through v2.15.0 make ask_user_question work on Kitty-protocol terminals and non-Latin layouts, add digit keys and a readable answer receipt, steady the advisor, and fix three ways a workflow run could stop for the wrong reason."
pubDate: 2026-10-24T02:00:00Z
author: juicesharp
tags: ["release", "rpiv-ask-user-question", "rpiv-advisor", "rpiv-pi"]
draft: false
---

This post covers three releases: v2.14.1, v2.14.2 and v2.15.0. They are mostly
fixes, plus two small features in the questionnaire. Nothing needs migrating.

One thing behaves differently on purpose: on a single-choice question, pressing
a digit now answers it. More on that below.

To get everything:

```
pi update --extensions
```

Plain `pi update` now updates Pi itself; `pi update --all` does both.

## Keys that work on every keyboard

`ask_user_question` is the dialog the model opens when it would otherwise
guess. Three fixes make it answer to your keyboard, whatever it is.

**Kitty-protocol terminals.** Pi switches on the Kitty keyboard protocol when
the terminal supports it: Kitty, Ghostty, WezTerm and others. Some of them
then send Space and `n` as escape sequences instead of plain characters. The
questionnaire compared the raw characters, so Space did not tick a checkbox and
`n` did not open notes. Arrows and Tab already went through pi-tui's key
matcher and kept working. Space and `n` now do too. Thanks to bumaociyuan, who
first reported it and then rebased the fix with tests
([#287](https://github.com/juicesharp/rpiv-mono/pull/287)).

**Non-Latin layouts.** On a Cyrillic layout, the key that types `n` types `т`.
Pi's key parser only knows Latin keys, so the notes shortcut never fired. There
is now a `notesKey` setting. Set it to the character your keyboard types:

```json
{ "notesKey": "т" }
```

Any single character works, in any script. A key spec such as `"ctrl+n"` works
too, and on Kitty-protocol terminals it matches on non-Latin layouts as well,
because the terminal also reports the key's Latin equivalent. The hints in the
dialog show whichever key you set, in all nine languages. The default is still
`n`. Thanks to Robert322-ai for the report
([#294](https://github.com/juicesharp/rpiv-mono/issues/294)).

The file is `~/.config/rpiv-ask-user-question/config.json`, next to
`collapseKey`.

**Digit keys.** The options are numbered `1.`, `2.`, `3.`, and pressing the
number now does what you expect:

- On a single-choice question, a digit answers with that row, just like Enter
  on it. In a one-question dialog, that closes the dialog.
- On a multi-select question, a digit ticks or unticks that row.
- The `Type something.` row's digit moves you there so you can type.

Inside `Type something.` and the notes editor, digits are text, so typing `42`
still types `42`. `Next` has no number, and a digit you have bound to a Pi
action keeps that action. In a multi-question dialog, `2` means row 2, not
question 2. Thanks to hank-warren, who traced the key routing to show it was
safe ([#163](https://github.com/juicesharp/rpiv-mono/issues/163)).

This is the behaviour change mentioned above: a digit that used to do nothing
now answers a single-choice question.

**The cursor stays on your answer.** Go back to a question you already
answered, and the cursor now lands on your answer instead of the first option.
A habitual Enter used to replace your answer with option 1. A question answered
with typed text still starts at the first option, so Tab and the arrows keep
moving between questions instead of editing your text. Thanks to xz-dev
([#281](https://github.com/juicesharp/rpiv-mono/pull/281)).

## A record you can read

Scroll back after a questionnaire, and you used to find a JSON dump of the
questions and the full text written for the model, preview blocks included.
Now the history shows what you actually picked:

```
Ask Config format · Data migration · Rollback plan
  Config format    TOML
                   ✎ we already use it in the CLI
  Data migration   Schema, Data, "seed fixtures"
  Rollback plan    not answered
  ✎ ship behind a flag
```

A single question takes two lines: `Ask Format`, then `✓ TOML`. Typed answers
are in quotes, `(Recommended)` is dropped, and skipped questions say so. Press
Ctrl+O to see each full question and the preview you chose. A declined
questionnaire shows `✗ no answer`, and an error shows `✗` with its first line.

Only the display changed. The model gets exactly the same text as before.

The design came from two directions: samuhlo's PR, which showed only the
answers ([#231](https://github.com/juicesharp/rpiv-mono/pull/231)), and
OliverFGBKB's proposal for the aligned table, which they had been running as a
separate extension ([#292](https://github.com/juicesharp/rpiv-mono/issues/292)).
Thanks to both.

## A steadier advisor

**It no longer gives up on the first hiccup.** One "servers are currently
overloaded" reply used to end the consultation with `Advisor call failed`.
The advisor now retries temporary errors (overloaded servers, rate limits,
dropped connections) using your Pi `retry` settings, the same ones Pi applies to
its own turns. By default that is three retries with growing waits.
`"retry": { "enabled": false }` turns it off. An invalid key or an exhausted
quota still fails straight away. This needs Pi 1.0 or later; older Pi calls
once, as before. Thanks to CovetingEpiphany2152
([#191](https://github.com/juicesharp/rpiv-mono/issues/191)).

**It has its own session id.** Advisor calls now send `advisor-<session id>`.
On OpenAI-family providers, repeated consultations hit the prompt cache instead
of re-reading the whole context, and OpenCode no longer rejects every call with
`MissingSessionID`. The id is separate from the main agent's, so the two never
share a cache key or a Codex connection. Its resources are released when the
session ends, so headless `pi -p` runs exit promptly. Thanks to piousp for the
fix, and Marsor707, SlanyCukr and draculalaa for the investigation
([#236](https://github.com/juicesharp/rpiv-mono/issues/236)).

## Workflow runs that stopped for the wrong reason

Four fixes in rpiv-pi, each from a real run that stopped when it should not
have.

- **Large plans ran out of memory.** On the second grading pass, comparing a
  plan with its saved copy built one table cell per pair of lines: about 14 GiB
  for a 43,000-line plan. The comparison now works section by section; that
  plan takes about 50 ms. Thanks to 37 for the diagnosis and the fix
  ([#226](https://github.com/juicesharp/rpiv-mono/issues/226)).
- **`validate` failed on its own report** when the plan's topic contained an
  em dash, parentheses or a comma, because it built the filename from the
  topic. It now uses the plan's filename. Thanks to mikenerone
  ([#314](https://github.com/juicesharp/rpiv-mono/issues/314)).
- **A stage failed after the agent cited a missing file.** The stage took the
  last path the agent mentioned, so a misremembered path in a trailing
  "Sources:" line replaced the file it had actually written. A path that is not
  on disk now gives way to the newest one that is. Thanks to
  linuxtextadventurer
  ([#187](https://github.com/juicesharp/rpiv-mono/issues/187)).
- **The plan gate looped on a Makefile.** A risk ruling that cited
  `scripts/Makefile:18` as evidence was rejected, because extensionless files
  did not count, and re-ruled until the run stopped. A path with a `/` now
  counts. Thanks to daniel-sampliner
  ([#286](https://github.com/juicesharp/rpiv-mono/pull/286)).

## Smaller fixes

- **rpiv-todo shows failures as failures.** A broken `todo` call rendered as
  `todo undefined ✓`, and a rejected update showed the status it asked for.
  It now shows `✗` with the reason. Thanks to catch6
  ([#175](https://github.com/juicesharp/rpiv-mono/issues/175)).
- **rpiv-todo survives a corrupted save.** A session whose saved task list
  another extension had truncated used to crash the overlay on resume. Replay
  now skips a malformed snapshot and keeps the last good list. Thanks to
  pstanton237 ([#230](https://github.com/juicesharp/rpiv-mono/pull/230)).
- **rpiv-warp works with Pi 1.2.** Runs an extension starts without a prompt no
  longer blank the Warp tab's query. Thanks to jagaliano
  ([#305](https://github.com/juicesharp/rpiv-mono/pull/305)).
- **rpiv-web-tools reads `YDC_API_KEY`**, You.com's own name for its key, so one
  exported key works across tools. `YOUCOM_API_KEY` still wins when both are
  set. Thanks to brainsparker
  ([#90](https://github.com/juicesharp/rpiv-mono/pull/90)).

## Try it

Ask the model something with options:

```
Use ask_user_question to ask me which config format to use: TOML, YAML or JSON.
```

Press `2`. Then scroll up and look at the record it left.
