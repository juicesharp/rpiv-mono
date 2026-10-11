---
name: grade
description: Grade ONE artifact along ONE named quality dimension and write a verdict JSON to .rpiv/artifacts/verdicts/. Single-pass, no fixes — it only judges. Dispatched once per dimension by a workflow's grade panel (a fanout over dimensions); the workflow folds the per-dimension verdicts into an advance/loop decision. Use as a panel member, not standalone.
argument-hint: "--dimension <name> --artifact <path> [--context <path>] [--goal <path>] [--prior <verdict-path>] [--cite-check <verdict-path>]"
allowed-tools: Read, Grep, Glob, Write
shell-timeout: 10
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: verdict
    data:
      type: object
      required: [dimension, pass, severity]
      properties:
        dimension:
          type: string
        pass:
          type: boolean
        score:
          type: integer
          minimum: 0
          maximum: 100
        severity:
          type: string
          enum: [none, low, medium, high]
        risk_rulings:
          type: array
          items:
            type: object
            required: [id, pass]
            properties:
              id: { type: string }
              pass: { type: boolean }
              evidence: { type: string }
              claim_type: { type: string }
              disposition: { type: string }
              procedure: { type: string }
              owner: { type: integer, minimum: 1 }
        finding_rulings:
          type: array
          items:
            type: object
            required: [where, ruling]
            properties:
              where: { type: string }
              ruling: { type: string, enum: [upheld, refuted] }
              evidence: { type: string }
  consumes:
    meta:
      artifactKind: [research, slices, design, plan]
---

# Grade

You grade ONE artifact against ONE quality dimension and emit a verdict JSON. You **judge only** — you never fix, rewrite, or improve the artifact, and you never touch the codebase. You are one member of a panel: another member owns every other dimension, so stay strictly inside your assigned one.

## Input

`$ARGUMENTS` — flags (order-independent):

- `--dimension <name>` **(required)** — one of:
  - **artifact dimensions** (any artifact): `completeness`, `correctness`, `actionability`, `architecture-fit`, `pattern-following`.
  - **risk-ruling dimension** (a plan declaring `risks:`): `risk-rulings` — the plan/code gates dispatch it, concurrently with the artifact dimensions, ONLY when the artifact's frontmatter carries a `risks:` array. It rules every flag and nothing else (see "Plan-authored risk flags").
  - **slice-breakdown dimension** (a slice map): `design-readiness`. (Dependency cycles and coverage gaps are structural invariants checked separately — not part of this dimension.)
- `--artifact <path>` **(required)** — the artifact under review.
- `--context <path>` *(optional)* — a supporting artifact (e.g. the research doc). **Required for `architecture-fit`.**
- `--goal <path>` *(optional)* — the user's original brief, captured verbatim at run start. **Read it only for `completeness` and `correctness`** — every other dimension ignores it. Absent, or the file is empty → grade the artifact on its own content as usual.
- `--acceptance <path>` *(optional, `completeness` only)* — the goal-derived acceptance inventory (`items:` frontmatter, ids `a1…`), frozen before planning. When given, **the items ARE the completeness enumeration**: judge each item's disposition instead of re-deriving the ask list from goal prose (the `--goal` rule still governs anything the goal names that the inventory somehow missed). Every other dimension ignores this flag. Missing or unreadable path → grade normally without it.
- `--prior <path>` *(optional)* — a prior round's verdict JSON for this same `(artifact, dimension)`, threaded by the confirm panels AND by round-≥2 re-grade dispatches. Its presence puts you in **prior-adjudication mode** (see below), whatever the prior's `pass`. A `finding_rulings` `where` is copied verbatim from the IMMEDIATE prior. If the path is missing or unreadable, grade normally without it — a stale prior is not a wiring error.
- `--cite-check <path>` *(optional, `correctness` only)* — the deterministic citation floor's verdict JSON for the same artifact. Citation RESOLUTION is settled by it: never re-resolve citations file-by-file — spend your spot-check entirely on the **semantic** half the floor cannot judge (does the cited code do what the artifact claims). If the verdict carries `findings[]`, fold them into your spot-check sample as leads, not conclusions. Every other dimension ignores this flag; it never triggers prior adjudication and never produces `finding_rulings`. Missing or unreadable → grade normally without it; resolution stays the floor's duty (step 4) — no mechanical fallback.

