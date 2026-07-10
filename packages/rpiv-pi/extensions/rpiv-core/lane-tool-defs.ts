/**
 * lane-tool-defs — process-wide cache of tool definitions harvested from live
 * child sessions, consumed by the disk-jsonl transcript fallback
 * (lane-transcript-disk.ts).
 *
 * The disk fallback replays a persisted branch after (or between) live
 * sessions, so it has no `getToolDefinition` of its own. Without a definition
 * the SDK's ToolExecutionComponent degrades EXTENSION tools (todo,
 * ask_user_question, …) to its generic `name + JSON args + raw text` block —
 * built-ins self-heal via `createAllToolDefinitions`, which is why only
 * extension tools looked broken on the disk path. But the launcher process has
 * the exact same extensions loaded as every child: the host harvests each
 * spawned child's full definition registry here (renderers included), and the
 * disk fallback resolves per-tool renderers from this cache.
 *
 * Module-level state mirrors session-capture; __resetLaneToolDefs is wired
 * into test/setup.ts beforeEach. Empty cache (fresh launcher, no child spawned
 * yet) degrades exactly as before — the component's built-in fallback.
 */

/** The minimal session surface the harvest reads — structural, so this module
 *  stays free of an AgentSession value/type import (mirrors LaneSession). */
export interface ToolDefHarvestSource {
	/** The SDK's `AgentSession.getAllTools()` — name metadata for every
	 *  configured tool. Optional so a stub/older session degrades to a no-op. */
	getAllTools?(): unknown;
	/** Full per-tool definition (renderers included) — `AgentSession.getToolDefinition`. */
	getToolDefinition(name: string): unknown;
}

/** Deliberately a plain module-level Map, NOT a `Symbol.for` global slot like
 *  question-lifecycle/warp-bridge: the producer (sdk-workflow-host's harvest) and
 *  the consumer (lane-transcript-disk's read) both run in the launcher's module
 *  instance, so a child re-load can never split them — and a split copy would
 *  only degrade to the component's built-in fallback anyway. */
const cachedDefs = new Map<string, unknown>();

/**
 * Harvest every tool definition a live session can resolve into the shared
 * cache (last writer wins, so a `/reload`ed extension refreshes on the next
 * child spawn). Fail-soft end to end: a stub session without `getAllTools`,
 * a throwing accessor, or a malformed tool list is a no-op — harvesting must
 * never break a child spawn.
 */
export function harvestToolDefs(session: ToolDefHarvestSource): void {
	try {
		const tools = session.getAllTools?.();
		if (!Array.isArray(tools)) return;
		for (const tool of tools) {
			const name = (tool as { name?: unknown } | undefined)?.name;
			if (typeof name !== "string") continue;
			try {
				const def = session.getToolDefinition(name);
				if (def !== undefined) cachedDefs.set(name, def);
			} catch {
				// tool unregistered mid-read — skip; the viewer falls back for this one
			}
		}
	} catch {
		// fail-soft — a harvest failure must never break the spawn path
	}
}

/** Per-tool lookup for the disk-fallback RenderSource. Undefined when the tool
 *  was never harvested (fresh launcher) — the component's built-in fallback. */
export function getCachedToolDef(name: string): unknown {
	return cachedDefs.get(name);
}

/** Test reset — wired into test/setup.ts beforeEach. */
export function __resetLaneToolDefs(): void {
	cachedDefs.clear();
}
