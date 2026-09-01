/**
 * Agent enablement — declarative knowledge of which bundled agents gain
 * sibling-provided `ext:` tools when the providing sibling is installed,
 * plus the pure gate/merge primitives that drive the conditional
 * frontmatter injection in agents.ts.
 *
 * Pure utility: no ExtensionAPI, no filesystem reads, never throws. The
 * enablement map names sibling extensions and tool selectors as plain
 * strings — presence detection stays in package-checks.ts (the SIBLINGS
 * registry is the single detection source; zero runtime imports of
 * sibling packages).
 */

/** What an agent gains when its enablement is active. */
export interface AgentEnablement {
	/** Sibling extension names the agent must be allowed to load. */
	readonly extensions: readonly string[];
	/** Tool selectors appended to the agent's `tools` frontmatter. */
	readonly tools: readonly string[];
}

/**
 * Configurable per-agent override fields — a structural subset of the
 * resolved models.json agent entry, kept local so this module stays
 * dependency-free.
 */
export interface AgentEnablementOverride {
	readonly extensions?: readonly string[];
	readonly tools?: readonly string[];
}

/**
 * Bundled-agent tool/extension grants, keyed by agent basename (sans .md).
 * A grant activates only while every named sibling is installed (the
 * install gate) — tool selectors byte-match the granting sibling's
 * registered tool names and its registry `provides` line.
 *
 * Currently EMPTY: the machinery ships dormant. The rpiv-lsp experiment
 * (preserved on the backup/lsp-experiment branch) is the reference
 * implementation for populating it when a sibling next ships agent-facing
 * tools; per-agent grants also remain fully reachable through models.json
 * `agents.<name>.tools/extensions` config with no map entry at all.
 */
export const AGENT_ENABLEMENT_GRANTS: Readonly<Record<string, AgentEnablement>> = {};

/**
 * Resolve the effective enablement for one agent, or undefined when
 * inactive. Configured arrays replace the map's field wholesale (an
 * explicit `[]` suppresses that field). Inactive when there is no
 * effective content, when no installed-extensions set was supplied (gate
 * closed), or when any named provider — the extensions list plus the
 * sibling prefix of each `ext:` tool selector — is not installed.
 * `grants` is injectable for tests; production call sites use the module
 * map default.
 */
export function resolveAgentEnablement(
	agentKey: string,
	config: AgentEnablementOverride | undefined,
	installedExtensions: ReadonlySet<string> | undefined,
	grants: Readonly<Record<string, AgentEnablement>> = AGENT_ENABLEMENT_GRANTS,
): AgentEnablement | undefined {
	const base = grants[agentKey];
	const extensions = config?.extensions !== undefined ? config.extensions : (base?.extensions ?? []);
	const tools = config?.tools !== undefined ? config.tools : (base?.tools ?? []);
	if (extensions.length === 0 && tools.length === 0) return undefined;
	if (installedExtensions === undefined) return undefined;
	for (const name of extensions) {
		if (!installedExtensions.has(name)) return undefined;
	}
	for (const selector of tools) {
		if (!selector.startsWith("ext:")) continue;
		const provider = selector.slice("ext:".length).split("/")[0];
		if (provider !== "" && !installedExtensions.has(provider)) return undefined;
	}
	return { extensions, tools };
}

/** Split a comma-separated scalar into trimmed, non-empty items. */
function csvItems(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

/** Trim additions the same way existing items are parsed. */
function trimmedAdditions(additions: readonly string[]): string[] {
	return additions.map((item) => item.trim()).filter((item) => item !== "");
}

/** Boolean/null-like scalars — merging into them would silently flip semantics. */
function isSentinelScalar(value: string): boolean {
	const lowered = value.toLowerCase();
	return lowered === "true" || lowered === "false" || lowered === "none";
}

/** Deduplicate preserving first-occurrence order. */
function dedupePreservingOrder(items: readonly string[]): string[] {
	return [...new Set(items)];
}

/**
 * Merge `additions` into an existing CSV scalar (the `tools:` form).
 * Parses the existing value as a comma-separated list (a bare scalar is a
 * one-item list), dedupes preserving first-occurrence order, appends absent
 * additions in given order, and joins with `", "`. An `undefined` existing
 * value yields the additions alone. Boolean-ish sentinels (`true`/`false`/
 * `none`), empty scalars (a block-sequence head), and flow-sequence forms
 * return undefined — the caller skips the key (fail-soft, nothing emitted).
 */
export function mergeCsvAdditions(existing: string | undefined, additions: readonly string[]): string | undefined {
	if (existing === undefined) {
		const adds = trimmedAdditions(additions);
		return adds.length > 0 ? adds.join(", ") : undefined;
	}
	const trimmed = existing.trim();
	if (trimmed === "" || isSentinelScalar(trimmed)) return undefined;
	if (trimmed.startsWith("[")) return undefined;
	const items = dedupePreservingOrder([...csvItems(trimmed), ...trimmedAdditions(additions)]);
	return items.length > 0 ? items.join(", ") : undefined;
}

/**
 * Merge `additions` into an existing YAML flow sequence (the `extensions:`
 * form). Accepts `[a, b]` or a bare scalar as the base, dedupes preserving
 * first-occurrence order, appends absent additions, and renders `[a, b]`.
 * An `undefined` existing value yields the additions alone. Sentinels,
 * empty scalars, CSV forms, and unclosed brackets return undefined — the
 * caller skips the key.
 */
export function mergeFlowSeqAdditions(existing: string | undefined, additions: readonly string[]): string | undefined {
	if (existing === undefined) {
		const adds = trimmedAdditions(additions);
		return adds.length > 0 ? `[${adds.join(", ")}]` : undefined;
	}
	const trimmed = existing.trim();
	if (trimmed === "" || isSentinelScalar(trimmed)) return undefined;
	let inner: string;
	if (trimmed.startsWith("[")) {
		if (!trimmed.endsWith("]")) return undefined;
		inner = trimmed.slice(1, -1);
	} else {
		if (trimmed.includes(",")) return undefined;
		inner = trimmed;
	}
	const items = dedupePreservingOrder([...csvItems(inner), ...trimmedAdditions(additions)]);
	return items.length > 0 ? `[${items.join(", ")}]` : undefined;
}

/**
 * Derive installed extension names from package spec strings:
 * `npm:@juicesharp/rpiv-warp` → `rpiv-warp` — the last path segment after
 * any protocol prefix, lowercased (the directory ↔ npm ↔ extension-name
 * family convention). Non-string entries are the caller's to filter.
 */
export function installedExtensionNames(pkgs: readonly string[]): ReadonlySet<string> {
	const names = new Set<string>();
	for (const entry of pkgs) {
		const noProto = entry.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:/, "");
		const base = noProto.split("/").filter(Boolean).pop();
		if (base !== undefined) names.add(base.toLowerCase());
	}
	return names;
}
