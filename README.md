# rpiv-mono

[![CI](https://img.shields.io/github/actions/workflow/status/juicesharp/rpiv-mono/ci.yml?branch=main&label=CI)](https://github.com/juicesharp/rpiv-mono/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/juicesharp/rpiv-mono/branch/main/graph/badge.svg?v=2)](https://codecov.io/gh/juicesharp/rpiv-mono)
[![tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/juicesharp/rpiv-mono/badges/tests.json)](https://github.com/juicesharp/rpiv-mono/actions/workflows/ci.yml)

Monorepo for Pi CLI extensions in the `@juicesharp/rpiv-*` family. Lockstep versions, single install, single publish pipeline.

## Packages

| Package | Description |
|---|---|
| [`@juicesharp/rpiv-pi`](packages/rpiv-pi) | Umbrella extension — skill-based workflow.<br>Default: `discover` → `research` → `design` → `plan` → `implement` → `validate`<br>One-shot: `research` → `blueprint` → `implement` → `validate`<br>Ship: `code-review` ↔ `commit` (interchangeable order); mid-flight: `revise` |
| [`@juicesharp/rpiv-advisor`](packages/rpiv-advisor) | `advisor` tool + `/advisor` — escalate to a stronger reviewer model |
| [`@juicesharp/rpiv-args`](packages/rpiv-args) | `$1`/`$ARGUMENTS`/`$@`/`${@:N}` — shell-style placeholder substitution in skill bodies |
| [`@juicesharp/rpiv-ask-user-question`](packages/rpiv-ask-user-question) | `ask_user_question` tool — structured clarifying-question selector |
| [`@juicesharp/rpiv-btw`](packages/rpiv-btw) | `/btw` slash command — side-question without polluting main transcript |
| [`@juicesharp/rpiv-i18n`](packages/rpiv-i18n) | i18n SDK for Pi extensions — `/languages` picker + `--locale` flag + `registerStrings`/`scope`/`tr` API; 8 languages OOTB |
| [`@juicesharp/rpiv-todo`](packages/rpiv-todo) | `todo` tool + `/todos` overlay — Claude-Code-parity task tracking |
| [`@juicesharp/rpiv-warp`](packages/rpiv-warp) | Native [Warp](https://warp.dev) terminal toasts via `OSC 777` for Pi lifecycle events — opt-in, not auto-installed by `/rpiv-setup` |
| [`@juicesharp/rpiv-web-tools`](packages/rpiv-web-tools) | `web_search` + `web_fetch` tools — backed by Brave Search API |

Each package is published independently to npm and installable by name:

```bash
pi install npm:@juicesharp/rpiv-pi
pi install npm:@juicesharp/rpiv-advisor
# …
```

`@juicesharp/rpiv-pi` registers the core siblings (see [`siblings.ts`](packages/rpiv-pi/extensions/rpiv-core/siblings.ts)); `/rpiv-setup` installs any that are missing. Other packages (e.g. `rpiv-warp`) are opt-in — install them explicitly with `pi install`.

## Roadmap

1. **Discovery becomes a subagent.** The current `discover` skill's responsibilities move into a specialized subagent invoked automatically inside the main flow, so it stops being a step the user has to think about.
2. **Repurpose `discover` for decision-tree interviews.** With the name freed, `discover` is rebuilt as a rigorous up-front interview skill: one question at a time, each paired with a recommended answer, the agent self-resolving anything answerable from the codebase rather than asking the user.
3. **Task-slug-based `thoughts/` layout.** Move `thoughts/` from artifact-grouped folders (`questions/`, `research/`, `designs/`, …) to task-slug-grouped folders, so every artifact for a given task lives under one slug and any pipeline stage can resolve the full bundle by name.
4. **Pipeline tuning.** Latency, token efficiency, and precision — rolling work across all stages.

### Not planned

- **Backward compatibility of skill bodies and `thoughts/` artifact shapes.** Both are treated as live; expect breaking changes between versions.

## Development

```bash
npm install          # one install at root; workspace symlinks under node_modules/
npm run check        # biome + tsc --noEmit across all packages
npm test             # forwarded to packages that declare a test script
```

Pre-commit hooks (husky) run `npm run check` before every commit; pre-push runs the full coverage suite.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request:

- Matrix on Node 20 + 22 — `npm run check` (Biome + `tsc --noEmit`) then `npm run coverage` (full Vitest + V8 coverage).
- Coverage uploads to [Codecov](https://codecov.io/gh/juicesharp/rpiv-mono) via tokenless OIDC (public-repo).
- On `main` pushes, a follow-up job parses Vitest's JSON output and publishes a `{passed} / {total}` shields-endpoint badge to the orphan `badges` branch.

## Releasing

All packages version in lockstep. One command cuts a release of all of them:

```bash
node scripts/release.mjs patch     # e.g. 0.6.0 → 0.6.1
node scripts/release.mjs minor     # 0.6.0 → 0.7.0
node scripts/release.mjs major     # 0.6.0 → 1.0.0
node scripts/release.mjs 1.2.3     # explicit version
```

The script bumps every `packages/*/package.json`, promotes each package's `## [Unreleased]` CHANGELOG heading to `## [X.Y.Z] - YYYY-MM-DD`, commits, tags `vX.Y.Z`, runs `npm publish -ws --access public`, reinstates a fresh `## [Unreleased]` block, and pushes `main` + tag.

## License

[MIT](LICENSE) © juicesharp
