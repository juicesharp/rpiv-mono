---
title: "Three answers to the delegation gap"
description: "Dynamic workflows, /goal loops, and a gated pipeline are three different answers to the same question: what would it take to actually hand work over? A comparison, and where rpiv deliberately sits."
pubDate: 2026-07-03T13:00:00Z
author: juicesharp
tags: ["positioning", "workflows", "rpiv-pi"]
draft: true
---

Anthropic's 2026 agentic-coding trends report names the industry's open wound precisely: developers use coding agents constantly and fully delegate almost nothing. The report calls it the **delegation gap**, and names its cause just as precisely — verification is the bottleneck. Everyone can generate; nobody trusts the result enough to stop watching.

Three product answers to that gap are on the table right now. They look similar from a distance — all of them orchestrate multiple agent sessions toward a goal — but they make opposite bets on the question that matters: *who holds the plan, who checks the work, and when do you get asked?*

## Answer one: the model writes the process

Claude Code's dynamic workflows have the model author a fresh orchestration script per run — fan-out, verifier agents that adversarially cross-check findings, grader loops — and execute it in the background. It is genuinely impressive machinery, and its own docs state its human-interaction contract plainly: **no mid-run user input**. If you want sign-off between stages, you split the work into separate runs. The plan is held by a script the model wrote minutes ago; verification is models checking models; you are asked at launch, and then not at all.

This is the right shape for *breadth* work: exhaustive audits, research sweeps, migrations where volume wins and any individual miss is cheap.

## Answer two: nobody holds a process

`/goal` sets a completion condition and lets the agent free-run until a fresh evaluator judges the condition met. There is no process at all — that's the appeal. Persistence replaces structure: "keep going until CI is green" is a perfectly good contract when the end state is measurable and the path doesn't matter.

Note what the goal is here: a stop condition *you paraphrased* from your intent, capped at a few thousand characters, judged against the transcript. It answers "when to stop," not "did you build what I asked, the way my codebase wants it."

## Answer three: a fixed pipeline with judgment seams

rpiv's `build` makes the opposite bet on all three questions.

**Who holds the plan?** You do. The pipeline is code — versioned, the same nineteen-stage graph every run, not improvised per run. Its structure encodes accumulated scar tissue: every gate exists because some failure mode earned it.

**Who checks the work?** Programs first: the slice gate and the code splice are scripts that pass or fail with zero LLM calls — coverage conservation means a re-slice can redistribute your brief but never quietly drop a piece of it. Fresh-context panels second: one session per quality dimension, blind to the transcript that produced the artifact. You third — and the goal artifact makes "you" enforceable: your brief is captured byte-for-byte before anything runs, and completeness, correctness, and final validation are all graded against that file, not against the plan's own claims. The fix for the verification bottleneck isn't more agents checking agents.

**When are you asked?** Only when the code can't decide — a research ambiguity, the slice-cut confirm, a genuine design fork — and always exactly once, at the design review: every slice's design in one consolidated summary, where adjusting an interface cascades to its dependents before synthesis. One high-leverage decision instead of either extreme: not the approval fatigue of confirming every step, not the blind autonomy of confirming none.

The economics fall out of the same structure. Because everything between gates fans out — designs per slice, panel dimensions, code per phase, each in a session that carries only its slice of the problem — the rigor is parallel rather than sequential, and the bounded context per session is precisely why affordable open-weight models hold up in the drafting seats.

## Pick by the work, not the brand

These aren't three competitors for one job. Condition-driven persistence is right when the end state is measurable and the path is disposable. Model-written orchestration is right when breadth beats precision and no single finding is load-bearing. A fixed, gated pipeline is right for the work you'd never blind-delegate: a feature landing in a codebase you have to live with, where the ask must not shrink, the interfaces deserve one real decision, and the diff carries your name.

The delegation gap closes from both ends. Their end widens what agents can do unattended. Ours narrows what actually needs attending — to one seal.
