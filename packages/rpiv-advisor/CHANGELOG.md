# Changelog

All notable changes to `@juicesharp/rpiv-advisor` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.18.0] - 2026-06-04

### Changed
- Persisted model keys now use the canonical `provider/modelId` (slash) form; legacy `provider:modelId` (colon) entries are still read and matched, and configs auto-migrate to slash form on the next `/advisor` save. Rollback caveat: rolling back across this release without first re-running `/advisor` can silently disable the advisor, since the older key parser is colon-strict.

## [1.17.1] - 2026-06-01

## [1.17.0] - 2026-06-01

## [1.16.1] - 2026-05-30

## [1.16.0] - 2026-05-30

### Added
- Fuzzy type-to-filter in `/advisor` model and reasoning-level pickers — start typing to narrow a long model list, with contiguous-run and word-boundary ranking; matches both the model name and the `provider:id` key.

### Fixed
- Effort level is now captured once at invocation, preventing desync between reported and actual effort after concurrent `/advisor` commands.

## [1.15.0] - 2026-05-28

## [1.14.7] - 2026-05-28

## [1.14.6] - 2026-05-28

## [1.14.5] - 2026-05-28

## [1.14.4] - 2026-05-28

## [1.14.3] - 2026-05-28

## [1.14.2] - 2026-05-28

## [1.14.1] - 2026-05-28

## [1.14.0] - 2026-05-28

## [1.13.0] - 2026-05-25

## [1.12.0] - 2026-05-21

## [1.11.0] - 2026-05-20

### Changed
- Relocate npm + MIT badges from the cover area to the License section in README.

## [1.10.2] - 2026-05-20

### Changed
- Refresh npm cover (`docs/cover.{svg,png}`) to share the unified card layout used across the `@juicesharp/rpiv-*` family.

## [1.10.1] - 2026-05-19

## [1.10.0] - 2026-05-19

## [1.9.2] - 2026-05-19

## [1.9.1] - 2026-05-19

## [1.9.0] - 2026-05-18

### Added
- Effort-level filtering for `disabledForModels` — block advisor behavior only when the executor's thinking level meets or exceeds a configurable threshold, with immediate strip/re-add on mid-session effort changes.

## [1.8.3] - 2026-05-18

## [1.8.2] - 2026-05-17

## [1.8.1] - 2026-05-17

### Fixed
- `/advisor` settings now persist to disk before applying in memory, preventing silent reverts on write failure.

## [1.8.0] - 2026-05-16

## [1.7.0] - 2026-05-15

### Added
- Per-executor-model blocklist in `advisor.json` — name executor models that should keep the advisor tool inactive, avoiding prompt-cache and tool-schema cost for strong models.

## [1.6.1] - 2026-05-14

### Fixed
- `advisor` now uses Pi's resolved session context after a `session_compact`, so escalations no longer replay stale pre-compaction history.

## [1.6.0] - 2026-05-14

## [1.5.2] - 2026-05-13

### Added
- Configurable LLM guidance overrides via package config.

## [1.5.1] - 2026-05-13

## [1.5.0] - 2026-05-12

## [1.4.2] - 2026-05-11

## [1.4.1] - 2026-05-11

## [1.4.0] - 2026-05-10

## [1.3.1] - 2026-05-10

## [1.3.0] - 2026-05-08

## [1.2.1] - 2026-05-07

## [1.2.0] - 2026-05-07

## [1.1.5] - 2026-05-05

### Documentation
- README: added Tool + Schema section so consumers can see the `advisor` tool surface without reading the source.

## [1.1.4] - 2026-05-03

## [1.1.3] - 2026-05-03

## [1.1.2] - 2026-05-03

## [1.1.1] - 2026-05-03

## [1.1.0] - 2026-05-03

## [1.0.19] - 2026-05-03

## [1.0.18] - 2026-05-02

## [1.0.17] - 2026-05-02

### Changed
- Rename `ensureUserTail` → `ensureUserTailForAdvisor` to match the file's domain-qualified verb-noun naming (`stripInflightAdvisorCall`, `getInventoryMessage`). Inline `ADVISOR_NUDGE_TEXT` consolidated into the `MSG_*` block as `MSG_ADVISOR_NUDGE`. Inverted the role early-return to `last.role !== "assistant"` to mirror `stripInflightAdvisorCall` and stay safe under future `Message` union additions. Behavior unchanged.

## [1.0.16] - 2026-05-02

### Fixed
- Append a synthetic user-role nudge after `stripInflightAdvisorCall` when the trailing assistant message had text content preceding the in-flight `advisor()` call. Recent Anthropic Claude models reject payloads ending on an assistant turn with `"This model does not support assistant message prefill. The conversation must end with a user message."`. The new `ensureUserTail` step guarantees user-tail without disturbing prior toolCall/toolResult chains. Exported from `advisor.ts` for unit tests.

## [1.0.15] - 2026-05-02

