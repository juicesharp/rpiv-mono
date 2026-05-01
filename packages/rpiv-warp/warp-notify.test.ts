import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		openSync: vi.fn(),
		writeSync: vi.fn(),
		closeSync: vi.fn(),
	};
});

import {
	formatOSC0,
	formatOSC777,
	formatPopTitleStack,
	formatPushTitleStack,
	popTitleStack,
	pushTitleStack,
	writeOSC0,
	writeOSC777,
} from "./warp-notify.js";

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function primeFs(): { open: Mock; write: Mock; close: Mock } {
	(fs.openSync as unknown as Mock).mockReturnValue(7);
	(fs.writeSync as unknown as Mock).mockReturnValue(0);
	(fs.closeSync as unknown as Mock).mockReturnValue(undefined);
	return {
		open: fs.openSync as unknown as Mock,
		write: fs.writeSync as unknown as Mock,
		close: fs.closeSync as unknown as Mock,
	};
}

beforeEach(() => {
	(fs.openSync as unknown as Mock).mockReset();
	(fs.writeSync as unknown as Mock).mockReset();
	(fs.closeSync as unknown as Mock).mockReset();
});

afterEach(() => {
	setPlatform(ORIGINAL_PLATFORM);
});

describe("formatOSC777", () => {
	it("wraps title + body in the OSC 777 envelope", () => {
		expect(formatOSC777("warp://cli-agent", '{"event":"stop"}')).toBe(
			'\x1b]777;notify;warp://cli-agent;{"event":"stop"}\x07',
		);
	});
});

describe("formatOSC0", () => {
	it("wraps title in the OSC 0 envelope (terminal title set)", () => {
		expect(formatOSC0("⣾ Pi")).toBe("\x1b]0;⣾ Pi\x07");
	});
});

describe("formatPushTitleStack / formatPopTitleStack", () => {
	it("emits the xterm CSI 22;0t push sequence", () => {
		expect(formatPushTitleStack()).toBe("\x1b[22;0t");
	});
	it("emits the xterm CSI 23;0t pop sequence", () => {
		expect(formatPopTitleStack()).toBe("\x1b[23;0t");
	});
});

describe("writeOSC777 (Unix)", () => {
	it("opens /dev/tty and writes the formatted sequence", () => {
		setPlatform("darwin");
		const { open, write, close } = primeFs();
		writeOSC777("warp://cli-agent", "body");
		expect(open).toHaveBeenCalledWith("/dev/tty", "w");
		expect(write).toHaveBeenCalledWith(7, "\x1b]777;notify;warp://cli-agent;body\x07");
		expect(close).toHaveBeenCalledWith(7);
	});

	it("writeOSC0 shares the same transport (open /dev/tty, write, close)", () => {
		setPlatform("darwin");
		const { open, write, close } = primeFs();
		writeOSC0("⣾ Pi");
		expect(open).toHaveBeenCalledWith("/dev/tty", "w");
		expect(write).toHaveBeenCalledWith(7, "\x1b]0;⣾ Pi\x07");
		expect(close).toHaveBeenCalledWith(7);
	});

	it("pushTitleStack writes CSI 22;0t through the same transport", () => {
		setPlatform("darwin");
		const { open, write, close } = primeFs();
		pushTitleStack();
		expect(open).toHaveBeenCalledWith("/dev/tty", "w");
		expect(write).toHaveBeenCalledWith(7, "\x1b[22;0t");
		expect(close).toHaveBeenCalledWith(7);
	});

	it("popTitleStack writes CSI 23;0t through the same transport", () => {
		setPlatform("darwin");
		const { open, write, close } = primeFs();
		popTitleStack();
		expect(open).toHaveBeenCalledWith("/dev/tty", "w");
		expect(write).toHaveBeenCalledWith(7, "\x1b[23;0t");
		expect(close).toHaveBeenCalledWith(7);
	});

	it("silently skips and still closes when openSync throws (e.g. ENXIO)", () => {
		setPlatform("linux");
		const open = (fs.openSync as unknown as Mock).mockImplementation(() => {
			throw Object.assign(new Error("ENXIO"), { code: "ENXIO" });
		});
		const write = fs.writeSync as unknown as Mock;
		const close = fs.closeSync as unknown as Mock;
		expect(() => writeOSC777("t", "b")).not.toThrow();
		expect(open).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});
});

describe("writeOSC777 (Windows)", () => {
	it("writes the OSC sequence to process.stdout when stdout is a TTY", () => {
		setPlatform("win32");
		const { open } = primeFs();
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			writeOSC777("warp://cli-agent", "body");
			expect(stdoutWrite).toHaveBeenCalledWith("\x1b]777;notify;warp://cli-agent;body\x07");
			expect(open).not.toHaveBeenCalled();
		} finally {
			stdoutWrite.mockRestore();
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	});

	it("skips emission when stdout is NOT a TTY (piped output)", () => {
		setPlatform("win32");
		const { open } = primeFs();
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		try {
			writeOSC777("t", "b");
			expect(stdoutWrite).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		} finally {
			stdoutWrite.mockRestore();
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	});

	it("silently swallows stdout.write throws (best-effort transport)", () => {
		setPlatform("win32");
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			throw new Error("EPIPE");
		});
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			expect(() => writeOSC777("t", "b")).not.toThrow();
		} finally {
			stdoutWrite.mockRestore();
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	});
});

// Title-spinner emitters share writeOSC777's transport. The TTY-skip and
// EPIPE-swallow paths are already covered above; here we verify only that
// each emitter's bytes reach `process.stdout.write` on Windows so ConPTY
// can forward them to Warp.
describe("writeOSC0 / pushTitleStack / popTitleStack (Windows)", () => {
	function withTtyStdout(fn: (stdoutWrite: Mock) => void): void {
		setPlatform("win32");
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			fn(stdoutWrite as unknown as Mock);
		} finally {
			stdoutWrite.mockRestore();
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	}

	it("writeOSC0 forwards the title-set sequence through process.stdout", () => {
		const { open } = primeFs();
		withTtyStdout((stdoutWrite) => {
			writeOSC0("⠴ - rpiv-mono");
			expect(stdoutWrite).toHaveBeenCalledWith("\x1b]0;⠴ - rpiv-mono\x07");
			expect(open).not.toHaveBeenCalled();
		});
	});

	it("pushTitleStack forwards CSI 22;0t through process.stdout (ConPTY relays it to Warp)", () => {
		const { open } = primeFs();
		withTtyStdout((stdoutWrite) => {
			pushTitleStack();
			expect(stdoutWrite).toHaveBeenCalledWith("\x1b[22;0t");
			expect(open).not.toHaveBeenCalled();
		});
	});

	it("popTitleStack forwards CSI 23;0t through process.stdout (title restore depends on terminal support)", () => {
		const { open } = primeFs();
		withTtyStdout((stdoutWrite) => {
			popTitleStack();
			expect(stdoutWrite).toHaveBeenCalledWith("\x1b[23;0t");
			expect(open).not.toHaveBeenCalled();
		});
	});
});
