/**
 * rpiv-warp — Tab-title activity spinner.
 *
 * Warp's per-tab "moving dots" animation is NOT part of the OSC 777
 * cli-agent protocol (research: agent: "claude" payloads with the full
 * OSC 777 lifecycle still produce no animation). It's a side effect of
 * the foreground process continuously rewriting its terminal title via
 * OSC 0 (`\x1b]0;<title>\x07`). Claude Code drives this by ticking
 * braille glyphs through the title every ~80ms while a request is in
 * flight (anthropics/claude-code#17887). Same mechanism animates
 * activity indicators in iTerm2, Ghostty, tmux, Windows Terminal —
 * terminal-side, not Warp-specific. Both reference plugins
 * (warpdotdev/claude-code-warp, warpdotdev/opencode-warp) emit ONLY OSC 777
 * — no spinner — confirming the dots originate in the agent process.
 *
 * Title-preservation strategy: the original Warp tab title (e.g.
 * `π - rpiv-mono`, set by Pi at startup) MUST survive the animation
 * round trip — and during the animation, only the FIRST character (the
 * Pi mascot) is swapped for the rotating glyph; the suffix (` - <repo>`)
 * stays put.
 *
 *   on agent_start(suffix)      → CSI 22;0t       (push current title)
 *   while running, every ~80ms  → OSC 0           (write `<glyph><suffix>`)
 *   on agent_end                → CSI 23;0t       (pop — original restored)
 *
 * The suffix is supplied by callers in `index.ts` from `ctx.cwd`
 * (` - ${basename(cwd)}`); on a stop, push/pop restores whatever the
 * terminal had before — typically Pi's `π${suffix}`. Push/pop is
 * supported by Warp, iTerm2, Ghostty, tmux, Linux console; terminals
 * that don't implement it ignore the CSI silently.
 *
 * Module state: a single in-flight ticker. `startSpinner`/`stopSpinner`
 * are idempotent — overlapping calls within one agent loop are safe.
 * Timer is `unref()`d so a stray interval cannot block process exit.
 * `__resetState` is the test-cleanup contract (timer-only; no I/O so
 * the per-test fs mock isn't polluted with a stray pop sequence);
 * `test/setup.ts` invokes it in `beforeEach`.
 */

import { popTitleStack, pushTitleStack, writeOSC0 } from "./warp-notify.js";

// ---------------------------------------------------------------------------
// Constants — tunable at one site
// ---------------------------------------------------------------------------

/**
 * 2×2-dot rotation, inverted: three of four dots in the cell's middle
 * sub-grid (dots 2,5,3,6) stay lit, one rotates as a moving "gap"
 * clockwise from top-left → top-right → bottom-right → bottom-left.
 *
 *   ⠴   ⠦   ⠖   ⠲      (gap at TL, TR, BR, BL)
 *
 * Reads as a 3-dot cluster with a hole spinning around it. All four
 * frames share the same monospace width, so the title suffix doesn't
 * shimmer (vs Claude Code's variable-width `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`,
 * anthropics/claude-code#17887).
 *
 * At FRAME_INTERVAL_MS = 160, the 4-frame cycle completes every ~640ms
 * (~1.5 Hz) — relaxed pulse, deliberately slower than typical CLI
 * spinners (80–100ms) so the tab indicator reads as ambient activity
 * rather than urgency.
 */
export const SPINNER_FRAMES: readonly string[] = ["⠴", "⠦", "⠖", "⠲"];

/** Tick rate — slower than typical CLI spinners (~80ms); reads as ambient. */
export const FRAME_INTERVAL_MS = 160;

// ---------------------------------------------------------------------------
// Pure formatter — no I/O
// ---------------------------------------------------------------------------

export function activeTitle(frameIndex: number, suffix: string = ""): string {
	return `${SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]}${suffix}`;
}

// ---------------------------------------------------------------------------
// Module state — one ticker at a time; idempotent start/stop
// ---------------------------------------------------------------------------

interface Ticker {
	timer: ReturnType<typeof setInterval>;
	frame: number;
	suffix: string;
}

let active: Ticker | undefined;

function tick(): void {
	if (!active) return;
	writeOSC0(activeTitle(active.frame, active.suffix));
	active.frame = (active.frame + 1) % SPINNER_FRAMES.length;
}

// ---------------------------------------------------------------------------
// Public API — wired from index.ts agent-loop boundaries
// ---------------------------------------------------------------------------

export function startSpinner(suffix: string = ""): void {
	if (active) return;
	pushTitleStack();
	const timer = setInterval(tick, FRAME_INTERVAL_MS);
	if (typeof timer.unref === "function") timer.unref();
	active = { timer, frame: 0, suffix };
}

export function stopSpinner(): void {
	if (!active) return;
	clearInterval(active.timer);
	active = undefined;
	popTitleStack();
}

export function __resetState(): void {
	if (active) clearInterval(active.timer);
	active = undefined;
}
