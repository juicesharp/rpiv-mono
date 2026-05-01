# rpiv-args

<a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-args">
  <picture>
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-args/docs/cover.png" alt="rpiv-args cover" width="100%">
  </picture>
</a>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-args.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-args)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Pass arguments to your skills like a shell command. `rpiv-args` adds `$1`, `$ARGUMENTS`, `$@`, `${@:N}`, and `${@:N:L}` placeholders to [Pi Agent](https://github.com/badlogic/pi-mono) skills — write `/skill:deploy api production` and your skill body sees `$1` = `api`, `$2` = `production`. Skills without placeholders are untouched, so installing `rpiv-args` is safe for any existing skill collection.

## Install

```bash
pi install npm:@juicesharp/rpiv-args
```

Or run `/rpiv-setup` if you have `@juicesharp/rpiv-pi` installed.

## Placeholders

| Placeholder | Replaced with | Example |
|---|---|---|
| `$1`, `$2`, … | Positional argument (1-indexed) | `/skill:foo a b c` → `$1` = `a`, `$2` = `b` |
| `$ARGUMENTS` | All arguments as a single string | `/skill:foo a b c` → `a b c` |
| `$@` | Same as `$ARGUMENTS` | `/skill:foo a b c` → `a b c` |
| `${@:N}` | Arguments from position N onward | `/skill:foo a b c` → `${@:2}` = `b c` |
| `${@:N:L}` | L arguments starting at position N | `/skill:foo a b c d` → `${@:2:2}` = `b c` |

**Indexing is 1-based** — `$1` is the first argument, `$2` is the second.
Out-of-range positions resolve to an empty string. For `${@:N[:L]}`, `N` is
clamped to `≥ 1` and out-of-range slices yield an empty string.

Multi-word values use shell-style quoting:

```
/skill:deploy "staging server" --force
```

→ `$1` = `staging server`, `$2` = `--force`, `$ARGUMENTS` = `staging server --force`

## How it works

rpiv-args intercepts the `input` event (fires before Pi's built-in skill
expansion). When a skill body contains at least one placeholder, the extension:

1. Parses arguments using shell-style quoting
2. Substitutes all placeholders in the body
3. Wraps the result in a `<skill>` block byte-identical to Pi's native format
4. Appends the raw arguments after the block — matches Pi's standard output so any tool that parses `<skill>` blocks continues to work unchanged

When no placeholders are found in the skill body, the output is byte-identical
to Pi's built-in expansion — zero behavioral change.

## Writing skills with arguments

### `$ARGUMENTS` vs `$1` — which to use

Use **`$ARGUMENTS`** (or `$@`) when the input is freeform text the LLM should
interpret naturally:

```yaml
---
name: fix-issue
description: Fix a GitHub issue by number or description
---

Fix the following issue: $ARGUMENTS
```

```
/skill:fix-issue login page crashes on mobile
```

→ `Fix the following issue: login page crashes on mobile`

Use **`$1`, `$2`** only for skills with a fixed, structured invocation pattern:

```yaml
---
name: migrate-component
description: Migrate a component between frameworks
---

Migrate the $1 component from $2 to $3.
Preserve all existing behavior and tests.
```

```
/skill:migrate-component SearchBar React Vue
```

→ `Migrate the SearchBar component from React to Vue.`

### Why this matters

If a positional skill receives natural language input:

```
/skill:migrate-component can you migrate the search bar please
```

→ `Migrate the can component from you to migrate.` — **broken**.

The LLM is good at interpreting `$ARGUMENTS` as a whole, but positional
placeholders blindly split on spaces. Use `$ARGUMENTS` unless your skill has
a strict arg structure.

### `argument-hint` frontmatter

Add an `argument-hint` to document what the skill expects:

```yaml
---
name: fix-issue
description: Fix a GitHub issue
argument-hint: [issue-number-or-description]
---
```

```yaml
---
name: migrate-component
description: Migrate a component between frameworks
argument-hint: [component] [from] [to]
---
```

rpiv-args ignores this field — substitution is triggered by placeholders in the body, not the hint.

**Note**: Pi currently surfaces `argument-hint` in autocomplete for prompt
templates (`commands/*.md`) but **not** for skills (`/skill:<name>`). The
field is read by Pi but not displayed in the `/skill:` autocomplete UI at
present — treat it as documentation metadata until upstream Pi exposes it.

### Full example

<details>
<summary>Deploy skill — SKILL.md, invocation, and the exact text the LLM sees</summary>

```yaml
---
name: deploy
description: Deploy a service to an environment
argument-hint: [service] [environment]
---

Deploy service $1 to $2.

## Steps
1. Run the test suite for $1
2. Build the Docker image
3. Push to the $2 registry
4. Verify the deployment
```

```
/skill:deploy api production
```

→ The LLM receives:

```xml
<skill name="deploy" location="...">
Deploy service api to production.

## Steps
1. Run the test suite for api
2. Build the Docker image
3. Push to the production registry
4. Verify the deployment
</skill>

api production
```

Note: the raw arguments (`api production`) are also appended after the
`</skill>` block — this is Pi's standard behavior and is preserved for
backward compatibility.

</details>

## Backward compatibility

- Skills **without** placeholders → output is byte-identical to Pi's built-in expansion
- Skills **with** placeholders → body gets substitution, raw args still appended after block
- The `argument-hint` frontmatter field is read but not enforced in v1

## Limitations

| Limitation | Detail |
|---|---|
| **No type validation** | `$1` expecting a file path receives whatever the user types |
| **No flag parsing** | `--env=prod` is a single positional token, not a parsed flag |
| **Literal substitution** | Placeholders are replaced even inside code blocks and inline code |
| **`steer()`/`followUp()` paths** | `session.steer()` / `session.followUp()` bypass the `input` event (see `agent-session.js:861-887`); placeholders are **not** resolved on those paths. Use the primary prompt path for argument-substituted skills. |
| **No recursive substitution** | A `$ARGUMENTS` value containing `$1` is not re-expanded |

## License

MIT
