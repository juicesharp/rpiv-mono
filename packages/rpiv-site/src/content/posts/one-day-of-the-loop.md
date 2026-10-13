---
title: "One day of the loop"
description: "A single /wf build run on a reverse-engineered earbuds app: one sentence in at 09:22, a third device family committed at 20:24 — 113 files, 16,042 insertions, all on GLM-5.3. What the gates did at every stage, and why the pipeline, not the model, carried the quality."
pubDate: 2026-09-23T09:00:00Z
author: juicesharp
tags: ["workflow", "case-study", "build", "affordable-models", "alignment"]
draft: false
---

The loop's trade is latency now against alignment debt later. In [one morning
of the loop](/posts/one-morning-of-the-loop) the stakes were 330 lines across
five files. This post is the same loop with the scale knob turned: a whole
device family, one workflow run, start to commit.

At 09:22 on a Sunday, the input to `/wf build` was one sentence written by a
human. At 20:24 the same day, commit `443570a` landed: 113 files changed,
16,042 insertions, a third earbud family shipped end to end inside a Swift 6
app — protocol dialect, wire vocabulary, engine registration, UI surfaces,
persistence, simulator, corpus-replay harness, drift gates. The protocol
package's suites came out 481 tests green across three targets, 81 of them
new Air5-prefixed files. The existing two devices: untouched, pinned
byte-identical by lockstep tests that ran unedited.

Every session in the run — all 75 of them — executed on `zai/glm-5.3`.

That last line is the point of this post. The model didn't get smarter. The
pipeline did the work.

## The repo has teeth

Context first, because it changes what "good output" means here. Arclet is a
companion-app stack for earbuds driven by reverse-engineered protocols: Shokz
OpenDots 2 over a bespoke `A5 5A` BLE frame, Cambridge Audio Melomania A100
over GAIA v3. Every protocol fact is capture-evidenced — PacketLogger traces
committed as `.pklg`, distilled into fixture corpora, fenced by drift gates
that regenerate the corpus and diff it byte-for-byte. No fabricated device
truth anywhere: if a readback doesn't exist, the UI renders unknown, and a
hygiene test suite fails any code that hardcodes a device family name.

A model writing into a repo with machine-enforced conventions is a different
animal than a model writing into a blank directory. The pipeline's job is to
make the model succeed inside those teeth instead of sanding them off.

## The morning was fieldwork

The run didn't start at a keyboard. Weeks earlier, a research pass had picked
the hardware itself — an 82-line compatibility study of which earbuds a
GAIA-capable engine could ever reach, silicon by silicon, ending in a verdict:
Soundpeats Air5 Pro+, QCC3091, the same chipset as the A100 already in the
app. (Technics was Airoha, a dead end. Soundcore's stack is proprietary.
RFCOMM is a wall a BLE-only engine never crosses.)

Sunday morning was the physical campaign: buds, phone, Mac, 15 captures, 1.1
MB of ATT traces — cold connect, warm connect, EQ presets, custom EQ sliders,
fit test, gestures, ANC gates, lid-close teardown, one-bud dock. Decoded that
same morning into a 326-line protocol spec and an 805-line probe client,
landed at 09:19 as commit `701df60`. That is the driver's context: hands on
hardware, hours of patience, judgment about what the bytes mean.

And the bytes were weird in ways that matter. The vendor app speaks none of
the standard GAIA features on a warm connect — its whole control plane is raw
`03xx` register ids on a vendor key. Every EQ band write is answered with a
CMD_NOT_SUPPORTED error while the curve audibly applies — 250 writes, 250
error acks, 250 audible changes. An idle beacon that turned out to mean
placement (a bud is in the case), the opposite reading of the A100 heartbeat
whose silence means link death. A naive implementation gets all three wrong.
The rest of this post is the pipeline encoding exactly these three, among
thirty others, without a human spelling them into the code.

## 09:22 — the sentence

The goal artifact, verbatim:

> we need to add a third library to the existing 2 buds (A100, E320) so a bit
> later the library will be used to add support of the third device. This
> time the library for Soundpeats Air5 Pro+

