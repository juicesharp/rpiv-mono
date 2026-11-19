/**
 * inventory — stable active-tool-name Message for advisor prompt-cache parity.
 *
 * globalThis-keyed (Symbol.for("rpiv-advisor")) so the cache survives module
 * re-import on /new, /fork, /resume (mirrors rpiv-btw/btw.ts). Single-slot — the
 * active tool set is process-scoped, so per-session keying would be redundant;
 * the cache invalidates only when the rendered prefix actually changes. Names
 * only: schemas and descriptions are deliberately omitted, so the block stays
 * small, and an inactive tool — including a deferred tool that was not activated — never reads as active.
 */

import type { Message } from "@earendil-works/pi-ai";
import { ADVISOR_TOOL_NAME } from "./messages.ts";

const ADVISOR_STATE_KEY = Symbol.for("rpiv-advisor");

// Upper bound on the rendered name list. The fixed header and the omission
// marker sit outside it, so the message stays close to this budget even when
// the executor has hundreds of long tool names.
export const MAX_INVENTORY_CHARS = 12_000;

const INVENTORY_HEADER = `## Active Executor Tools

The executor's active tool names (Pi's active set; names only, no schemas) are listed below. This is not the executor's complete reachable capability set, and not an exact list of what the provider request declares: inactive tools (including deferred tools not yet activated) are not listed, while some active names may be hidden from the provider request, and indirect capabilities may still be reachable through codemode scripts or tool search. If you need evidence that a tool exists or how to call it, ask the executor to check its own tool list instead of assuming.
`;

interface AdvisorState {
	inventorySignature?: string;
	inventoryMessage?: Message;
}

function getAdvisorRuntimeState(): AdvisorState {
	const g = globalThis as unknown as { [k: symbol]: AdvisorState | undefined };
	let state = g[ADVISOR_STATE_KEY];
	if (!state) {
		state = {};
		g[ADVISOR_STATE_KEY] = state;
	}
	return state;
}

// Adds whole names in sorted order, skipping a name that would cross the
// character budget rather than cutting it — a truncated tool name would be
// worse than no name. Omitted names are counted for the explicit marker.
function buildInventoryBlock(names: readonly string[]): { block: string; omitted: number } {
	const lines: string[] = [];
	let used = 0;
	for (const name of names) {
		const line = `- ${name}`;
		const cost = line.length + 1; // + the newline joining it to the next line
		if (used + cost > MAX_INVENTORY_CHARS) continue;
		lines.push(line);
		used += cost;
	}
	return { block: lines.join("\n"), omitted: names.length - lines.length };
}

// Returns `undefined` when no tool is active (or only the advisor itself) so
// callers can skip prepending an empty block that would still cost a cache unit.
export function getInventoryMessage(activeToolNames: readonly string[]): Message | undefined {
	const sorted = [...new Set(activeToolNames)].filter((name) => name !== ADVISOR_TOOL_NAME).sort();
	if (sorted.length === 0) return undefined;
	const { block, omitted } = buildInventoryBlock(sorted);
	const marker = omitted > 0 ? `\n\n(+${omitted} more active tool names omitted)` : "";
	const text = `${INVENTORY_HEADER}\n${block}${marker}`;
	const state = getAdvisorRuntimeState();
	// Cache on the rendered text, not the full active-name list: a change confined
	// to names the budget already omitted cannot alter the sent prefix.
	if (state.inventorySignature === text && state.inventoryMessage) {
		return state.inventoryMessage;
	}
	const message: Message = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	state.inventorySignature = text;
	state.inventoryMessage = message;
	return message;
}
