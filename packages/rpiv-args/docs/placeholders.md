# Placeholders and variables

Complete reference for every token `rpiv-args` substitutes into a skill body:
the positional argument family, the slice forms, and the always-on runtime
variables.

## Argument placeholders

Substitution runs only when the skill body contains at least one of these
tokens. A body with none of them is passed through untouched.

| Placeholder | Replaced with | Example (`/skill:foo a b c d`) |
| --- | --- | --- |
| `$1`, `$2`, … `$N` | The Nth argument, 1-indexed | `$2` → `b` |
| `$ARGUMENTS` | All arguments joined by a single space | `a b c d` |
| `$@` | Identical to `$ARGUMENTS` | `a b c d` |
| `${@:N}` | Arguments from position N onward | `${@:2}` → `b c d` |
| `${@:N:L}` | L arguments starting at position N | `${@:2:2}` → `b c` |

### Indexing rules

- Indexing is **1-based**: `$1` is the first argument.
- An out-of-range position resolves to an **empty string**, not to a literal
  `$3`. `/skill:foo a` leaves `$2` as `""`.
- Digits are matched greedily: `$11` is the eleventh argument, never `$1`
  followed by a literal `1`.
- In `${@:N}` and `${@:N:L}`, `N` is clamped to `≥ 1`, so `${@:0}` returns the
  whole argument list. A slice that starts past the end of the list produces
  an empty slice, which joins to an empty string.

### Substitution order

Replacements are applied in a fixed order: `$N` first, then `${@:N[:L]}`, then
`$ARGUMENTS`, then `$@`.

The order is load-bearing. Because `$N` runs first, an argument value that
itself contains `$1` is **not** re-expanded when it lands in the body via
`$ARGUMENTS` or a slice. There is no recursive substitution.

## Argument tokenisation

The argument string after `/skill:<name> ` is split shell-style:

- Splits on spaces **and** tabs; runs of whitespace collapse.
- Both `"` and `'` quote a multi-word value.
- Quote styles can mix inside one token: `"a b"c` produces the single
  argument `a bc`.
- An unmatched quote flushes what it has instead of raising an error.

```
/skill:deploy "staging server" --force
```

→ `$1` = `staging server`, `$2` = `--force`, `$ARGUMENTS` = `staging server --force`

Arguments are always plain strings. There is no type validation and no flag
parsing — `--env=prod` is one positional token, not a parsed option.

## Runtime variables

These are substituted on **every** invocation, whether or not the body uses
argument placeholders.

| Variable | Replaced with |
| --- | --- |
| `${SKILL_DIR}` | Absolute path of the directory containing the skill file |
| `${SESSION_ID}` | The current Pi session id |

`${SKILL_DIR}` is always `dirname()` of the skill file itself, so a skill can
reference a sibling asset (`${SKILL_DIR}/template.md`) regardless of how the
skill was installed — filesystem skill directory, plugin, or a skill declared
by another extension's `pi.skills` manifest. On Windows the value is
normalised to forward slashes; on POSIX the path is preserved byte for byte,
including literal backslashes.

Unknown `${FOO}` placeholders are left in the body untouched.

## What substitution does not do

| Limit | Detail |
| --- | --- |
| No type validation | `$1` receives whatever the user typed; a skill expecting a path can get a sentence |
| No flag parsing | `--force` is a positional token like any other |
| Literal substitution | Placeholders are replaced inside fenced code blocks and inline code too — there is no fence awareness |
| No recursive substitution | A value containing `$1` is never re-expanded |
| Body-token trigger only | There is no `arguments:` frontmatter key; substitution keys off tokens present in the body |
