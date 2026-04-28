# Changelog

All notable changes to `@juicesharp/rpiv-advisor` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
