import * as fs from "node:fs";
import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeUserMessage,
} from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		openSync: vi.fn(),
		writeSync: vi.fn(),
		closeSync: vi.fn(),
	};
});

import register from "./index.js";

const WARP_ENV_VARS = ["TERM_PROGRAM", "WARP_CLI_AGENT_PROTOCOL_VERSION", "WARP_CLIENT_VERSION"] as const;

function setWorkingWarpEnv(): void {
	process.env.TERM_PROGRAM = "WarpTerminal";
	process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
	process.env.WARP_CLIENT_VERSION = "v0.2026.05.01.00.00.stable_01";
}

function setBrokenWarpEnv(): void {
	process.env.TERM_PROGRAM = "WarpTerminal";
	process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
	process.env.WARP_CLIENT_VERSION = "v0.2026.01.01.00.00.stable_01";
}

function primeFs(): { open: Mock; write: Mock; close: Mock } {
	(fs.openSync as unknown as Mock).mockReturnValue(42);
	(fs.writeSync as unknown as Mock).mockReturnValue(0);
	(fs.closeSync as unknown as Mock).mockReturnValue(undefined);
	return {
		open: fs.openSync as unknown as Mock,
		write: fs.writeSync as unknown as Mock,
		close: fs.closeSync as unknown as Mock,
	};
}

beforeEach(() => {
	for (const k of WARP_ENV_VARS) delete process.env[k];
	(fs.openSync as unknown as Mock).mockReset();
	(fs.writeSync as unknown as Mock).mockReset();
	(fs.closeSync as unknown as Mock).mockReset();
});

describe("registration", () => {
	it("registers ZERO handlers when not in Warp", () => {
		const { pi, captured } = createMockPi();
		register(pi);
		expect(captured.events.size).toBe(0);
	});
	it("registers ZERO handlers on a known-broken Warp build", () => {
		setBrokenWarpEnv();
		const { pi, captured } = createMockPi();
		register(pi);
		expect(captured.events.size).toBe(0);
	});
	it("registers all five event handlers in working Warp", () => {
		setWorkingWarpEnv();
		const { pi, captured } = createMockPi();
		register(pi);
		for (const ev of ["session_start", "agent_start", "agent_end", "tool_call", "turn_end"]) {
			expect(captured.events.has(ev)).toBe(true);
		}
	});
});

describe("session_start handler", () => {
	it("emits an OSC 777 sequence on reason=startup", async () => {
		setWorkingWarpEnv();
		const { open, write, close } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("session_start")?.[0];
		await handler?.({ reason: "startup" } as never, createMockCtx() as never);
		expect(open).toHaveBeenCalledWith("/dev/tty", "w");
		expect(write).toHaveBeenCalledOnce();
		expect(String(write.mock.calls[0][1])).toMatch(/^\x1b\]777;notify;warp:\/\/cli-agent;.*\x07$/);
		expect(close).toHaveBeenCalledWith(42);
	});
	for (const reason of ["reload", "new", "resume", "fork"] as const) {
		it(`does NOT emit on reason=${reason}`, async () => {
			setWorkingWarpEnv();
			const { open } = primeFs();
			const { pi, captured } = createMockPi();
			register(pi);
			const handler = captured.events.get("session_start")?.[0];
			await handler?.({ reason } as never, createMockCtx() as never);
			expect(open).not.toHaveBeenCalled();
		});
	}
});

describe("agent_start handler", () => {
	it("emits a 'prompt_submit' payload on every turn", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("agent_start")?.[0];
		await handler?.({} as never, createMockCtx() as never);
		expect(write).toHaveBeenCalledOnce();
		const json = String(write.mock.calls[0][1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		expect(JSON.parse(json).event).toBe("prompt_submit");
	});
});

describe("agent_end handler", () => {
	it("emits a 'stop' payload with query + response from branch", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const branch = buildSessionEntries([
			makeUserMessage("how do I deploy?"),
			makeAssistantMessage({ text: "run npm publish" }),
		]);
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("agent_end")?.[0];
		await handler?.({ messages: [] } as never, createMockCtx({ branch }) as never);
		expect(write).toHaveBeenCalledOnce();
		const bytes = String(write.mock.calls[0][1]);
		const json = bytes.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "").replace(/\x07$/, "");
		const payload = JSON.parse(json);
		expect(payload.event).toBe("stop");
		expect(payload.query).toBe("how do I deploy?");
		expect(payload.response).toBe("run npm publish");
	});
});

describe("tool_call handler", () => {
	it("emits 'idle_prompt' for ask_user_question", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("tool_call")?.[0];
		await handler?.({ toolName: "ask_user_question", input: {} } as never, createMockCtx() as never);
		expect(write).toHaveBeenCalledOnce();
		const json = String(write.mock.calls[0][1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		expect(JSON.parse(json).event).toBe("idle_prompt");
	});
	it("does NOT emit for other tool names", async () => {
		setWorkingWarpEnv();
		const { open } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("tool_call")?.[0];
		await handler?.({ toolName: "bash", input: { command: "ls" } } as never, createMockCtx() as never);
		expect(open).not.toHaveBeenCalled();
	});
});

describe("turn_end handler", () => {
	it("emits 'tool_complete' with last toolResults entry's name", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("turn_end")?.[0];
		await handler?.(
			{ turnIndex: 0, message: {}, toolResults: [{ toolName: "read" }, { toolName: "edit" }] } as never,
			createMockCtx() as never,
		);
		const json = String(write.mock.calls[0][1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		const payload = JSON.parse(json);
		expect(payload.event).toBe("tool_complete");
		expect(payload.tool_name).toBe("edit");
	});
	it("emits 'tool_complete' with empty tool_name when no tool ran", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("turn_end")?.[0];
		await handler?.({ turnIndex: 0, message: {}, toolResults: [] } as never, createMockCtx() as never);
		const json = String(write.mock.calls[0][1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		expect(JSON.parse(json).tool_name).toBe("");
	});
});

describe("/dev/tty unreachable", () => {
	it("silently skips when openSync throws (e.g. ENXIO)", async () => {
		setWorkingWarpEnv();
		const open = (fs.openSync as unknown as Mock).mockImplementation(() => {
			throw Object.assign(new Error("ENXIO"), { code: "ENXIO" });
		});
		const write = fs.writeSync as unknown as Mock;
		const close = fs.closeSync as unknown as Mock;
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("session_start")?.[0];
		await expect(handler?.({ reason: "startup" } as never, createMockCtx() as never)).resolves.not.toThrow();
		expect(open).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});
});
