---
title: "Three answers to the delegation gap"
description: "Dynamic workflows, /goal loops, and a gated pipeline are three different answers to the same question: what would it take to actually hand work over? A comparison, and where rpiv deliberately sits."
pubDate: 2026-07-03T13:00:00Z
author: juicesharp
tags: ["positioning", "workflows", "rpiv-pi"]
draft: false
---

[Anthropic's 2026 agentic-coding trends report](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) documents the industry's open wound with numbers. Developers use AI in roughly 60% of their work, yet report being able to fully delegate only 0 to 20% of tasks. The report's own name for the finding is the **collaboration paradox**; commentators have dubbed it the **delegation gap**. And the report's Trend 4 draws the consequence: human oversight has to scale intelligently, or it becomes the bottleneck. Everyone can generate. Nobody trusts the result enough to stop watching.

Three approaches to that gap are on the table right now. From a distance they look similar: all of them orchestrate multiple agent sessions toward a goal. But they make opposite bets on the questions that matter. *Who holds the plan? Who checks the work? When do you get asked?*

This comparison is scored for one job, the coding problem in its hardest everyday form: shipping a feature into a codebase you have to live with. On other work the table tilts differently, and we will say where.

## Answer one: the model writes the process

[Claude Code's dynamic workflows](https://code.claude.com/docs/en/workflows) have the model author a fresh orchestration script per run: fan-out, verifier agents that adversarially cross-check findings, grader loops. The script executes in the background. It is genuinely impressive machinery, and its own docs state its human-interaction contract plainly: **no mid-run user input** (only permission prompts can pause a run, and [subagents are barred](https://code.claude.com/docs/en/sub-agents) from the question tool). If you want sign-off between stages, you split the work into separate runs. The plan is held by a script the model wrote minutes ago. Verification is models checking models. You are asked at launch, and then not at all.

<figure>
<svg viewBox="0 0 520 132" role="img" aria-label="Dynamic workflows: you approve at launch, then a wall closes. A model-written script fans out agents, other agents verify them, and a result comes back with no human in the loop.">
  <rect x="22" y="52" width="13" height="13" rx="1.5" transform="rotate(8 28 58)" fill="var(--ochre)" opacity="0.92" />
  <text x="28" y="86" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">you</text>
  <line x1="62" y1="16" x2="62" y2="116" stroke="var(--text-distant)" stroke-width="1" stroke-dasharray="3 4" opacity="0.6" />
  <text x="66" y="14" font-family="var(--font-mono)" font-size="9" fill="var(--text-distant)" letter-spacing="0.08em">launch · no mid-run input</text>
  <line x1="41" y1="58" x2="78" y2="58" stroke="var(--sage-deep)" stroke-width="1" />
  <rect x="82" y="42" width="88" height="32" rx="3" fill="var(--ink-raised)" stroke="var(--sage)" stroke-width="1" stroke-dasharray="4 3" />
  <text x="126" y="56" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--washi-soft)">script</text>
  <text x="126" y="68" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--text-distant)">model-written</text>
  <line x1="170" y1="52" x2="238" y2="26" stroke="var(--sage-deep)" stroke-width="0.9" opacity="0.7" />
  <line x1="170" y1="58" x2="238" y2="58" stroke="var(--sage-deep)" stroke-width="0.9" opacity="0.7" />
  <line x1="170" y1="64" x2="238" y2="90" stroke="var(--sage-deep)" stroke-width="0.9" opacity="0.7" />
  <circle cx="245" cy="26" r="7" fill="var(--ink)" stroke="var(--sage)" stroke-width="1" />
  <circle cx="245" cy="58" r="7" fill="var(--ink)" stroke="var(--sage)" stroke-width="1" />
  <circle cx="245" cy="90" r="7" fill="var(--ink)" stroke="var(--sage)" stroke-width="1" />
  <text x="245" y="115" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-distant)">agents ×N</text>
  <line x1="252" y1="28" x2="322" y2="54" stroke="var(--sage-deep)" stroke-width="0.9" opacity="0.7" />
  <line x1="252" y1="58" x2="320" y2="58" stroke="var(--sage-deep)" stroke-width="0.9" opacity="0.7" />
  <line x1="252" y1="88" x2="322" y2="62" stroke="var(--sage-deep)" stroke-width="0.9" opacity="0.7" />
  <circle cx="332" cy="58" r="9" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" />
  <text x="332" y="38" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--ochre)" opacity="0.8">↺</text>
  <text x="332" y="115" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-distant)">agents judge</text>
  <text x="332" y="127" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-distant)">agents</text>
  <line x1="342" y1="58" x2="428" y2="58" stroke="var(--sage-deep)" stroke-width="1" />
  <path d="M424,54 L430,58 L424,62" fill="none" stroke="var(--sage-deep)" stroke-width="1" />
  <text x="436" y="61" font-family="var(--font-mono)" font-size="12" fill="var(--washi-soft)">result</text>