That's it. `/wf build` captures it as the north star every later gate anchors
against. Thirty minutes of research follows: 6,700 words, ten findings, code
references with file-and-line, integration points in both directions,
precedents — including the A100 campaign's own conclusion, "same engine,
per-model vocabulary," now applied one vendor further.

Then the stage most pipelines skip: **acceptance, frozen before planning**.
Five items, each with a runnable evidence command and an expected outcome —
`swift test --filter Air5` exits 0, the new extractor's `--check` gate exits
0, the existing two suites still green. The standard of completion is derived
from the goal alone and frozen *before* a plan exists, so the standard cannot
inherit the plan's scope. The acceptance doc even flagged the run's one
tension on its own: the goal defers device support ("a bit later"), but the
research recorded the developer's decision as library *plus* live
registration. The plan would have to address that expansion visibly or not at
all. Scope drift has to cross a gate now; it can't just happen.

## Fan out, then synthesize

The slice stage cut the work into nine vertical slices and the designs ran as
nine parallel lanes — each a self-contained document with frozen criteria,
file lists, wire facts, test names. A design-review pass and a readiness gate
checked them against each other and against the codebase's seams. Then
synthesis: the nine designs folded into two dependency clusters and merged
into one plan of 11,066 lines, nine phases, eight risk rulings.

The merge is not concatenation. Every symbol one cluster imports from another
was verified by name — the plan's synthesis notes list the seam spellings
one by one, and any drift would surface as a compile break at the seam's
defining phase, never papered over with a rename downstream. File overlaps
between phases became explicit dependency edges. That verification is a
boring, load-bearing step no human does by hand at this size, and it's why
nine parallel authors can become one coherent plan.

Then elaboration: each phase's specification grew its actual code — fences
with real Swift, real test bodies, real route tables — another ~62,000 words
of plan. After this stage, implementation is assembly, not improvisation.

## The gates that said no

Here is the part I want you to take home, because it's the difference between
a pipeline and a prompt.

The elaborated plan went to a grading panel: six dimensions — correctness,
completeness, actionability, architecture-fit, pattern-following,
risk-rulings — each graded in a **fresh context** that had never seen the
author's reasoning. The panel demoted the plan. Twice, with fix cycles in
between, before a grade round passed it clean.

The findings themselves were verified adversarially before they could force
changes. One round's verdict file records a correctness finding with
`"ruling": "refuted"` — the verifier checked the claimed defect against the
actual artifact, found the amendment had already reconciled every spelling
the finding named, and killed it. Graders hallucinate too; the pipeline
doesn't take their word for it.

Citation floors ran on both the plan and the code: every file edit has to be
declared in its phase's `files:` contract. The floor caught exactly one
undeclared write in the entire run — two lines in `GaiaGuidance.swift`, a
compile-forced switch arm the plan's file list missed (a sibling file was
declared, this one wasn't). It was adjudicated as in-goal work, recorded in
the validation report as a deviation with its mechanism explained, and
counted. Not silently absorbed, not silently reverted.

## 19:25 — validate says no

Nine implementation phases later, each with its own file contract and
package-scoped verification, the tree went to `validate`. First report:
verdict **fail**, three blockers — one red test, a scripted beacon test whose
expectation didn't match the machinery's own pinned semantics. The report
named the fix. The fix went in. The 19:49 re-validation passed, and here is
what that pass means mechanically: `validate` doesn't ask anyone whether the
work is done. It **executes the acceptance inventory's evidence commands
against the finished tree** — the finds, the greps, the `swift test` filters,
all three drift gates — re-checks every risk ruling, reviews the code against
the plan section by section, and verifies pattern conformance. A failing item
forces `verdict: fail` structurally; nobody grades their own homework.

The corpus gate alone re-derived the census from the extractor's own output:
3,316 records, 15 captures, two committed copies byte-identical. The
mismatch rule is written into the risk: a mismatch is a gate bug to fix,
never a test relaxation.

