---
title: "Install rpiv-pi"
description: "Install rpiv-pi, wire its siblings, and run your first pipeline session."
section: "getting-started"
order: 0
---

rpiv-pi is the umbrella package. It ships the skill library and runtime infrastructure, but the **tools the skills call** live in sibling Pi extensions (`rpiv-todo`, `rpiv-ask-user-question`, `rpiv-web-tools`, and friends). That's why setup is three steps, not one.

## 1. Install the umbrella

From your shell:

```bash
pi install npm:@juicesharp/rpiv-pi
```

The `npm:` prefix tells Pi to resolve the package from the npm registry. Without it, Pi looks for a local path and the install fails.

## 2. Wire the siblings

Start a Pi session in any project, then run:

```
/rpiv-setup
```

`/rpiv-setup` reads `~/.pi/agent/settings.json`, previews every missing sibling plugin alongside any legacy entries to prune, and waits for one confirm before applying. You see exactly what's about to change.

## 3. Restart Pi

Quit and relaunch your Pi Agent session so the freshly-installed siblings load. The skills won't find their tools until the runtime sees the new extensions.

## Quick start: your first skill

Inside Pi, start the pipeline:

```
/skill:discover
```

The `discover` skill interviews you one question at a time to capture intent **before any code is read**. From there, rpiv-pi chains `discover → research → design → plan → implement → validate`. You keep answering questions, the skills do the work.

How much of that chain you run scales with the size of the feature. On large or architecturally load-bearing work, `design` and `plan` stay separate steps, each in its own context window. On smaller and mid-size work, `/skill:blueprint` collapses both into a single pass. [Pick your path](/docs/guides/pick-a-path) maps each scope to its chain.

## Next steps

- [Pick your path](/docs/guides/pick-a-path): five paths mapped to feature scope (trivial to large)
- [Walk the chain](/docs/guides/first-skill-chain): the mid-size path demonstrated on a real example
- [Reset between skills](/docs/guides/reset-between-skills): the fresh-context rule between every transition
- [Handoffs](/docs/guides/handoffs): pause the pipeline and resume from a fresh session
- [Onboard a project](/docs/guides/onboard-a-project): annotate a brownfield codebase before the first run
- [Skills reference](/docs/reference/skills): every skill at a glance
- [Agents reference](/docs/reference/agents): every specialist subagent at a glance