</svg>
<figcaption style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-distant);margin-top:0.6rem">You approve at launch. After the wall, a model-written script runs model-checked work to a result.</figcaption>
</figure>

[Anthropic's own write-up](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) is admirably candid about why the machinery exists. Single-context agents suffer agentic laziness, self-preferential bias, and goal drift: "details like edge-case requirements or 'don't do X' constraints can get lost." Note the treatment, though. Goal drift is fought with decomposition, fresh context windows per subagent. But the orchestration script itself is written once, from a lossy read of your prompt. Every subagent inherits whatever the script-writer misread. Fresh contexts downstream of an unguarded translation.

This is the right shape for *breadth* work: exhaustive audits, research sweeps, migrations where volume wins and any individual miss is cheap.

## Answer two: nobody holds a process

[`/goal`](https://code.claude.com/docs/en/goal) sets a completion condition and lets the agent free-run until a fresh evaluator judges the condition met. There is no process at all. That's the appeal. Persistence replaces structure. "Keep going until CI is green" is a perfectly good contract when the end state is measurable and the path doesn't matter.

<figure>
<svg viewBox="0 0 520 132" role="img" aria-label="/goal: you write a condition of up to 4,000 characters, the agent free-runs in a loop, and a fresh evaluator decides when it is met. No human appears after the start.">
  <rect x="22" y="52" width="13" height="13" rx="1.5" transform="rotate(8 28 58)" fill="var(--ochre)" opacity="0.92" />
  <text x="28" y="86" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">you</text>
  <line x1="41" y1="58" x2="78" y2="58" stroke="var(--sage-deep)" stroke-width="1" />
  <rect x="82" y="42" width="96" height="32" rx="3" fill="var(--ink-raised)" stroke="var(--sage)" stroke-width="1" />
  <text x="130" y="56" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--washi-soft)">condition</text>
  <text x="130" y="68" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--text-distant)">≤ 4,000 chars</text>
  <line x1="180" y1="58" x2="222" y2="58" stroke="var(--sage-deep)" stroke-width="1" />
  <circle cx="272" cy="58" r="34" fill="none" stroke="var(--sage)" stroke-width="1" stroke-dasharray="5 4" opacity="0.7" />
  <path d="M296,37 L301.5,41 L301,34" fill="none" stroke="var(--sage)" stroke-width="1" opacity="0.7" />
  <text x="272" y="55" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--washi-soft)">agent</text>
  <text x="272" y="68" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--text-distant)">free-runs</text>
  <line x1="306" y1="58" x2="358" y2="58" stroke="var(--sage-deep)" stroke-width="1" />
  <circle cx="370" cy="58" r="9" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" />
  <text x="370" y="82" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-distant)">met?</text>
  <text x="370" y="115" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-distant)">fresh evaluator</text>
  <path d="M366,49 C340,20 300,18 280,24" fill="none" stroke="var(--ochre)" stroke-width="0.8" stroke-dasharray="2.5 3.5" opacity="0.55" />
  <path d="M287,25 L280,24 L285,19.5" fill="none" stroke="var(--ochre)" stroke-width="0.8" opacity="0.55" />
  <text x="322" y="14" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--text-distant)">not yet ↺</text>
  <line x1="380" y1="58" x2="438" y2="58" stroke="var(--sage-deep)" stroke-width="1" />
  <path d="M434,54 L440,58 L434,62" fill="none" stroke="var(--sage-deep)" stroke-width="1" />
  <text x="446" y="61" font-family="var(--font-mono)" font-size="12" fill="var(--washi-soft)">done</text>