The commit that followed carries an 886-word message dense enough to double
as the changelog — every mechanism, every test count, every known flake with
its re-run evidence (the UI suite's full-parallel run flakes on this machine;
the run's record says so, and says every flaked suite was green in
isolation). `git log` is one hop from the artifact tree.

## The honesty clauses

Two details from the plan deserve light because they show the alignment
working in the small:

The Air5 has **no EQ readback** — the device acknowledges nothing you can
read back about the curve. The easy, wrong move is inventing state. The run
shipped the honest shape: the Audio pane renders a waiting posture on a fresh
connect, no fabricated curve, and the persistence layer deliberately carries
no EQ mirror, with a comment saying why. Recorded as risk rulings, graded as
such.

And the engine refactor that made per-device dialects possible — threading
routing facts through five session seams that had been A100 globals — left
the A100 **byte-identical** through its entire capture corpus. The existing
user's device behavior is pinned by lockstep tests that ran unedited. Nothing
about "add a device" was allowed to mean "change a device."

## The shape

```
09:19  commit 701df60   fieldwork landed: 15 captures, spec, probe tool
09:22  /wf build        one sentence; goal artifact captured verbatim
09:52  acceptance       five evidence commands frozen before planning
09:57  slice            nine vertical slices, designs fan out in parallel
11:44  plan             synthesis, 11,066 lines; graded, demoted, fixed
13:00–16:18             elaboration + four grade rounds, six dimensions
16:18–19:00             nine implement phases, scope-checked, reconciled
19:25  validate         fail — three blockers, fix named by the report
19:49  validate         pass — acceptance executed against the finished tree
20:24  commit 443570a   113 files, 16,042 insertions
```

Behind that spine: 75 detached child sessions, 5,395 messages, 52 MB of
transcript, roughly 437,000 words of artifacts — research, designs, subplans,
plan revisions, elaborations, verdicts, validations — all addressable in
`.rpiv/artifacts/`, all linked from the commit. I kept typing in my main
session the whole time; the run lives in the lane dock, and when a stage
needed an answer it parked the question on its lane rather than stealing the
session.

## What the driver brought

The hands-on capture campaign and its judgment calls. The one honest
sentence. A handful of parked answers. Reading the artifacts — the skills
produce them, the developer owns them. And one more thing the day before:
the same pipeline, in a separate run, split the project's 6,000-line test
god-files into face files. The run landed into a clean tree because the run
before it cleaned the tree. That sequencing is also the driver's.

## What the loop brought

Things a tired human on a Sunday would realistically have skipped:

- An acceptance standard frozen before planning, so "done" was never
  negotiable after the fact.
- Nine parallel designs reconciled seam-by-symbol before a line of
  implementation existed.
- A grading panel in fresh contexts that demoted the plan twice and forced
  three fix cycles — on the same model that wrote it, in contexts that
  hadn't anchored on its reasoning.
- Adversarial verification of the graders themselves; one fabricated finding
  refuted before it cost anything.
- Citation floors that caught the run's single two-line undeclared edit.
- A validation stage that executes the acceptance commands rather than
  trusting anyone's summary — and failed the run once on their behalf.
- The honesty clauses: unknown rendered as unknown, an existing device's
  behavior byte-pinned through a refactor of the engine it rides.

## Why this matters

The known failure mode of affordable-model runs isn't loud breakage; it's
self-validation blindness — the model's work passing the model's verifier
because they share a context and ratify each other's framings. The frontier
answer is to escalate the judge. The expensive answer.

This run is the other answer at 16,000-line scale: never let anything be
verified in the context that produced it. Every grade, every check, every
validation ran fresh. The model wrote; strangers audited. GLM-5.3 carried
the throughput, and the pipeline carried the quality, and the commit at
20:24 is indistinguishable in discipline from the 300-line commits the same
repo lands on careful days.

Artifacts are the unit of work. `git log` is the table of contents — and
this commit is one hop from the plan, the plan from nine designs, the
designs from the research, the research from fifteen captures, the captures
from buds on a desk. Any of it reconstructable, by you or by a model, six
months from now.