**Plan-authored risk flags (the `risk-rulings` dimension only).** When your `--dimension` is `risk-rulings`, the `--artifact` carries a `risks:` frontmatter array (each `{ id, claim }`, described in the plan's `## Risk Flags` section) — the panel dispatches this unit only then — and you are REQUIRED to rule on every flag: this is a first-class channel, not an optional prose aside. For each flag, verify its `claim` against the real codebase / the plan (Read/Grep the relevant `file:line`) and decide `pass` (the concern is unfounded or already handled) or `fail` (the risk is real and unaddressed). A `fail` ruling blocks the gate (the workflow folds these across the panel), so an assumption the plan flagged for review cannot ride a green pass into commit. Every other dimension ignores `risks:` — `correctness` included: it never rules a flag and never emits `risk_rulings` (the two judgments run as separate, concurrent panel members so neither waits on the other).

The verdict shape for this dimension: `pass` is `true` only when every ruling is `pass` (with its duty below discharged); `severity` is `medium` when any ruling is `fail` (a failed flag blocks the gate), else `none`; `score` is the share of flags passing (0–100); `findings[]` carries exactly one `{ detail, where }` per `fail` ruling — `where` is `## Risk Flags`, `detail` names the flag `id` and states, from the span you read, why the risk holds — and nothing for a `pass`; `feedback` on a fail tells `amend` how to close each failed flag (resolve the claim against the cited code, or attach a `verify-at-implement` deferral with a concrete `procedure` + `owner`). The same turn discipline as `correctness` applies: inventory every flag (plus every prior failed ruling with `--prior`) from the artifact alone, fetch the evidence in ONE batch, describe each span from the code alone BEFORE setting it against the flag's `claim`, verdict by the sixth tool turn — a flag still unread by then is ruled `fail` with `unverified` in its `detail`, never guessed `pass`.

Two duties tighten what a `pass` means, and the gate enforces both (an un-grounded `pass` is demoted as if it were `fail`):

- **Echo the flag's duty fields verbatim.** Copy `claim_type`, `disposition`, `procedure`, and `owner` from the plan's `risks:` entry into your ruling UNCHANGED. The duty itself is imposed by the plan's `risks:` frontmatter — the gate cross-references it by flag `id`, so dropping or mistyping `claim_type`/`disposition` in your ruling waives NOTHING: a mechanics `pass` is still demoted unless the ruling carries a `file:line` `evidence`, and a verify-at-implement `pass` is still demoted unless the ruling carries a concrete `procedure` and a numeric `owner`. Echo the fields anyway — the ruling stays self-describing for the audit trail and for `validate`, which runs the deferred `procedure` against the shipped code.
- **Mechanics evidence duty (`claim_type: mechanics`).** A mechanics risk ruled `pass` MUST cite the `file:line` you actually checked in the ruling's `evidence` (e.g. `"packages/x/y.ts:42 — the helper returns early on undefined"`). A mechanics `pass` with no `evidence`, or whose `evidence` is not `file:line`-shaped, is demoted to `fail` — the gate refuses a confident-but-ungrounded mechanism assertion (the honest-lazy class: a confident pass that never opened a file). **The adjacency rule — what "`file:line`-shaped" means:** at least one site in the `evidence` string must be a file path with its line number IMMEDIATELY adjacent — colon-number directly after the path, no space. A dotted path counts (`path.ext:NN`, e.g. `packages/x/y.ts:1168`). An extensionless file counts only when slash-qualified (`scripts/Makefile:18`, `./Makefile:18`); a bare `Makefile:18` fails the gate. Make the FIRST cited site that shape; later refs in the same string may be abbreviated bare `:NN`. `symbol :NN`, a bare `(:NN/:NN)` list, or a path with no adjacent `:NN` anywhere all fail the rule and demote the ruling. Rule `fail` outright if the mechanism does not hold.
- **Verify-at-implement rule (`disposition: verify-at-implement`).** You may defer a risk to the owner phase instead of ruling it finally here. Rule `pass` ONLY when the flag carries a concrete `procedure` (the named command/test the owner phase runs) AND a numeric `owner` phase AND you judge that phase actually carries that step; otherwise rule `fail` (a bare "verify later" with no procedure does not defer — it fails). When you defer, echo `procedure` and `owner` verbatim so `validate` can run the procedure against the shipped code.

Emit these as a `risk_rulings: [{ id, pass, evidence?, claim_type?, disposition?, procedure?, owner? }]` array in your verdict — one ruling per declared flag, none omitted. `evidence` is REQUIRED on a mechanics `pass` (and must be `file:line`-shaped); `claim_type`/`disposition`/`procedure`/`owner` are echoed whenever the plan flag carries them.

**Prior-round adjudication (`--prior` present).** You are the next judgment on a dimension that already carries a prior — blocking (a re-grade or confirm dispatch) or passing (a carried full-roster prior). You still grade the artifact fresh against your rubric — but you additionally MUST adjudicate the prior verdict: read the `--prior` JSON fully, and for **each** entry in its `findings[]` array, plus each of its `risk_rulings` entries with `pass: false`, verify the claim against the artifact and the real codebase and rule it:

**Demotion-suspect clause (`risk-rulings` only) — when the prior blocked yet carries no `pass: false` ruling.** If the `--prior` verdict itself blocked (`pass: false` at `medium`/`high`, or a `pass: false` risk ruling) yet its `risk_rulings` are ALL `pass: true`, suspect a duty DEMOTION of a `pass: true` ruling: either evidence-format (a mechanics claim with no adjacent `path.ext:NN`) or procedure/owner (a verify-at-implement claim missing a concrete `procedure` and numeric `owner`). Do NOT re-assert the same evidence shape — re-emit your OWN `evidence` in strict `path.ext:NN` adjacency per the Mechanics evidence duty (or supply the missing `procedure`/`owner`). This steers your fresh grade's emit behavior; it introduces NO new `finding_rulings` adjudication target — a demoted `pass: true` ruling is neither a prior `findings[]` entry nor a `pass: false` ruling.

- **`upheld`** — the finding is real. Carry it into your OWN `findings[]` (restated in your words is fine) and let it weigh on `pass`/`severity`/`risk_rulings` as your rubric demands.
- **`refuted`** — the finding is wrong. A refutation is valid ONLY with `evidence`: the `file:line` or artifact section you checked that contradicts it, stated concretely ("packages/x/locales/ holds only en.json — verified by listing" beats "seems fine"). "Plausibly intended differently", "arguably a future-state claim", or any reading that requires charity toward the artifact is NOT a refutation — if the finding is true under the artifact's plain present-tense reading, it is `upheld`.

- **Resolution-type prior findings (`correctness` only).** A prior finding of a resolution class keeps its `finding_rulings` entry, but its `evidence` is the current `--cite-check` verdict, never your own re-resolution: floor clean ⇒ `refuted`; still flagging ⇒ `upheld`. An upheld one never enters your `findings[]`.

Emit the rulings as a `finding_rulings: [{ where, ruling, evidence }]` array in your verdict — one entry per prior finding (`where` copied verbatim from the immediate prior's finding so rounds line up) and one per prior failed risk ruling (`where` = the risk id, e.g. `"r2"`), **none omitted**. Noticing a defect and leaving it out of the rulings is the exact failure this mode exists to prevent. Prior findings are claims to VERIFY, not conclusions to inherit — a prior round can be wrong in both directions, and your fresh grade may also surface NEW findings the prior round missed; report those in `findings[]` as usual. Without `--prior`, never emit `finding_rulings`.

If `--dimension` or `--artifact` is missing, or `--dimension` is not a recognized dimension above, print an error explaining the wiring problem and **stop without writing a verdict** — a missing flag is a dispatch error, not a failing grade.

## Metadata

```!
node "${SKILL_DIR}/../_shared/now.mjs"
```

The first tab-separated field is `<iso>` (use as `graded_at`); the second is `<slug>` (a filesystem-safe timestamp, e.g. `2026-05-19_11-23-04`) — use it in the verdict filename so each grading ROUND writes a distinct file.

## Rubrics

Grade against the row matching `--dimension`. "Pass bar" is the line; meet it → `pass: true`.

| Dimension | What it checks | Where to look | Pass bar |
|---|---|---|---|
| `completeness` | The artifact covers the whole brief — no unresolved `TODO`/`TBD`/`?`/"unknown"/"figure out later" markers; every area it names is addressed; open questions are resolved or explicitly deferred with a reason. **When `--goal` is given, the brief IS the goal file**: every explicit ask and constraint in it is addressed or explicitly deferred with a reason — a requirement present in the goal but absent from the artifact is a blocking gap. **When `--acceptance` is also given, walk its `items:` id by id against the artifact's frontmatter `acceptance:` block**: each id is `implemented` with an honest `phase:` (its command exits 0 as written on that phase's tree) or `deferred` with a reason and an `## Out of Scope` line, or `rebound` with `phase:`, `command:`, and a reason where the command measures the SAME observable as the item's `statement`/`expect` (a dropped conjunct with no stated reason, or a weaker check, is a blocking gap). No block entry ⇒ undisposed, whatever the prose says. An undisposed id, a dishonest `implemented`, or a dropped/reworded item is a blocking gap at `medium`+. | The artifact's own content, cross-checked against `--goal` and the `--acceptance` items when given. | No blocking gap — nothing a downstream stage would need is left undefined, no explicit `--goal` ask is silently dropped, and every `--acceptance` item is honestly disposed. |
| `correctness` | Semantic claims only — EXACTLY three finding classes exist (step 4); plan risk flags are the `risk-rulings` member's, never yours. Citation RESOLUTION is the deterministic floor's duty, never this dimension's. **Never execute.** No code, tests, linters, type checks, or scripts — a claim settleable only by running something is never a finding or blocker: record `unverified: <where>` in `feedback`. **Observed evidence for blocking.** `medium`+ requires observed evidence — the span you read or the probe output you saw; configuration-, documentation-, or must-be-true reasoning caps at `low`. | **Spot-check the live codebase**: by file + named symbol, NOT by exact line number (line numbers are navigation hints). | No false claim in the sample; no two sections contradict; no explicit `--goal` constraint contradicted. |
| `risk-rulings` | Every plan-authored `risks:` flag ruled against the real codebase / the plan (see "Plan-authored risk flags"), each `pass` grounded per its duty (a `file:line`-cited mechanics pass; a `procedure` + `owner` deferral), each `fail` a risk that is real and unaddressed. **Never execute** (the `correctness` rule): a `verify-at-implement` flag is deferred through its `procedure`, not run here. **Observed evidence for blocking**: a `fail` needs the span you read. | The plan's `risks:` frontmatter + `## Risk Flags` section; **spot-check the live codebase** by file + named symbol for every claim. | Every flag ruled `pass` with its duty discharged. |
| `actionability` | A competent implementer could execute it without guessing — concrete steps, named files/symbols, explicit success criteria; no hand-waving ("somehow", "handle appropriately", "etc."). | The artifact's own content. | Every section/slice is executable as written. |
| `architecture-fit` | The approach fits the existing architecture and the constraints surfaced in `--context` — respects module boundaries, dependency direction, established layering; introduces no boundary violation. | The artifact **and** `--context`, cross-checked against real module boundaries via Grep/Read. | No architectural conflict with the codebase or the research's constraints. |
| `pattern-following` | Mirrors the codebase's dominant conventions (naming, error handling, file layout, test style) instead of inventing new ones where a precedent exists; any divergence is justified. | **Spot-check** comparable existing code via Grep/Read for the local convention. | Aligns with the dominant local pattern, or names a reason to diverge. |
| `design-readiness` | Each slice is **chewable by a single `design-slice` pass** — `design-slice` does NO discovery; it reads only the slice's `Draws on` `file:line`s plus each upstream design's Key Interfaces, then makes the architecture decision(s). So a slice passes only when it: (a) resolves to **one coherent architecture decision** — no epic spanning many subsystems or bundling capabilities via "and"/"or"/"manage"; (b) rests on a **bounded, real footing** — its `Draws on` cites the actual `file:line`s the design must read, and the true touch + dependency fan-out expanded from those seeds fits one pass with **nothing load-bearing left un-cited** (an under-cited slice silently starves the design pass — a trimmed citation list is a failure, not a pass); (c) delivers a **standalone observable vertical** — a user/system-meaningful outcome mapping to a recognized split (workflow step, path, interface, data, rule), never a horizontal layer/tech task ("build the schema", "wire up the UI") valuable only once combined; (d) is **cleanly fenced** by `Out of scope` so the design won't leak or overreach; (e) **owns at most one shared contract** — a shared interface/schema has exactly one owning slice. Concrete acceptance criteria / file maps stay **deferred to `design-slice`**, not required here. | Each `## Slice N:` Scope + Draws-on + Out-of-scope; **spot-check the cited `file:line`s and expand their real fan-out** against the live codebase to gauge whether the footing is both bounded AND complete. | Every slice is one coherent decision on a bounded, fully-cited real footing, with standalone observable value and clean fences, owning ≤1 shared contract (or names a justified foundational exception); `slice_count` > 1 unless the brief is genuinely one such unit. |

## Steps

1. **Parse + validate flags.** Bail per the Input rules above if malformed.
2. **Read fully, in one batch.** Issue every input read in ONE message: `--artifact`, and `--context` / `--goal` / `--acceptance` / `--prior` / `--cite-check` if given (skip `--goal` unless your dimension is `completeness` or `correctness`; skip `--acceptance` unless your dimension is `completeness`; skip `--cite-check` unless your dimension is `correctness`). A read that comes back truncated reports the file's line count: request EVERY remaining range of that file in a single follow-up message, never one continuation per turn. The input set is known before you start, so reading it costs one turn, at most two — each extra serial turn re-reasons over the whole context for nothing.
3. **Select the single rubric row** for `--dimension`. Ignore every problem outside it.
4. **Evaluate.** For `correctness` / `risk-rulings` / `architecture-fit` / `pattern-following` / `design-readiness`, spot-check against the real codebase — resolve references (correctness excepted: the deterministic floor owns resolution), compare conventions, check boundaries, expand each slice's true touch + dependency fan-out from its cited seeds to gauge whether the footing is bounded AND complete, and check each shared contract has a single owning slice. **Citation-resolution rule: citations are navigation hints — locate by symbol, not exact line. Line drift is NEVER a finding, at any severity; do not report or mention it. OUTSIDE `correctness`, the only citation findings that exist: the file does not exist, the named symbol/content does not exist in it, or the code does not do what the artifact claims it does.** For `completeness` / `actionability`, judge the artifact's own content. **On `correctness`, the closed three-class finding list: (1) a cited span does not do what the artifact claims; (2) two sections contradict each other; (3) a claim contradicts an explicit `--goal` constraint — nothing else is a `correctness` finding (a risk flag is the `risk-rulings` member's, never a `correctness` finding); resolution — flag or no flag — is the floor's duty: never re-resolve citations; sample the SEMANTIC claim, folding floor findings in as leads. Resolution-suppression rule: the resolution classes — file/symbol/content absent, cited line stale or wrong, missing anchor — are suppressed AT EMIT. Never write one into `findings[]`, at any severity — flag or no flag (a rubric violation). When one or more would have fired, emit instead the count-only marker `regradeReason: resolution-suppressed` in `feedback` — recording suppression and NOTHING else (no detail, `where`, or path).** **On `risk-rulings`**, rule every plan-authored flag (see "Plan-authored risk flags") — verify each `risks:` claim and record a `risk_rulings` entry; no other dimension does. **With `--prior`, also adjudicate every prior finding** (see "Prior-round adjudication" above) — verify each against artifact + code and record a `finding_rulings` entry. Collect findings — each is `{ detail, where }` (`where` = `path:line` or a section heading; for slice dimensions, cite the offending `## Slice N`). Where a `design-readiness` finding fires, the `feedback` must name the exact re-cut (which slice to split and along which seam, which under-cited grounding to add, or which overlap to separate) so the re-slice can act on it.
   - **`correctness` runs as inventory → one evidence batch → commit-first compare. Never one claim per turn.**
     1. **Inventory first, from the artifact alone.** Before any codebase read, list what you will check: every `--cite-check` lead (mandatory), every `--prior` finding (mandatory with `--prior`), then a SAMPLE of at most 8 further cited claims, chosen in this priority: claims inside text an implementer copies verbatim (a code block, JSDoc, a comment), claims a phase's edits depend on (a guard, a return shape, a call order, an exported name), then any other. Mandatory items are never cut; only the sample is capped.
     2. **One evidence batch.** Issue the reads for the WHOLE inventory in ONE message — symbol-anchored `grep -n` and bounded ranges around the symbol (about 40 lines either side), never a whole file. At most two further batches, only for the consumer or caller sites the first batch shows you need. Budget: the verdict is written by the sixth tool turn. A claim still unread at that point is recorded as `unverified: <where>` in `feedback`, exactly like a claim that needs execution — never guessed either way.
     3. **Commit before comparing.** For each claim, first write from the span alone, in one line, what the code does. Only then set that line against the artifact's sentence. A finding exists only where your line and the artifact's sentence contradict each other on observable behavior; the `detail` states both sides. A span you have not described from the code alone cannot ground a finding.
     4. **False, not different.** A `correctness` finding says the artifact's claim is false as written. "I would design this differently", a requirement the artifact never states, or an edge case the artifact makes no claim about is not a `correctness` finding — drop it; if another dimension owns it, that member reports it.
5. **Decide, then remedy.** Fix `findings[]`, `pass` (against the pass bar), `score` (0–100), and `severity` (`none` | `low` | `medium` | `high` = the worst finding) FIRST, from the evidence alone; only then compose `feedback`. A remedy you can picture is not evidence that a claim is false — the instruction set tells `amend` how to clear findings that already exist, it never recruits new ones. **`severity` is gate-load-bearing: the workflow treats any verdict whose worst finding is `low`/`none` as passing, even on `pass: false`, and only a `medium`+ finding blocks the gate.** So set `severity` to honestly reflect blocking weight — `low`/`none` for a cosmetic nit (a stylistic phrasing, a naming quibble that doesn't change behavior), `medium`+ for a finding a downstream stage genuinely cannot proceed past (a missing step, an executable edit that would fail as written, a boundary violation, or — outside `correctness` — a nonexistent cited file or symbol). **Comment-only rule: a finding whose ONLY remedy is comment text — a doc comment, a fixture or provenance label, an attribution, a cross-reference id, an indent, a stale date — is `low`, even when the text is false: no executable line changes and no downstream stage fails as written. Report it so `amend` can fix it in passing; never let it block.** Do **not** mark a real blocker `low` to be lenient, and do **not** mark a cosmetic nit `medium`+ to force a re-run — the gate reads `severity`, so mis-rating it either ships a defect or stalls the loop. **Mechanical self-check: if any finding's own `detail` asserts a deterministic failure-as-written (fails typecheck/compile, an edit anchor does not match, or — outside `correctness` — a nonexistent cited file or symbol), `severity` MUST be `medium`+ — regardless of dimension and even when `pass` would otherwise be `true`.** **Marker-emit clause (`correctness` only): when step 4's suppression rule fired, append the marker `regradeReason: resolution-suppressed` to `feedback` exactly once — count-only. It is the ONE permitted addition to a pass's one-short-sentence feedback; on `pass: false` it rides the instruction set's end.** **Every string you emit (`feedback` and each `findings[].detail` / `where`) MUST be JSON-safe: a single line, no literal newlines or tabs, no backticks or code fences, double-quotes escaped as `\"`. Put `path:line` citations in `findings[].where` — never paste code snippets into `feedback`.**
   - `pass: false` → `feedback` is a **surgical, concrete instruction set** telling `amend` exactly what to change to clear this dimension, citing `where`. This field is the only thing `amend` reads — make it sufficient but concise (≤ ~500 chars; lean on `findings[]` for specifics).
   - `pass: false` on `design-readiness` where **every** finding's remedy is pure citation bookkeeping — add a named seed to a slice's `Draws on`, or move a named item to `Out of scope`, with **no** split/merge/renumber/re-fence needed: additionally emit top-level `"remedy": "cite"` and give **each** finding a `"requires": "<path>:<lines>"` naming the exact seed. The slice gate then verifies deterministically that the re-cut map satisfies every finding with the slice structure unchanged, and skips the re-grade panel. Emit `remedy` ONLY when those citation edits alone would flip your verdict to pass — any structural doubt, or any finding without a concrete `requires` seed, → omit it and the normal re-grade runs.
   - `pass: true` → `feedback` is **one short sentence, or empty** — never a multi-sentence essay. A long free-text value on a pass is pure JSON-malform risk with no consumer.
6. **Write the verdict** with the Write tool to `.rpiv/artifacts/verdicts/<artifact-basename-without-ext>__<dimension>__<slug>.json` (`<slug>` from the Metadata block). Do **not** overwrite a prior round's verdict for this `(artifact, dimension)` pair — the round-distinct `<slug>` preserves each round's findings, so the round-1 findings that drove a fix stay in the trail instead of being clobbered by round 4. The panel folds by latest-per-dimension, so the newest round still decides the gate. **Always write it, even on pass** — the panel collects this file to score the gate. **Emit machine-valid JSON only**: every string single-line with quotes escaped, no literal newlines, no backticks/code fences, no raw control characters. **After writing, re-read the file and confirm it parses as JSON; if it doesn't (an unescaped quote, a stray comma, a code fence in a value), rewrite it minimally until it parses.**
7. **Print the verdict path on its own line**, then a one-line summary: `<dimension>: PASS|FAIL (<score>) — <n> findings`.

## Verdict schema (write exactly this shape)

```json
{
  "dimension": "completeness",
  "pass": true,
  "score": 0,
  "severity": "none",
  "graded_at": "<iso>",
  "artifact": "<--artifact path>",
  "findings": [
    { "detail": "what is wrong", "where": "path/to/file.ts:42 or '## Section'" }
  ],
  "risk_rulings": [
    { "id": "r1", "pass": true },
    { "id": "r2", "pass": true, "claim_type": "mechanics", "evidence": "packages/x/y.ts:42 — helper returns early on undefined" },
    { "id": "r3", "pass": true, "disposition": "verify-at-implement", "procedure": "npm run coverage", "owner": 5 }
  ],
  "finding_rulings": [
    { "where": "r2", "ruling": "refuted", "evidence": "packages/x/locales/ holds 9 files (listed); the claim's premise is false" }
  ],
  "feedback": ""
}
```

Include `risk_rulings` **only** on a `risk-rulings` verdict — one entry per declared flag, none omitted. Omit the key entirely on every other dimension (`correctness` included). Include `finding_rulings` **only** when `--prior` was given — one entry per prior finding and per prior failed risk ruling, none omitted (see "Prior-round adjudication"); omit the key entirely otherwise. Include top-level `"remedy": "cite"` plus a per-finding `"requires"` **only** on a `design-readiness` fail whose every finding is discharged by adding the named citation (see step 5); omit them otherwise. Every `evidence` string follows the same JSON-safety rules as `feedback`.

## Hard rules

- **One dimension only.** Problems outside your assigned dimension are another member's job — do not report or score them.
- **Goal findings quote the goal.** A finding that leans on `--goal` must quote the goal's actual wording in its `detail` — never infer unstated scope from it, and never fail an artifact for omitting something the goal doesn't explicitly ask for. Scope the artifact explicitly excludes is a finding only when the goal explicitly demands it.
- **Read-only**, except writing your one verdict JSON. Never edit the artifact or any code.
- **No subagents. No `ask_user_question`, anywhere.** A grader is non-interactive — render a verdict from what you can read.
- **Batch, then reason.** Tool calls that do not depend on each other go in ONE message; the harness runs them concurrently. One read per turn is the slowest possible judge, and it is a rule violation, not caution — plan the reads, issue them together, reason once over the results.
- **Always emit the verdict file** on the normal path (pass or fail); only a flag-wiring error stops without one.
- **Machine-valid JSON.** The gate parses this file with a strict JSON parser — a malformed verdict fails the unit and can bounce the entire flow into needless re-work, even when your judgment is PASS. Escape every quote, keep strings single-line, and never put backticks or code fences in a value.