</svg>
<figcaption style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-distant);margin-top:0.6rem">No process: the agent loops until a fresh evaluator calls the condition met. You appear only at the start.</figcaption>
</figure>

Note what the goal is here: a stop condition *you paraphrased* from your intent, capped at a few thousand characters, judged against the transcript. It answers "when to stop." It does not answer "did you build what I asked, the way my codebase wants it."

## Answer three: a fixed pipeline with judgment seams

rpiv's `build` makes the opposite bet on all three questions.

<figure>
<svg viewBox="0 0 520 132" role="img" aria-label="rpiv build: a fixed rail of seven acts. Torii gates at slice, plan, and code repair on their own fix loops. Hollow marks above capture, slice, and design ask you only on real ambiguity. The solid seal at review always pauses. Your marks appear along the whole rail, not just at the start.">
  <line x1="40" y1="70" x2="478" y2="70" stroke="var(--sage-deep)" stroke-width="1" opacity="0.8" />
  <circle cx="76" cy="70" r="1.8" fill="var(--ochre)" opacity="0.7" /><circle cx="149" cy="70" r="1.8" fill="var(--ochre)" opacity="0.7" /><circle cx="222" cy="70" r="1.8" fill="var(--ochre)" opacity="0.7" /><circle cx="295" cy="70" r="1.8" fill="var(--ochre)" opacity="0.7" /><circle cx="368" cy="70" r="1.8" fill="var(--ochre)" opacity="0.7" /><circle cx="441" cy="70" r="1.8" fill="var(--ochre)" opacity="0.7" />
  <rect x="35" y="26" width="9" height="9" rx="1" transform="rotate(8 40 30)" fill="none" stroke="var(--ochre)" stroke-width="0.9" opacity="0.75" />
  <rect x="108" y="26" width="9" height="9" rx="1" transform="rotate(8 113 30)" fill="none" stroke="var(--ochre)" stroke-width="0.9" opacity="0.75" />
  <rect x="181" y="26" width="9" height="9" rx="1" transform="rotate(8 186 30)" fill="none" stroke="var(--ochre)" stroke-width="0.9" opacity="0.75" />
  <rect x="254" y="26" width="9" height="9" rx="1" transform="rotate(8 259 30)" fill="var(--ochre)" opacity="0.92" />
  <line x1="40" y1="38" x2="40" y2="58" stroke="var(--ochre)" stroke-width="0.7" stroke-dasharray="1.5 3" opacity="0.4" />
  <line x1="113" y1="38" x2="113" y2="48" stroke="var(--ochre)" stroke-width="0.7" stroke-dasharray="1.5 3" opacity="0.4" />
  <line x1="186" y1="38" x2="186" y2="52" stroke="var(--ochre)" stroke-width="0.7" stroke-dasharray="1.5 3" opacity="0.4" />
  <line x1="259" y1="38" x2="259" y2="58" stroke="var(--ochre)" stroke-width="0.7" stroke-dasharray="1.5 3" opacity="0.55" />
  <g fill="none" stroke="var(--ochre)" stroke-width="1" opacity="0.7" stroke-linecap="round">
    <path d="M110,56 L110,64 M116,56 L116,64 M107.5,57.5 L118.5,57.5" />
    <path d="M329,56 L329,64 M335,56 L335,64 M326.5,57.5 L337.5,57.5" />
    <path d="M402,56 L402,64 M408,56 L408,64 M399.5,57.5 L410.5,57.5" />
  </g>
  <g fill="none" stroke="var(--ochre)" stroke-width="1.1" opacity="0.85" stroke-linecap="round">
    <path d="M121.8,47.5 A 6,6 0 1 1 126,50" />
    <path d="M130.7,48.2 L125.7,50.2 L130.4,52.8" />
    <path d="M340.8,47.5 A 6,6 0 1 1 345,50" />
    <path d="M349.7,48.2 L344.7,50.2 L349.4,52.8" />
    <path d="M413.8,47.5 A 6,6 0 1 1 418,50" />
    <path d="M422.7,48.2 L417.7,50.2 L422.4,52.8" />
  </g>
  <g fill="none" stroke="var(--sage)" stroke-width="0.7" opacity="0.35" stroke-dasharray="2 2">
    <circle cx="182" cy="66" r="8" /><circle cx="190" cy="74" r="8" />
  </g>
  <circle cx="40" cy="70" r="5.5" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" /><circle cx="40" cy="70" r="5.5" fill="var(--sage)" opacity="0.16" />
  <circle cx="113" cy="70" r="5.5" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" /><circle cx="113" cy="70" r="5.5" fill="var(--sage)" opacity="0.16" />
  <circle cx="186" cy="70" r="5.5" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" /><circle cx="186" cy="70" r="5.5" fill="var(--sage)" opacity="0.16" />
  <rect x="253" y="64" width="12" height="12" rx="1.5" transform="rotate(8 259 70)" fill="var(--ochre)" opacity="0.92" stroke="var(--kuro)" stroke-width="0.6" />
  <circle cx="332" cy="70" r="5.5" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" /><circle cx="332" cy="70" r="5.5" fill="var(--sage)" opacity="0.16" />
  <circle cx="405" cy="70" r="5.5" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" /><circle cx="405" cy="70" r="5.5" fill="var(--sage)" opacity="0.16" />
  <circle cx="478" cy="70" r="5.5" fill="var(--ink)" stroke="var(--sage)" stroke-width="1.1" /><circle cx="478" cy="70" r="5.5" fill="var(--sage)" opacity="0.16" />
  <text x="40" y="96" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">capture</text>
  <text x="113" y="96" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">slice</text>
  <text x="186" y="96" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">design ×N</text>
  <text x="259" y="96" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--ochre)">review</text>
  <text x="332" y="96" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">plan</text>
  <text x="405" y="96" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">code</text>
  <text x="478" y="96" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-quiet)">land</text>
  <text x="40" y="118" font-family="var(--font-mono)" font-size="9" fill="var(--text-distant)" letter-spacing="0.06em">▢ asks on ambiguity · ■ always pauses · ⛩↺ gates repair on their own</text>
