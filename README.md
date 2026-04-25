# rpiv-mono

Monorepo for Pi CLI extensions in the `@juicesharp/rpiv-*` family. Lockstep versions, single install, single publish pipeline.

## Packages

| Package | Description |
|---|---|
| [`@juicesharp/rpiv-pi`](packages/rpiv-pi) | Umbrella extension — skill-based workflow: discover, research, design, plan, implement, validate |
| [`@juicesharp/rpiv-advisor`](packages/rpiv-advisor) | `advisor` tool + `/advisor` — escalate to a stronger reviewer model |
| [`@juicesharp/rpiv-args`](packages/rpiv-args) | `$1`/`$ARGUMENTS`/`$@`/`${@:N}` — shell-style placeholder substitution in skill bodies |
| [`@juicesharp/rpiv-ask-user-question`](packages/rpiv-ask-user-question) | `ask_user_question` tool — structured clarifying-question selector |
| [`@juicesharp/rpiv-btw`](packages/rpiv-btw) | `/btw` slash command — side-question without polluting main transcript |
| [`@juicesharp/rpiv-todo`](packages/rpiv-todo) | `todo` tool + `/todos` overlay — Claude-Code-parity task tracking |
| [`@juicesharp/rpiv-web-tools`](packages/rpiv-web-tools) | `web_search` + `web_fetch` tools — backed by Brave Search API |

Each package is published independently to npm and installable by name:

```bash
pi install npm:@juicesharp/rpiv-pi
pi install npm:@juicesharp/rpiv-advisor
# …
```

`@juicesharp/rpiv-pi` registers the others as siblings; `/rpiv-setup` installs any that are missing.

## Development

```bash
npm install          # one install at root; workspace symlinks under node_modules/
npm run check        # biome + tsc --noEmit across all packages
npm test             # forwarded to packages that declare a test script
```

Pre-commit hooks (husky) run `npm run check` before every commit.

## Releasing

All 7 packages version in lockstep. One command cuts a release of all of them:

```bash
node scripts/release.mjs patch     # e.g. 0.6.0 → 0.6.1
node scripts/release.mjs minor     # 0.6.0 → 0.7.0
node scripts/release.mjs major     # 0.6.0 → 1.0.0
node scripts/release.mjs 1.2.3     # explicit version
```

The script bumps every `packages/*/package.json`, promotes each package's `## [Unreleased]` CHANGELOG heading to `## [X.Y.Z] - YYYY-MM-DD`, commits, tags `vX.Y.Z`, runs `npm publish -ws --access public`, reinstates a fresh `## [Unreleased]` block, and pushes `main` + tag.

## License

[MIT](LICENSE) © juicesharp
