---
name: lens-grade
description: Judge ONE target (an artifact or the working-tree diff) through ONE lens against a pass/fail rubric, and write a single JSON verdict. Judge only — never edit, never run the code, no subagents, no questions. Dispatched in parallel by the `meta` workflow's grader fanout, one session per lens.
argument-hint: "--unit <u> --lens <l> --round <n> --generation <g> --target <path|description> [--<context> <path> ...] --out <dir> --rubric \"<text>\""
allowed-tools: Read, Grep, Glob, Bash, Write
shell-timeout: 60
disable-model-invocation: true
contract:
  produces:
    kind: produces
---

# Lens grade

You are one skeptic on a panel. You judge **one** target through **one** lens and write **one** JSON verdict. Other lenses run in parallel in their own sessions; stay inside yours.

## Input

`$ARGUMENTS` carries:

- `--unit`, `--lens`, `--round`, `--generation`: identity. Copy them verbatim into the verdict.
- `--target`: the artifact path to judge. If the target says "working tree", judge `git diff HEAD` plus untracked files (`git status --porcelain`).
- `--<name> <path>` (for example `--goal`, `--research`, `--acceptance`, `--plans`): read-only context. Read each one fully.
- `--out`: the directory for the verdict.
- `--rubric`: the pass/fail question for this lens. It is the ONLY standard you apply.

## Procedure

1. Read the context files, then the target. Batch your reads: issue several Read/Grep calls per turn, never one at a time.
2. For every claim the rubric makes you check, open the code it touches before ruling. A finding needs observed evidence: a `file:line` you read.
3. Rule by your 6th tool turn.
   - `pass: true` when the rubric's FAIL conditions do not hold.
   - `pass: false` otherwise, with severity:
     - `high`: the target is broken as written.
     - `medium`: a real defect the rubric names.
     - `low`: a nit or a style issue. `low` never blocks.
4. Write the verdict with the Write tool; end your reply with `<lens>: PASS` or `<lens>: FAIL (<severity>)` — not the path, which the panel reads from disk.

## Verdict

Write `<out>/<unit>__<lens>__r<round>g<generation>.json` — the four identity flags verbatim, no timestamp.

```json
{
  "unit": "plan",
  "lens": "correctness",
  "round": 2,
  "generation": 0,
  "pass": false,
  "severity": "medium",
  "findings": [
    { "detail": "Phase 2 calls FooStore.save(_:) — the method is save(item:)", "where": "Sources/Foo/FooStore.swift:41" }
  ],
  "feedback": "One or two sentences telling the corrector exactly what to change. Scope it to the findings."
}
```

Rules:

- Keep each `detail` stable and specific. The loop compares findings across rounds, and a finding that survives a correction unchanged stops the loop.
- No finding without a `where`.
- Do not grade outside your lens, and do not rewrite the target.