</svg>
<figcaption style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-distant);margin-top:0.6rem">A fixed rail: your marks run along the whole graph. Gates repair without you; the seal at review always waits for you.</figcaption>
</figure>

**Who holds the plan?** You do. The pipeline is code: versioned, the same nineteen-stage graph every run, not improvised per run. The dynamic-workflow pitch inverts this frame. A fixed workflow is generic, they argue, while a freshly written harness is tailor-made for your task. But fixed isn't generic. It is *specialized for one job, and it learns*.

One repair arm shows the grain of that learning. In this pipeline, what a stage sees is a declared contract, not ambient context. There is no orchestrator holding findings in its head; the runner is deterministic code, and artifacts flow only along each stage's `reads`. The `elaborate` stage declares `reads: ["plans"]`, and its fanout hands each unit exactly one line: the plan path plus its phase number. Route a code-gate failure back through it, and the five verdict files would sit unread on their own channel while every unit rewrote its phase blind. The gate's typical failures live in the plan text anyway (a fabricated edit anchor, a drifted line citation, a naming collision across phases), out of reach of a per-phase code rewrite. And a fresh rewrite sometimes regressed a dimension that had already passed. So the fix arm is `amend` instead. It declares `reads: ["plans", fanin("code-verdicts")]`, so the runner hands it the plan plus every verdict as labelled flags, and it edits only what the findings cite before the gate re-judges. The coverage check is the same kind of lesson: it anchors to the first cut you confirmed, so a re-slice can't pass by deleting the evidence.

