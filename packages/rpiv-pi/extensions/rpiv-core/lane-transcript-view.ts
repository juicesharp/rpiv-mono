/**
 * lane-transcript-view — the read-only transcript BODY for one lane unit, extracted
 * so the unified console (lane-console.ts) can render it in both its read-only and
 * question modes from one source. Owns the source resolution
 * (live getBranch → unit.finalBranch snapshot → on-disk jsonl → placeholder), the
 * appended live streaming partial, the per-unit disk-fallback cache, and the
 * registry/session subscriptions. Strictly read-only and fail-soft — never throws
 * into its host overlay. It yields BODY lines only; the host frames them.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	dimLine,
	type RenderSource,
	renderBranch,
	renderStreamingMessage,
	type StreamingHandle,
	type ToolDefArg,
	type ViewerEntry,
	type ViewerMessage,
} from "./lane-transcript.js";
import { type DiskBranch, loadBranchFromDisk } from "./lane-transcript-disk.js";
import { getLane, getUnit, type LaneSession, subscribeLanes, type UnitLane } from "./run-lane-registry.js";

export class LaneTranscriptView {
	private currentSession: LaneSession | undefined;
	private sessionUnsub: (() => void) | undefined;
	/** The live child's in-flight partial, rendered as its own persistent component after
	 *  the committed body. Reset on a session identity change; cleared automatically the
	 *  tick getStreamingMessage() returns undefined (turn committed). */
	private streamingComponent: StreamingHandle | undefined;
	private readonly registryUnsub: () => void;
	/** Disk-jsonl fallback parsed ONCE and cached by file key — renderBody runs every
	 *  streaming tick, so the disk read must not repeat per frame. */
	private diskCache: { key: string; value: DiskBranch | undefined } | undefined;

	constructor(
		private readonly runId: string,
		private readonly unitIndex: number,
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {
		this.currentSession = getUnit(runId, unitIndex)?.currentSession;
		this.sessionUnsub = this.currentSession?.subscribe(() => this.tui.requestRender());
		// Follow the unit across stage transitions + detect eviction.
		this.registryUnsub = subscribeLanes(() => this.syncSession());
	}

	/** Re-point to THIS unit's current child if it changed; always re-render. */
	private syncSession(): void {
		const next = getUnit(this.runId, this.unitIndex)?.currentSession;
		if (next !== this.currentSession) {
			this.sessionUnsub?.();
			this.currentSession = next;
			this.streamingComponent = undefined; // drop any in-flight partial from the old child
			this.sessionUnsub = next?.subscribe(() => this.tui.requestRender());
		}
		this.tui.requestRender();
	}

	/** Disk-jsonl fallback memoized by `runId::unitIndex::lastSessionFile`. */
	private loadDiskBranch(unit: UnitLane | undefined): DiskBranch | undefined {
		const key = `${this.runId}::${this.unitIndex}::${unit?.lastSessionFile ?? ""}`;
		if (this.diskCache?.key !== key) {
			this.diskCache = { key, value: loadBranchFromDisk(this.runId, unit?.lastSessionFile) };
		}
		return this.diskCache.value;
	}

	/** The transcript BODY (no header/footer): a fail-soft string[] the host windows.
	 *  Placeholders (dismissed / starting / none / unavailable) come back as one dim line. */
	renderBody(width: number, toolsExpanded: boolean): string[] {
		const lane = getLane(this.runId);
		if (!lane) return dimLine("(run dismissed — esc to return)", this.theme).render(width);
		const unit = getUnit(this.runId, this.unitIndex);
		const session = this.currentSession;
		let entries: ViewerEntry[];
		let source: RenderSource;
		try {
			if (session) {
				entries = (session.sessionManager.getBranch() as ViewerEntry[] | undefined) ?? [];
				source = {
					cwd: session.sessionManager.getCwd(),
					toolDef: (name) => session.getToolDefinition(name) as ToolDefArg,
				};
			} else if (unit?.finalBranch !== undefined) {
				entries = (unit.finalBranch as ViewerEntry[]) ?? [];
				const defs = unit.finalToolDefs;
				source = { cwd: unit.finalCwd ?? "", toolDef: (name) => defs?.get(name) as ToolDefArg };
			} else {
				const disk = this.loadDiskBranch(unit);
				if (disk) {
					entries = disk.entries;
					source = disk.source;
				} else if (lane.status === "running") {
					return dimLine("(stage starting…)", this.theme).render(width); // between stages
				} else {
					return dimLine("(no transcript — esc to return)", this.theme).render(width);
				}
			}
		} catch {
			// disposed mid-render / unexpected shape — fail soft (never throw inside the host)
			return dimLine("(transcript unavailable)", this.theme).render(width);
		}
		const body = renderBranch(entries, width, source, this.tui, this.theme, toolsExpanded);
		if (session) {
			// Live source only: append the in-flight partial after the committed body.
			const { component, lines } = renderStreamingMessage(
				this.streamingComponent,
				this.readStreaming(session),
				width,
			);
			this.streamingComponent = component;
			body.push(...lines);
		}
		return body;
	}

	/** Read the live session's in-flight partial. Fail-soft: a throwing accessor yields undefined. */
	private readStreaming(session: LaneSession): ViewerMessage | undefined {
		try {
			return session.getStreamingMessage() as ViewerMessage | undefined;
		} catch {
			return undefined;
		}
	}

	/** True when a live child session backs the body — the host may show a "live" header. */
	hasLiveSession(): boolean {
		return this.currentSession !== undefined;
	}

	dispose(): void {
		this.sessionUnsub?.();
		this.registryUnsub();
	}
}
