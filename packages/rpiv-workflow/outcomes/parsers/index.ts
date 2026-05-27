/**
 * Bundled parsers — host-agnostic primitives that turn collected
 * artifacts into the typed `output.data` channel downstream stages
 * see. Re-exported through `outcomes/index.ts`.
 *
 * Format-specific parsers (`frontmatterParser` for markdown-with-YAML)
 * live in the convention layer that owns them — rpiv-pi ships its
 * own. The framework ships only universal interpretations.
 */

export { jsonBodyParser } from "./json-body.js";