### Fixed
- Restore compatibility with `@mariozechner/pi-ai` ≥ 0.72.0. The 0.72.0 release removed `supportsXhigh` in favor of `getSupportedThinkingLevels(model): ModelThinkingLevel[]`; `/advisor` was crashing with `(0 , _piAi.supportsXhigh) is not a function` on Pi runtimes shipping the new pi-ai. The effort picker now derives xhigh availability from `getSupportedThinkingLevels(picked).includes("xhigh")`.

## [1.0.14] - 2026-05-01

### Changed
- Cover redesigned as a macOS-style terminal-window screenshot with an EXECUTOR → `advisor()` → ADVISOR handoff diagram and PLAN/CORRECT/STOP outputs.

## [1.0.13] - 2026-05-01

### Added
- `docs/vertical-cover.{svg,png}` — portrait-orientation hero artwork (1280×800 canvas; PNG downscaled to 320×711).

### Changed
- Cover canvas extended from 1280×640 to 1280×800 with refreshed crop marks/footer.
- README hero swapped from `docs/cover.png` to `docs/vertical-cover.png`, rendered at `width="160"`. The `<a>` wrapper around the `<picture>` was removed so the image is no longer a clickable link to the package directory.

## [1.0.12] - 2026-05-01

### Added
- `docs/cover.png` — package hero (rasterized from `docs/cover.svg` via `rsvg-convert`, 1280×640).

### Changed
- README hero: open with a `<picture>`-wrapped `cover.png` above the shield badges so pi.dev's package-card image extractor picks the friendly artwork instead of the npm version shield. Existing `docs/advisor.jpg` screenshot retained below the description.

## [1.0.11] - 2026-04-30

### Changed
- README rewritten with a user-outcome opener ("Let the model ask a stronger model for a second opinion before it acts") and a new `## Features` section covering the reviewer-model picker, `~/.config/rpiv-advisor/advisor.json` persistence (chmod 0600), off-by-default exclusion, and zero-parameter handoff. `package.json` `description` synced.

## [1.0.10] - 2026-04-30

## [1.0.9] - 2026-04-30

## [1.0.8] - 2026-04-29

## [1.0.7] - 2026-04-29

## [1.0.6] - 2026-04-29

## [1.0.5] - 2026-04-29

## [1.0.4] - 2026-04-28

## [1.0.3] - 2026-04-28

## [1.0.2] - 2026-04-28

## [1.0.1] - 2026-04-28

## [1.0.0] - 2026-04-28

## [0.13.0] - 2026-04-28

## [0.12.7] - 2026-04-26

## [0.12.6] - 2026-04-26

## [0.12.5] - 2026-04-24

## [0.12.4] - 2026-04-24

## [0.12.3] - 2026-04-24

## [0.12.2] - 2026-04-24

## [0.12.1] - 2026-04-24

## [0.12.0] - 2026-04-24

## [0.11.7] - 2026-04-23

## [0.11.6] - 2026-04-22

## [0.11.5] - 2026-04-22

## [0.11.4] - 2026-04-21

## [0.11.3] - 2026-04-21

## [0.11.2] - 2026-04-21

## [0.11.1] - 2026-04-20

## [0.11.0] - 2026-04-20

### Added
- `stripInflightAdvisorCall(messages)` and `stableStringify(value)` are now exported from `advisor.ts` so the 8 strip-path branches and the key-sorted JSON serializer can be unit-tested directly. Bodies and semantics unchanged.

## [0.10.0] - 2026-04-20

### Added
- `loadAdvisorConfig()` and `saveAdvisorConfig(key, effort)` are now exported from `advisor.ts` to unlock config-axis round-trip tests. Bodies and semantics unchanged — still best-effort writes to `~/.config/rpiv-advisor/advisor.json` with `chmod 0600`.

## [0.9.1] - 2026-04-20

## [0.9.0] - 2026-04-19

## [0.8.3] - 2026-04-19

## [0.8.2] - 2026-04-19

## [0.8.1] - 2026-04-19

## [0.8.0] - 2026-04-19

## [0.7.0] - 2026-04-18

### Changed
- Forward raw `Message[]` + a stable tool-inventory message to the advisor model instead of the text-serialized conversation. Removes the 2000-char tool-result cap, restores structural fidelity (ToolCall IDs, text/toolCall interleaving, image content, assistant metadata), and positions the inventory for Anthropic's tools-tail-adjacent cache breakpoint. Inventory is signature-cached per process under `globalThis[Symbol.for("rpiv-advisor")]` and invalidates only when the registered tool-name set changes.
- Append one sentence to the advisor system prompt noting the prepended tool inventory.

### Fixed
- Strip the executor's in-flight `advisor()` toolCall from the tail before forwarding so providers (Anthropic, GLM/zai, OpenAI) don't reject the payload with an orphan-toolCall error.

## [0.6.1] - 2026-04-18

## [0.6.0] — 2026-04-18

### Changed
- Consolidated into the `juicesharp/rpiv-mono` monorepo. Version aligned to the rpiv-pi family lockstep starting point. No runtime behavior change from `0.1.3`.
