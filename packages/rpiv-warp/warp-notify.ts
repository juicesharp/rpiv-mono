/**
 * rpiv-warp — OSC transport.
 *
 * Writes Warp's OSC escape sequences to the controlling terminal. On Unix
 * this is `/dev/tty`; on Windows there is no `/dev/tty`, so we write the
 * same OSC bytes to `process.stdout` and rely on ConPTY to forward them
 * to Warp (per Warp's "Bringing Warp to Windows" eng blog: "ConPTY will
 * send even unrecognized OSCs to the shell").
 *
 * Two OSC sequences and two CSI sequences are emitted from this module:
 *   - OSC 777 — Warp's structured cli-agent notification (badge state +
 *     toast). Single emission per lifecycle event; see `index.ts`.
 *   - OSC 0  — terminal title set. Driven from `title-spinner.ts` every
 *     160ms to animate Warp's per-tab activity dots; same mechanism
 *     Claude Code uses (anthropics/claude-code#17887).
 *   - CSI 22;0t / CSI 23;0t — xterm window-title stack push/pop. Used
 *     by `title-spinner.ts` to snapshot Warp's existing tab title before
 *     the animation starts and restore it verbatim on stop, so the
 *     `π - <repo>` label Pi sets at startup survives the spinner round
 *     trip.
 *
 * Each call on Unix opens, writes, and closes the fd — no fd cache
 * (matches bash precedent: warp-notify.sh:21). Windows writes go straight
 * through `process.stdout.write` — best-effort, untested in the wild as
 * no Warp plugin currently ships a Windows transport.
 *
 * Tests intercept fs calls via `vi.mock("node:fs", ...)` — the same
 * pattern used in `packages/rpiv-pi/extensions/rpiv-core/pi-installer.test.ts:4`
 * for `node:child_process`. Production uses `import * as fs from "node:fs"`
 * for clarity (every fs call is namespace-prefixed).
 */

import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Escape-sequence constants — exported so tests assert against the same bytes
// ---------------------------------------------------------------------------

export const OSC_INTRODUCER = "\x1b]";
export const OSC_TERMINATOR = "\x07";
export const OSC_777_PREFIX = "777;notify";
export const OSC_0_PREFIX = "0";

export const CSI_INTRODUCER = "\x1b[";
/** Push window+icon titles onto xterm's title stack (Ps=0 → both). */
export const CSI_PUSH_TITLE = "22;0t";
/** Pop and restore window+icon titles from xterm's title stack (Ps=0 → both). */
export const CSI_POP_TITLE = "23;0t";

const TTY_PATH = "/dev/tty";

// ---------------------------------------------------------------------------
// Pure formatters — one per shape; no I/O
// ---------------------------------------------------------------------------

export function formatOSC777(title: string, body: string): string {
	return `${OSC_INTRODUCER}${OSC_777_PREFIX};${title};${body}${OSC_TERMINATOR}`;
}

export function formatOSC0(title: string): string {
	return `${OSC_INTRODUCER}${OSC_0_PREFIX};${title}${OSC_TERMINATOR}`;
}

export function formatPushTitleStack(): string {
	return `${CSI_INTRODUCER}${CSI_PUSH_TITLE}`;
}

export function formatPopTitleStack(): string {
	return `${CSI_INTRODUCER}${CSI_POP_TITLE}`;
}

// ---------------------------------------------------------------------------
// Platform / fs primitives — small wrappers so writeRaw reads as a sentence
// ---------------------------------------------------------------------------

function isWindows(): boolean {
	return process.platform === "win32";
}

function openTty(): number {
	return fs.openSync(TTY_PATH, "w");
}

function writeBytes(fd: number, bytes: string): void {
	fs.writeSync(fd, bytes);
}

function closeQuietly(fd: number): void {
	try {
		fs.closeSync(fd);
	} catch {
		/* fd already closed or invalid — ignore */
	}
}

// Windows transport — write OSC bytes to stdout so ConPTY forwards them to
// Warp. Skipped when stdout isn't a TTY (piped/redirected output would either
// pollute downstream consumers or never reach the terminal).
function writeStdout(bytes: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(bytes);
}

// ---------------------------------------------------------------------------
// Raw transport — single platform-fork; shape-agnostic, swallows errors
// ---------------------------------------------------------------------------

function writeRaw(bytes: string): void {
	if (isWindows()) {
		try {
			writeStdout(bytes);
		} catch {
			/* silent skip — best-effort on Windows */
		}
		return;
	}
	let fd: number | undefined;
	try {
		fd = openTty();
		writeBytes(fd, bytes);
	} catch {
		/* silent skip — matches bash `warp-notify.sh:21` */
	} finally {
		if (fd !== undefined) closeQuietly(fd);
	}
}

// ---------------------------------------------------------------------------
// Public emitters — one per shape; all silent-skip on any failure
// ---------------------------------------------------------------------------

export function writeOSC777(title: string, body: string): void {
	writeRaw(formatOSC777(title, body));
}

export function writeOSC0(title: string): void {
	writeRaw(formatOSC0(title));
}

export function pushTitleStack(): void {
	writeRaw(formatPushTitleStack());
}

export function popTitleStack(): void {
	writeRaw(formatPopTitleStack());
}
