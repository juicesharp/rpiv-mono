/**
 * Quiet renderCall + renderResult overrides for the nicobailon subagent tool.
 *
 * Motivation: pi-coding-agent re-invokes `tool.renderResult` on every
 * `tool_execution_update` while a subagent is streaming. Nicobailon's
 * default renderer produces a multi-line Container that re-flows the
 * inline tool-call card on every frame → visible flicker and row
 * stacking. Our `aboveEditor` overlay (widget.ts) is the authoritative
 * live view; the inline card should be layout-stable while running,
 * then unfold to full result at completion.
 *
 * Layout-stability contract (see issue doc in CHANGELOG 0.12.3):
 *   - `renderCall` always appends a 1-line `◐ pending` / `◐ running`
 *     trailer below pi-subagents' own call header. So the card is 2
 *     lines from the very first paint — no more 1↔2-line oscillation.
 *   - `renderResult` emits a zero-height stub while non-terminal (the
 *     status line is owned by renderCall), then delegates to
 *     `renderSubagentResult` once the last SingleResult carries a
 *     terminal exitCode/stopReason. A shared `ctx.state.subagentTerminal`
 *     flag tells renderCall to stop emitting its trailer so we don't
 *     duplicate status text next to the full result block.
 *
 * Mechanism: wrap the ExtensionAPI handed to nicobailon's default
 * export in a Proxy that intercepts `registerTool` for the "subagent"
 * tool and swaps both `renderCall` and `renderResult`.
 *
 * Deployment: settings.json must not list `"npm:pi-subagents"` — only
 * this wrapper loads nicobailon (via `registerSubagentExtension(pi)`)
 * so every handler/bridge/tracker is registered exactly once. The
 * claimer helper (rpiv-core/claim-pi-subagents.ts) strips that entry
 * idempotently from `~/.pi/agent/settings.json`.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Text } from "@mariozechner/pi-tui";
import registerSubagentExtension from "pi-subagents";
import { renderSubagentResult } from "pi-subagents/render";

const SUBAGENT_TOOL = "subagent";

interface ProgressLike {
	status?: string;
}
interface ResultLike {
	agent?: string;
	progress?: ProgressLike;
	exitCode?: number;
	stopReason?: string;
}
interface DetailsLike {
	results?: ResultLike[];
}

// Terminal = last SingleResult carries a definite exitCode or stopReason AND
// progress.status is not explicitly running/pending. Anything else counts as
// non-terminal, including "no progress yet" (pre-progress partial updates).
function isTerminal(r: ResultLike | undefined): boolean {
	if (!r) return false;
	const status = r.progress?.status;
	if (status === "pending" || status === "running") return false;
	return r.exitCode != null || r.stopReason != null;
}

// Shared per-component state written by renderResult (terminal frame) and
// read by renderCall (to suppress the status trailer once the full block renders).
interface SharedState {
	subagentTerminal?: boolean;
}

// Render context shape used by Pi's ToolExecutionComponent
// (see @mariozechner/pi-coding-agent/dist/modes/interactive/components/tool-execution.js:85).
// We only read the fields we need — the rest of the context is opaque.
interface RenderCallCtx {
	executionStarted?: boolean;
	state?: SharedState;
}

interface RenderResultCtx {
	state?: SharedState;
}

function buildStatusTrailer(theme: Theme, ctx: RenderCallCtx): Text {
	// `executionStarted` flips true once Pi fires markExecutionStarted(), i.e.
	// the tool is actually running (not just queued with complete args).
	const running = ctx.executionStarted === true;
	const glyph = running ? theme.fg("warning", "◐") : theme.fg("dim", "○");
	const label = running ? "running" : "pending";
	return new Text(`${glyph} ${theme.fg("muted", label)}`, 0, 0);
}

// Type for pi-subagents' original renderCall; we pass through to it for the
// call header and append our status trailer below in a Container.
type OriginalRenderCall = (args: unknown, theme: Theme, ctx: unknown) => Component | undefined;

export function buildQuietRenderCall(originalRenderCall: OriginalRenderCall | undefined): OriginalRenderCall {
	return (args, theme, ctx) => {
		const callCtx = (ctx ?? {}) as RenderCallCtx;
		const original = originalRenderCall ? originalRenderCall(args, theme, ctx) : undefined;
		// Terminal frame: renderResult owns the full display below the call header;
		// no trailer here, otherwise we'd duplicate status.
		if (callCtx.state?.subagentTerminal === true) {
			return original ?? new Text("", 0, 0);
		}
		const trailer = buildStatusTrailer(theme, callCtx);
		if (!original) return trailer;
		const container = new Container();
		container.addChild(original);
		container.addChild(trailer);
		return container;
	};
}

export function buildQuietRenderResult(): (
	result: { details?: DetailsLike; content?: Array<{ type: string; text?: string }> },
	options: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
	ctx?: unknown,
) => unknown {
	return (result, options, theme, ctx) => {
		const r = result.details?.results?.[0];
		const resultCtx = (ctx ?? {}) as RenderResultCtx;
		if (isTerminal(r) && options.isPartial !== true) {
			// Mark state so the NEXT renderCall invocation suppresses its trailer —
			// prevents "◐ running" appearing above the final result block.
			if (resultCtx.state) resultCtx.state.subagentTerminal = true;
			return renderSubagentResult(result, options, theme);
		}
		// Non-terminal: status line is owned by renderCall. Return a zero-height
		// stub so the card's total height = exactly (call header + 1 trailer).
		return new Text("", 0, 0);
	};
}

/**
 * Invoke nicobailon's registerSubagentExtension with a proxied pi that
 * overrides the "subagent" tool's renderCall + renderResult on the way
 * into the extension runtime. Idempotent iff called once per session.
 */
export async function registerSubagentsWithQuietRenderer(pi: ExtensionAPI): Promise<void> {
	const quietRenderResult = buildQuietRenderResult();
	const wrappedPi = new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
			return (tool: { name: string; renderCall?: unknown; renderResult?: unknown }) => {
				if (tool.name === SUBAGENT_TOOL) {
					return (target.registerTool as unknown as (t: unknown) => void)({
						...tool,
						renderCall: buildQuietRenderCall(tool.renderCall as OriginalRenderCall | undefined),
						renderResult: quietRenderResult,
					});
				}
				return (target.registerTool as unknown as (t: unknown) => void)(tool);
			};
		},
	});
	await registerSubagentExtension(wrappedPi);
}
