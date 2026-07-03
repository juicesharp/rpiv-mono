---
name: implement
description: Execute an approved implementation plan from .rpiv/artifacts/plans/ phase by phase, applying changes and verifying each phase against its success criteria before moving on. Use when the user invokes /implement, asks to "implement this plan", or wants an existing phased plan executed. Pair with revise to update plans mid-flight and validate to confirm completion.
argument-hint: "[plan-path] [Phase N]"
allowed-tools: Read, Edit, Write, Bash(*), Glob, Grep
disable-model-invocation: true
contract:
  produces:
    kind: side-effect
    meta:
      effect: code-mutation
  consumes:
    reads:
      plans:
        meta:
          artifactKind: plan
---

# Implement

You are tasked with implementing an approved technical plan from `.rpiv/artifacts/plans/`. These plans contain phases with specific changes and success criteria.

## Input

$ARGUMENTS

The input above is `<plan-path> [phase]`:
- First token is the plan path under `.rpiv/artifacts/plans/`.
- Anything after it (e.g. "Phase 2") names a single phase to scope to.

Rules:
- If a phase is named → **single-phase (sequenced lane) mode.** Phases run **sequentially, in the plan's dependency order**, so every earlier phase has **already landed its files** — your prerequisites are present in the working tree. Implement **ONLY the named phase**, touching **only the files that phase owns**. Hard rules for this mode:
  - **Never implement, create, or edit another phase's files** — not even if one is missing. You are one unit of a sequenced run; back-filling another phase's work duplicates it and corrupts the next lane.
  - **A genuinely missing prerequisite is a hard error, not a decision.** If a file your phase must read or edit (one an earlier phase owns) is absent, **STOP and fail** with `prerequisite missing: <path> (expected from an earlier phase)`. Do **not** create it, do **not** `ask_user_question` about it, and do **not** defer your own edits — fail loudly so the run surfaces the ordering defect.
  - **Never silently defer your phase's own edits.** Apply every change the named phase owns, or fail. A phase that writes a partial slice and checks off nothing is worse than a clean failure.
  - Do not read, edit, or check off other phases' sections. Stop and print the closing block as soon as the named phase's own success criteria pass.
- If no phase is named → **sequential full-plan mode:** implement every phase in the plan sequentially.
- If the input is empty or the plan path is missing/literal, ask the user for the plan path before proceeding.

## Getting Started

With a plan path in hand:
- Read the plan completely for context (overview, ordering constraints, other phases' file changes yours may build on). In **single-phase mode**, do **not** scan for checkmarks as a resume signal: any `- [x]` outside the named phase is a sibling lane's in-flight progress, not prior-completed work. Checkmarks only matter within the named phase's own section.
- Read the original ticket and all files mentioned in the plan
- **Read files fully** - never use limit/offset parameters, you need complete context
- Think deeply about how the pieces fit together
- Create a todo list to track your progress
- Start implementing if you understand what needs to be done

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:
- Follow the plan's intent while adapting to what you find
- In sequential full-plan mode, implement each phase fully before starting the next. In **single-phase mode** there is no "next" — you implement only the named phase (its prior phases run concurrently in other lanes and are not guaranteed done)
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections — in **single-phase mode**, only within the named phase's own section; never touch another phase's `- [ ]` / `- [x]`

When things don't match the plan exactly, think about why and communicate clearly. The plan is your guide, but your judgment matters too.

If you encounter a mismatch:
- STOP and think deeply about why the plan can't be followed
- Present the issue clearly:
  ```
  Issue in Phase {N}:
  Expected: {what the plan says}
  Found: {actual situation}
  Why this matters: {explanation}

  ```

  Use the `ask_user_question` tool to resolve the mismatch. Question: "{Brief summary of the mismatch}". Header: "Mismatch". Options: "Follow the plan" (Adapt the plan's approach to the current code state); "Skip this change" (Move on without this change — it may not be needed); "Update the plan" (The plan needs to be revised before continuing).

## Verification Approach

After implementing a phase:
- **Sequential full-plan mode:** run the success criteria checks (usually `make check test` covers everything).
- **Single-phase mode:** run **only the commands under the named phase's own `#### Automated Verification:` block** — and flip exactly those `- [ ]` → `- [x]`. Do **not** gate completion on the whole `make check test` / full-test suite: that runs sibling phases' not-yet-present code and is the downstream `validate` stage's job (whole-plan / cross-phase validation), not implement's.
- Fix any issues before proceeding
- Update your progress in both the plan and your todos
- Check off completed items in the plan file itself using Edit
- If the input scopes you to a single phase, stop immediately after the named phase's own checks pass — do not advance to other phases

Don't let verification interrupt your flow - batch it at natural stopping points.

## If You Get Stuck

When something isn't working as expected:
- First, make sure you've read and understood all the relevant code
- Consider if the codebase has evolved since the plan was written
- Present the mismatch clearly and ask for guidance

Use skills sparingly - mainly for targeted debugging or exploring unfamiliar territory.

## Resuming Work

These resume heuristics assume **sequential** accumulation and apply to **sequential full-plan mode** only:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

In **single-phase mode**, ignore checkmarks outside the named phase entirely — they are sibling lanes' parallel progress, not a base to build on. Resume logic applies **only within the named phase's own section**: if your phase's own `#### Automated Verification:` items are already `- [x]` from a prior run of this same lane, trust those; otherwise implement the named phase's changes per the plan regardless of checkbox state elsewhere.

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.

## Present and Chain

When the last in-scope phase is complete, print the **completion** closing block:

```
Implementation complete:
`.rpiv/artifacts/plans/{filename}.md`

{P} phases completed, {M} files changed, {T} tests passing.
Outstanding: none.

Please review the diff and let me know if anything should reopen a phase.

---

💬 Follow-up: surface code/plan mismatches inline via the `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan") — that is implement's only in-skill follow-up surface. For plan-level changes run `/skill:revise <plan-path>`; for session pauses run `/skill:create-handoff`.

**Next step:** `/skill:validate .rpiv/artifacts/plans/{filename}.md` — verify the implementation against the plan's success criteria before committing.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

If the run was paused mid-plan rather than completed, print the **paused** variant instead:

```
Implementation paused at Phase {N}:
`.rpiv/artifacts/plans/{filename}.md`

{P} phases completed, {M} files changed, {T} tests passing.
Outstanding: {list of unchecked items, blockers}.

Please review what landed and let me know if anything needs to change before resuming.

---

💬 Follow-up: surface code/plan mismatches inline via the `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan") — that is implement's only in-skill follow-up surface. For plan-level changes run `/skill:revise <plan-path>` first.

**Next step:** `/skill:create-handoff` — capture in-flight state so the next session can resume cleanly via `/skill:resume-handoff`.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

## Handle Follow-ups

- **Implement owns checkboxes, not plan content.** Check off `#### Automated Verification:` items `- [ ]` → `- [x]` as each phase's checks pass. Everything else is revise's — run `/skill:revise <plan-path>`; never rewrite plan content from inside implement.
- **For plan-level changes.** Run `/skill:revise <plan-path>` first — it appends a timestamped Follow-up section to the plan and preserves history. Then resume implement at the affected phase.
- **For session pauses.** Run `/skill:create-handoff` to capture in-flight state, then `/new` and `/skill:resume-handoff` in the next session.
- **Mismatch handling stays inline.** When code reality diverges from the plan, use the inline `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan") — that is implement's only follow-up surface; everything else escalates to revise or create-handoff.
