# Shell substitution

Complete reference for `` !`command` `` and ```` ```! ```` blocks in skill
bodies: syntax, execution order, timeouts, error text, output budgets, and
cross-platform authoring.

## Syntax

| Form | Behaviour |
| --- | --- |
| `` !`command` `` | Inline. Single line only — the pattern never crosses a newline. Requires at least one character between the backticks, so a literal empty `` !`` `` in prose is left verbatim and never executed. |
| ```` ```!\n…\n``` ```` | Block. Multi-line; newlines are preserved and the whole block is handed to the shell as one program. |

Both forms run on **every** invocation of the skill, whether or not the body
uses `$N` / `$ARGUMENTS` placeholders. The command's output replaces the
`` !`…` `` or fence in the body before the model sees anything.

## Execution semantics

- **Working directory** — every command runs in `process.cwd()`, the Pi
  session's working directory. Not the skill directory. Use `${SKILL_DIR}` if
  you need a skill-relative path.
- **Sequential** — commands in one body run one at a time, in source order,
  never in parallel. `` !`mkdir x` `` followed by `` !`ls x` `` is safe.
- **Blocks before inlines** — fenced blocks execute first and their output is
  masked while the inline pass runs, so block stdout that happens to contain
  `` !`something` `` is never re-executed.
- **Shell** — `sh -c` on macOS and Linux, `powershell.exe -Command` on
  Windows.

## Timeouts

`shell-timeout` in the skill's own frontmatter sets the ceiling, in **seconds**,
for every command in that skill.

```yaml
---
name: commit
description: Draft a commit message from the working tree
shell-timeout: 30
---
```

| Value | Effect |
| --- | --- |
| absent | 120 s (the default) |
| positive number (`5`, `0.5`) | Converted to milliseconds; sub-second values are honoured |
| `0` | Timer disabled — no timeout |
| negative, string, `true`, `.nan`, `.inf` | Silent fallback to 120 s |

A timed-out command is reported as `[Shell error: timed out after Ns]`. The
displayed seconds value is floored at `1`, so a `shell-timeout: 0.5` timeout
still reads `after 1s`.

## Errors and output budget

Errors are inlined into the body, so the rest of the skill still reaches the
model:

| Situation | Text substituted into the body |
| --- | --- |
| Timeout | `[Shell error: timed out after Ns]` |
| Non-zero exit | `[Shell error: exit code N]` followed by the command's stderr |
| Success with stderr output | stdout, then `[stderr]` on its own line, then stderr |

Timeout wins over exit code: a killed command reports the timeout message even
if it also produced a non-zero code.

Output is capped at **50 KB / 2000 lines**, tail-truncated — the *end* of the
output survives, which is where failures usually appear. When truncation
happens a footer is appended: `[truncated: hit 2000 lines]` or
`[truncated: hit 50.0KB]`. The cap applies to the non-zero-exit path too, so
a multi-megabyte stderr from a failed `` !`npm test` `` cannot blow past the
budget.

## Trust model

Substitution order is arguments → variables → shell. An argument that contains
`` !`echo hi` `` and lands in the body through `$ARGUMENTS` will therefore be
executed. This is deliberate: skill bodies and the local user are trusted, and
a skill author who interpolates arguments is interpolating into a program.
Treat `/skill:` invocations with the same trust you give your own shell.

## Cross-platform authoring

On Windows each command runs through `powershell.exe -Command`; on macOS and
Linux through `sh -c`. Many POSIX utilities work on both because PowerShell
exposes them as aliases:

| POSIX command | On Windows |
| --- | --- |
| `ls`, `cat`, `pwd`, `cp`, `mv`, `rm`, `mkdir` | Works — PowerShell aliases of `Get-ChildItem`, `Get-Content`, etc. |
| `git`, `npm`, `node`, `python` | Works — external binaries on `PATH` |
| `grep`, `sed`, `awk`, `find`, `xargs` | Not aliased — use PowerShell equivalents such as `Select-String` |

**POSIX flags are not translated.** Aliases match command *names* only.
`` !`rm -rf x` `` fails under PowerShell, which expects `-Recurse -Force`. For
flag-heavy or destructive commands prefer external binaries (`git`, `npm`,
`node`) or write a PowerShell-flavoured ```` ```! ```` block.

**Exit-code quirk.** External commands propagate their exit code, so
`` !`git status` `` reports failure correctly. PowerShell *cmdlet* errors
return exit 0 by default. If a skill depends on a cmdlet failure being
visible, prepend `$ErrorActionPreference = "Stop"; ` or pass
`-ErrorAction Stop` per cmdlet.
