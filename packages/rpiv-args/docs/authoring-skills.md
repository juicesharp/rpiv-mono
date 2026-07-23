# Writing skills that take arguments

How to choose between freeform and positional arguments, what the model
actually receives, and the frontmatter that affects it.

## `$ARGUMENTS` vs `$1` — which to use

Use **`$ARGUMENTS`** (or `$@`) when the input is freeform text the model
should interpret as a whole:

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

Use **`$1`, `$2`** only when the skill has a fixed, structured invocation:

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

### Why the choice matters

Positional placeholders split blindly on whitespace. If a positional skill
receives natural language:

```
/skill:migrate-component can you migrate the search bar please
```

→ `Migrate the can component from you to migrate.` — broken.

Prefer `$ARGUMENTS` unless the invocation really is structured. When you do
use positionals, document the shape in `description` and expect users to quote
multi-word values (`/skill:deploy "staging server" production`).

## Empty arguments

When a skill is invoked with no arguments, the emitted text ends at
`</skill>` — no trailing argument text and no `Skill input:` line at all. A
skill that has an "if no input was given" branch can rely on that absence.

## Worked example

```yaml
---
name: deploy
description: Deploy a service to an environment
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

The model receives:

```
<skill name="deploy" location="/path/to/deploy/SKILL.md">
References are relative to /path/to/deploy.

Deploy service api to production.

## Steps
1. Run the test suite for api
2. Build the Docker image
3. Push to the production registry
4. Verify the deployment
</skill>

Skill input: api production
```

The `Skill input:` trailer carries the **raw**, un-substituted argument string.
It appears only when the body contains argument placeholders; a body with no
placeholders gets the bare argument string after the block instead, exactly as
Pi's built-in expansion emits it.

## Frontmatter

| Key | Effect |
| --- | --- |
| `shell-timeout` | Per-skill ceiling in seconds for `` !`cmd` `` / ```` ```! ```` execution. See [shell-substitution.md](shell-substitution.md). |
| `argument-hint` | Not read by `rpiv-args`. Substitution is triggered by placeholders in the body, never by a hint. Treat it as documentation for readers of your skill. |

There is no `arguments:` key and no required-argument enforcement: a skill
cannot declare that `$1` is mandatory, and nothing fails when it is missing —
the placeholder simply resolves to an empty string.

## Skill-relative assets

Use `${SKILL_DIR}` to point at files shipped next to the skill:

```md
Follow the checklist in ${SKILL_DIR}/checklist.md before editing anything.
```

`${SKILL_DIR}` resolves to the directory of the skill file itself, so the same
skill works whether it was loaded from a skills directory, a plugin, or
another extension's `pi.skills` manifest.

## New skills are picked up on reload

The skill index is built once per session and cached. After adding or renaming
a skill file, run `/reload` (or start a new session) so the index is rebuilt.
