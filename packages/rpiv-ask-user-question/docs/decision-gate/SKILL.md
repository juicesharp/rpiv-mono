---
name: questionnaire-decision-gate
description: Ask one focused question before consequential or ambiguous decisions using ask_user_question. Opt-in migration example; preserve higher-priority approval rules.
---

# Questionnaire decision gate

## Responsibilities

The user owns scope, preferences, and approval for consequential actions. The agent
collects evidence and presents a bounded decision. `ask_user_question` collects the
answer; it does not authorize actions beyond that answer's scope.

## When to ask

Ask before choosing between materially different architecture, schema, API, deployment,
or security options; before costly-to-reverse changes; and when requirements conflict
or a consequential preference is unclear. Do not repeat a decision already made for
the same scope. Do not ask about routine steps covered by the user's request.

## Procedure

1. Read relevant source and constraints first. Do not ask the user to decide blind.
2. State a short, neutral context summary in chat, including the recommendation and trade-offs.
3. Invoke `ask_user_question` with exactly one question. Supply 2–4 meaningful options,
   each with a label and description. Never invent choices solely to satisfy the schema:
   if the question is genuinely open-ended, explain the tool limitation and follow the
   host's permitted clarification path instead.
4. Use `multiSelect` only for independent choices. Do not author `Other` or `Type something.`
   options; the tool supplies its own custom-answer row. Use previews only for concrete
   single-select artifact comparisons.
5. Restate the decision and proceed only within the approved scope.

## Cancellation and retry rules

- Cancellation, failure, silence, partial answers, and notes alone are not approval.
- Ask at most once per decision boundary, with one narrower follow-up only when the
  first response is unclear or cancelled. Never ask a third time at the same boundary.
- If a consequential decision remains unclear, stop and state the blocker.
- For a preference-only ambiguity, proceed with a reversible default only when the
  user explicitly delegates the choice.
- Reopen a decision only when new evidence creates a material uncertainty.

## Boundaries

This example is opt-in and tool-specific. It cannot override host instructions, broaden
delivery authority, or authorize publication, deployment, credential changes, or task updates.