A harness improvised per run relearns none of this. And tailor-made cuts the other way too. A process that changes every run is one you can never certify, never tune stage by stage, and never trust on run N because run N−1 went well. Repeatability isn't the compromise. For work you have to live with, it's the feature.

**Who checks the work?** Programs first. The slice gate is a script that passes or fails with zero LLM calls. The code splice is deterministic too, and its result goes straight back under the code panel's judgment. Coverage conservation means a re-slice can redistribute your brief but never quietly drop a piece of it. Fresh-context panels second: one session per quality dimension, blind to the transcript that produced the artifact. You third. And the goal artifact makes "you" enforceable. Your brief is captured byte-for-byte before anything runs. Completeness, correctness, and final validation are all graded against that file, not against the plan's own claims. The fix for the verification bottleneck isn't more agents checking agents.

**When are you asked?** Mostly when the code can't decide: a research ambiguity, the slice-cut confirm, a genuine design fork, a mismatch `implement` can't reconcile. Two quick confirms bracket the run, one before research writes its document and one before commit lands. And one pause carries real judgment: the design review. Every slice's design arrives in one consolidated summary. Adjusting an interface cascades to its dependents before synthesis. One high-leverage design decision instead of either extreme: not the approval fatigue of confirming every step, not the blind autonomy of confirming none.

The economics fall out of the same structure. Everything between gates fans out: designs per slice, panel dimensions, code per phase, each in a session that carries only its slice of the problem. The rigor is parallel rather than sequential. And the bounded context per session is precisely why affordable open-weight models hold up in the drafting seats.

## Side by side

Scored for the job named above: a feature landing in a codebase you own.

| | Dynamic workflows | /goal | rpiv build |
|---|---|---|---|
| Who writes the process | The model, fresh each run | Nobody; the agent free-runs | You; versioned code, the same graph every run |
| Who checks the work | Models check models | One evaluator judges a stop condition | Programs, then fresh-context panels, then you |
| Intent custody | Your prompt, read once by the script-writer | A condition you paraphrased | Your brief, byte-for-byte, conserved and graded against |
| When you're asked | At launch; after that, only permission prompts | Never | On real ambiguity, plus a design gate and two quick confirms |
| Repeatability | Improvised per run; can be saved and rerun | No process to repeat | The same nineteen stages every run |
| Cost profile | High; token use is their own stated caveat | Low overhead, unbounded runtime | Heavy for small changes; parallel and cheap-model-friendly at scale |
| Best at | Breadth: audits, sweeps, mass migrations | Measurable end states | A feature you must live with |

## What ours costs

Fairness cuts both ways, so here is our side of the ledger. `build` is heavy machinery: nineteen stages and two five-dimension panels are the wrong tool for a two-file fix. That is why the ladder below it exists (chat, `/skill:blueprint`, `/wf vet`), and the honest advice is to stay low on it until decomposition itself is the work. The design gate means the run needs you once; it is not overnight fire-and-forget. There are exactly three shapes. Work that is neither a brief, a diff, nor an architecture review means authoring your own graph, or reaching for their tools. And mass parallel mutation in isolated worktrees, the headline migration story on their side, is theirs today: worktree isolation sits on our roadmap, not in the box.

## Pick by the work, not the brand

These aren't three competitors for one job. Condition-driven persistence is right when the end state is measurable and the path is disposable. Model-written orchestration is right when breadth beats precision and no single finding is load-bearing. A fixed, gated pipeline is right for the work you'd never blind-delegate: a feature landing in a codebase you have to live with, where the ask must not shrink, the interfaces deserve one real decision, and the diff carries your name.

The delegation gap closes from both ends. Their end widens what agents can do unattended. Ours narrows what actually needs attending: one seal.
