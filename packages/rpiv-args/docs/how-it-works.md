# How rpiv-args works

The internals: which Pi events the extension hooks, how a `/skill:` message is
transformed, what exactly it emits, and which paths it does not cover.

## Surface

`rpiv-args` registers no slash commands, no tools and no keybindings. Its
entire surface is three Pi event hooks.

| Hook | What it does |
| --- | --- |
| `input` | Intercepts `/skill:<name> <args>` before Pi's built-in expander, runs the pipeline, and returns transformed text |
| `before_agent_start` | Prepends a `## Skill invocation protocol (CRITICAL)` section to the system prompt, every turn |
| `session_start` | Rebuilds the skill index when the session reason is `reload` or `startup` |

## Input dispatch

The `input` handler takes one of four branches:

1. Text already starts with `<skill ` → passed through untouched. This is the
   re-entrancy guard: text transformed by this or any other extension is not
   reprocessed.
2. Text does not start with `/skill:` → passed through untouched.
3. The skill name is unknown, or the skill file cannot be read → passed
   through, so Pi emits its own handling or error.
4. Known skill → transformed.

## Pipeline

For a known skill, in this order:

1. Read the skill file and split frontmatter from body.
2. Record whether the body contains any argument placeholder — this flag is
   captured **before** substitution and decides the emit path.
3. If it does, tokenise the argument string shell-style and substitute
   `$N` / `${@:N[:L]}` / `$ARGUMENTS` / `$@`.
4. Substitute `${SKILL_DIR}` and `${SESSION_ID}` — always, on both paths.
5. Execute `` !`cmd` `` and ```` ```! ```` blocks — always, on both paths.
6. Wrap the result in a `<skill name="…" location="…">` block byte-identical
   to Pi's native format, and append the trailer.

## Emit paths

| Body | Emitted after `</skill>` |
| --- | --- |
| No argument placeholders | Blank line, then the raw argument string — the suffix is byte-identical to Pi's built-in expansion |
| Has argument placeholders | Blank line, then `Skill input: <raw args>` |
| Either, invoked with no arguments | Nothing; the text ends at `</skill>` |

A body with no argument placeholders, no `${…}` variables and no shell syntax
emits bytes identical to Pi's built-in expansion; that is pinned by a
regression test, and it is what makes installing the extension a no-op for
existing skill collections. Bodies that do use variables or shell syntax still
get steps 4 and 5 on this path — `hadTokens` governs the trailer only, not the
substitution pipeline.

The trailer always carries the **raw**, un-substituted argument string. If a
user types `${SKILL_DIR}` as an argument, the occurrence woven into the body
is substituted while the trailer keeps the literal text.

## The `Skill input:` trailer and the protocol block

Bare trailing text after `</skill>` reads to a model like a second, separate
instruction — especially when the argument is phrased as an imperative
("delete the old migrations"). Two things fix that together:

- the labelled `Skill input:` trailer on the placeholder path, and
- the `## Skill invocation protocol (CRITICAL)` section prepended to the
  system prompt on every turn, which tells the model that text after
  `</skill>` is argument input to the skill, never a separate command, and
  that the same value may also appear substituted inside the body.

The label string is a cross-package contract: `@juicesharp/rpiv-pi`'s lane
transcript and `@juicesharp/rpiv-warp`'s toast summariser both strip
`Skill input:` for display using a literal regex. Changing the label requires
changing them too.

## Skill index

The name → file-path index is built lazily from Pi's command registry the
first time a `/skill:` message arrives, then memoised for the session. It is
sourced from the registry rather than from a filesystem walk, so it also
recognises skills declared by another extension's `pi.skills` manifest.

That also means `sendUserMessage("/skill:… ")` calls made programmatically by
other extensions are expanded: those bypass Pi's built-in expander, leaving
`rpiv-args` as the only expander on that path.

The index is invalidated on `session_start` with reason `reload` or `startup`.
Other reasons — resuming a session, for example — keep the cached index.

## Paths not covered

`session.steer()` and `session.followUp()` do not go through the `input`
event, so placeholders are not resolved on those paths. Use the primary
prompt path for argument-substituted skills.
