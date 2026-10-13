/**
 * Agent sync — frontmatter injection (pure transform).
 *
 * Layer 4 of the agents-*.ts family: string-in/string-out only. Consumes the
 * enablement map (agent-enablement), the frontmatter scanner (frontmatter), and
 * the models.json override reader (models-config). The sync engine
 * (agents-sync) applies this transform before hashing so the manifest records
 * hash-after-transform.
 */

import { mergeCsvAdditions, mergeFlowSeqAdditions, resolveAgentEnablement } from "./agent-enablement.js";
import { parseFrontmatterBounds, readFrontmatterKey } from "./frontmatter.js";
import { getAgentModelConfig, type ModelsConfig } from "./models-config.js";

// ---------------------------------------------------------------------------
// Frontmatter injection — pure transform
// ---------------------------------------------------------------------------

/**
 * Apply key-value updates to frontmatter lines.
 *
 * For each key in `keysToSet`, replaces the existing line if present
 * (within the frontmatter bounds), or inserts a new line before the
 * closing `---`. Returns the (possibly modified) lines array.
 *
 * The closing-fence index (`bounds.end`) is stable across in-place
 * replacements — only the value changes, not the line count — so the
 * insertion point remains correct without re-scanning.
 */
function applyKeyUpdates(
	lines: string[],
	bounds: { start: number; end: number },
	keysToSet: { key: string; value: string }[],
): string[] {
	const result = [...lines];
	const insertLines: string[] = [];

	for (const { key, value } of keysToSet) {
		const prefix = `${key}: `;
		const existingIdx = result.findIndex((line, i) => i > 0 && i < bounds.end && line.startsWith(prefix));
		if (existingIdx !== -1) {
			result[existingIdx] = `${prefix}${value}`;
		} else {
			insertLines.push(`${prefix}${value}`);
		}
	}

	if (insertLines.length > 0) {
		result.splice(bounds.end, 0, ...insertLines);
	}

	return result;
}

/**
 * Install-gate context for conditional frontmatter injection.
 *
 * `installedExtensions` is the set of installed sibling extension names,
 * derived from ONE settings read per sync pass. An absent context closes
 * the enablement gate entirely — today's model/thinking-only behavior,
 * byte-for-byte.
 */
export interface AgentInjectionContext {
	readonly installedExtensions: ReadonlySet<string>;
}

/**
 * Inject model/thinking + conditional enablement frontmatter into agent .md content.
 *
 * Idempotent: re-injecting produces identical bytes, with the gate open or
 * closed. The function finds the closing `---` of the YAML frontmatter
 * block and deterministically inserts or replaces keys.
 *
 * Enablement (fourth arg): when the context names every sibling provider an
 * agent's enablement requires as installed, the agent additionally gains
 * the merged `tools` CSV, an `extensions: [...]` flow sequence, and — only
 * when the shipped file carries `isolated: true` — the `isolated: false` +
 * `skills: false` pair. No override and no active enablement ⇒ content
 * unchanged.
 *
 * Exported so the idempotency invariant can be unit-tested directly:
 * `inject(inject(x)) === inject(x)` (see Verification Notes).
 */
export function injectModelFrontmatter(
	content: string,
	agentFile: string,
	config: ModelsConfig,
	injection?: AgentInjectionContext,
): string {
	// Strip .md extension — source entries are filenames like "codebase-analyzer.md"
	// but models.json keys are agent names like "codebase-analyzer".
	const agentKey = agentFile.replace(/\.md$/, "");
	const override = getAgentModelConfig(config, agentKey);
	const enablement = resolveAgentEnablement(agentKey, override, injection?.installedExtensions);
	// Tools-only entries must not be skipped: enablement alone proceeds.
	const hasModelKeys = override?.model !== undefined || override?.thinking !== undefined;
	if (!hasModelKeys && enablement === undefined) {
		return content;
	}

	const lines = content.split("\n");
	const bounds = parseFrontmatterBounds(lines);
	if (!bounds) return content;

	const keysToSet: { key: string; value: string }[] = [];
	// (post-slash-canonical migration): models.json values are byte-equal to
	// the agent frontmatter form (both `provider/modelId`). No translation step
	// — re-injecting produces identical bytes by construction; the idempotency
	// invariant at injectModelFrontmatter's JSDoc strengthens from "deterministic
	// translation" to "byte pass-through".
	if (override?.model !== undefined) keysToSet.push({ key: "model", value: override.model });
	if (override?.thinking !== undefined) keysToSet.push({ key: "thinking", value: override.thinking });

	if (enablement !== undefined) {
		// Fixed order [model?, thinking?, tools, extensions, isolated?, skills?]:
		// in-place replacements keep their shipped position; absent keys append
		// before the closing fence in this order.
		const mergedTools = mergeCsvAdditions(readFrontmatterKey(lines, bounds, "tools"), enablement.tools);
		const mergedExtensions = mergeFlowSeqAdditions(
			readFrontmatterKey(lines, bounds, "extensions"),
			enablement.extensions,
		);
		// ATOMIC transform (review 2026-08-31 I2): a merge that fail-soft-skips
		// an unmergeable frontmatter form (block-sequence, sentinel) while its
		// additions are non-empty means the grant CANNOT land — applying the
		// remaining keys anyway would flip `isolated`/`skills` off while
		// granting nothing, silently un-scoping the agent on every sync. Skip
		// the whole enablement key set and warn loudly instead.
		const toolsMergeFailed = enablement.tools.length > 0 && mergedTools === undefined;
		const extensionsMergeFailed = enablement.extensions.length > 0 && mergedExtensions === undefined;
		if (toolsMergeFailed || extensionsMergeFailed) {
			console.warn(
				`[rpiv-pi] agent enablement skipped for ${agentFile}: the ${toolsMergeFailed ? "tools" : "extensions"} frontmatter form is not mergeable (block sequence or sentinel value) — rewrite it as a ${toolsMergeFailed ? "single-line CSV scalar" : "flow sequence"} to receive the grant`,
			);
		} else {
			if (mergedTools !== undefined) keysToSet.push({ key: "tools", value: mergedTools });
			if (mergedExtensions !== undefined) keysToSet.push({ key: "extensions", value: mergedExtensions });
			// Flipping isolation is the point of enablement (`ext:` selectors are
			// dropped while isolated) — but derive the pair only when the source
			// declares `isolated: true`: re-injecting an already-injected form pushes
			// neither key (idempotency), and non-isolated agents stay untouched.
			if (readFrontmatterKey(lines, bounds, "isolated")?.toLowerCase() === "true") {
				keysToSet.push({ key: "isolated", value: "false" });
				keysToSet.push({ key: "skills", value: "false" });
			}
		}
	}

	const updated = applyKeyUpdates(lines, bounds, keysToSet);
	return updated.join("\n");
}
