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

import register, { __resetState, createWorkflowQuestionTransport } from "./index.js";
import { FRAME_INTERVAL_MS, __resetState as resetSpinner, SPINNER_FRAMES } from "./title-spinner.js";

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
	resetSpinner();
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
	it("registers all seven event handlers in working Warp", () => {
		setWorkingWarpEnv();
		const { pi, captured } = createMockPi();
		register(pi);
		for (const ev of [
			"session_start",
			"before_agent_start",
			"agent_start",
			"agent_end",
			"tool_call",
			"tool_execution_end",
			"session_shutdown",
		]) {
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
	it("emits session_start (defensive) then prompt_submit with query captured from before_agent_start", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);

		// Capture query via before_agent_start
		const beforeStart = captured.events.get("before_agent_start")?.[0];
		await beforeStart?.({ prompt: "how do I deploy?" } as never, createMockCtx() as never);

		const handler = captured.events.get("agent_start")?.[0];
		await handler?.({} as never, createMockCtx() as never);

		// Parse all OSC 777 writes from agent_start
		const osc777Writes = write.mock.calls
			.filter((c) => String(c[1]).startsWith("\x1b]777;notify;"))
			.map((c) => {
				const json = String(c[1])
					.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
					.replace(/\x07$/, "");
				return JSON.parse(json);
			});
		// First emit is session_start (defensive re-announce)
		expect(osc777Writes[0].event).toBe("session_start");
		// Second emit is prompt_submit with query
		expect(osc777Writes[1].event).toBe("prompt_submit");
		expect(osc777Writes[1].query).toBe("how do I deploy?");
	});

	it("defaults query to empty string when before_agent_start is not fired", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);

		const handler = captured.events.get("agent_start")?.[0];
		await handler?.({} as never, createMockCtx() as never);

		// Find the prompt_submit emit (second OSC 777; first is session_start)
		const osc777Writes = write.mock.calls
			.filter((c) => String(c[1]).startsWith("\x1b]777;notify;"))
			.map((c) => {
				const json = String(c[1])
					.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
					.replace(/\x07$/, "");
				return JSON.parse(json);
			});
		const promptSubmit = osc777Writes.find((p) => p.event === "prompt_submit");
		expect(promptSubmit).toBeDefined();
		expect(promptSubmit!.query).toBe("");
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
		const osc777Write = write.mock.calls.find((c) => String(c[1]).startsWith("\x1b]777;notify;"));
		expect(osc777Write).toBeDefined();
		const json = String(osc777Write?.[1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		const payload = JSON.parse(json);
		expect(payload.event).toBe("stop");
		expect(payload.query).toBe("how do I deploy?");
		expect(payload.response).toBe("run npm publish");
	});
});

describe("tool_call handler", () => {
	it("emits 'question_asked' for a configured blocking tool (default: ask_user_question)", async () => {
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
		expect(JSON.parse(json).event).toBe("question_asked");
	});
	it("does NOT emit for non-blocking tool names", async () => {
		setWorkingWarpEnv();
		const { open } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("tool_call")?.[0];
		await handler?.({ toolName: "bash", input: { command: "ls" } } as never, createMockCtx() as never);
		expect(open).not.toHaveBeenCalled();
	});
});

describe("tool_execution_end handler", () => {
	it("emits 'tool_complete' for a configured blocking tool (unblocks Warp's badge)", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("tool_execution_end")?.[0];
		await handler?.(
			{ toolCallId: "x", toolName: "ask_user_question", result: {}, isError: false } as never,
			createMockCtx() as never,
		);
		const osc777Write = write.mock.calls.find((c) => String(c[1]).startsWith("\x1b]777;notify;"));
		expect(osc777Write).toBeDefined();
		const json = String(osc777Write?.[1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		const payload = JSON.parse(json);
		expect(payload.event).toBe("tool_complete");
		expect(payload.tool_name).toBe("ask_user_question");
	});
	it("does NOT emit for non-blocking tool names", async () => {
		setWorkingWarpEnv();
		const { open } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);
		const handler = captured.events.get("tool_execution_end")?.[0];
		await handler?.(
			{ toolCallId: "x", toolName: "bash", result: {}, isError: false } as never,
			createMockCtx() as never,
		);
		expect(open).not.toHaveBeenCalled();
	});
});

describe("spinner lifecycle wiring", () => {
	const PUSH = "\x1b[22;0t";
	const POP = "\x1b[23;0t";
	// createMockCtx() defaults cwd to "/tmp/test-cwd"; index.ts derives the
	// title suffix as ` - ${basename(cwd)}` so the spinner writes preserve
	// the rest of the original `π - <repo>` tab title.
	const SUFFIX = " - test-cwd";

	function classify(write: Mock): { osc777: number; titleSets: string[]; pushes: number; pops: number } {
		let osc777 = 0;
		let pushes = 0;
		let pops = 0;
		const titleSets: string[] = [];
		for (const call of write.mock.calls) {
			const bytes = String(call[1]);
			if (bytes.startsWith("\x1b]777;notify;")) osc777++;
			else if (bytes.startsWith("\x1b]0;")) titleSets.push(bytes.replace(/^\x1b\]0;/, "").replace(/\x07$/, ""));
			else if (bytes === PUSH) pushes++;
			else if (bytes === POP) pops++;
		}
		return { osc777, titleSets, pushes, pops };
	}

	it("agent_start pushes the title stack; agent_end pops it (original restored)", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			const start = captured.events.get("agent_start")?.[0];
			await start?.({} as never, createMockCtx() as never);
			const opened = classify(write);
			expect(opened.osc777).toBe(2); // session_start (defensive) + prompt_submit
			expect(opened.pushes).toBe(1);
			expect(opened.pops).toBe(0);
			expect(opened.titleSets).toEqual([]);

			vi.advanceTimersByTime(FRAME_INTERVAL_MS * 3);
			const mid = classify(write);
			expect(mid.titleSets.length).toBe(3);
			expect(mid.titleSets[0]).toBe(`${SPINNER_FRAMES[0]}${SUFFIX}`);
			expect(mid.titleSets[1]).toBe(`${SPINNER_FRAMES[1]}${SUFFIX}`);
			expect(mid.titleSets[2]).toBe(`${SPINNER_FRAMES[2]}${SUFFIX}`);

			const end = captured.events.get("agent_end")?.[0];
			await end?.({ messages: [] } as never, createMockCtx() as never);
			const after = classify(write);
			expect(after.osc777).toBe(3); // + stop
			expect(after.pushes).toBe(1);
			expect(after.pops).toBe(1);

			vi.advanceTimersByTime(FRAME_INTERVAL_MS * 10);
			const settled = classify(write);
			expect(settled.titleSets.length).toBe(after.titleSets.length);
			expect(settled.pops).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("blocking tool_call pops; tool_execution_end pushes again to resume", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_start")?.[0]?.({} as never, createMockCtx() as never);
			vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2);
			const beforeBlock = classify(write).titleSets.length;
			expect(beforeBlock).toBe(2);

			await captured.events.get("tool_call")?.[0]?.(
				{ toolName: "ask_user_question", input: {} } as never,
				createMockCtx() as never,
			);
			const blocked = classify(write);
			expect(blocked.osc777).toBe(3); // session_start + prompt_submit + question_asked
			expect(blocked.pushes).toBe(1);
			expect(blocked.pops).toBe(1);

			vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
			expect(classify(write).titleSets.length).toBe(blocked.titleSets.length);

			await captured.events.get("tool_execution_end")?.[0]?.(
				{ toolCallId: "x", toolName: "ask_user_question", result: {}, isError: false } as never,
				createMockCtx() as never,
			);
			const resumed = classify(write);
			expect(resumed.osc777).toBe(4); // + tool_complete
			expect(resumed.pushes).toBe(2);
			expect(resumed.pops).toBe(1);

			vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2);
			expect(classify(write).titleSets.length).toBe(resumed.titleSets.length + 2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("non-blocking tool_call does NOT toggle the ticker", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_start")?.[0]?.({} as never, createMockCtx() as never);
			vi.advanceTimersByTime(FRAME_INTERVAL_MS);
			const before = classify(write);

			await captured.events.get("tool_call")?.[0]?.(
				{ toolName: "bash", input: { command: "ls" } } as never,
				createMockCtx() as never,
			);

			vi.advanceTimersByTime(FRAME_INTERVAL_MS);
			const after = classify(write);
			expect(after.titleSets.length).toBe(before.titleSets.length + 1);
			expect(after.pushes).toBe(1);
			expect(after.pops).toBe(0);
		} finally {
			vi.useRealTimers();
		}
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

describe("idle_prompt after agent_end (Item 3)", () => {
	it("emits idle_prompt with assistant summary 300ms after agent_end", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_end")?.[0]?.(
				{ messages: [] } as never,
				createMockCtx({
					branch: buildSessionEntries([
						makeUserMessage("deploy?"),
						makeAssistantMessage({ text: "run npm publish" }),
					]),
				}) as never,
			);

			// Before timer fires, no idle_prompt
			const beforeIdle = write.mock.calls.filter((c) => String(c[1]).includes("idle_prompt"));
			expect(beforeIdle.length).toBe(0);

			// Advance past 300ms
			vi.advanceTimersByTime(301);

			const idleWrites = write.mock.calls.filter((c) => String(c[1]).includes("idle_prompt"));
			expect(idleWrites.length).toBe(1);
			const json = String(idleWrites[0][1])
				.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
				.replace(/\x07$/, "");
			const payload = JSON.parse(json);
			expect(payload.event).toBe("idle_prompt");
			expect(payload.summary).toBe("run npm publish");
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels idle timer on next agent_start", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_end")?.[0]?.({ messages: [] } as never, createMockCtx() as never);
			vi.advanceTimersByTime(200); // less than 300ms

			await captured.events.get("agent_start")?.[0]?.({} as never, createMockCtx() as never);
			vi.advanceTimersByTime(500); // past original 300ms

			const idleWrites = write.mock.calls.filter((c) => String(c[1]).includes("idle_prompt"));
			expect(idleWrites.length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("active-work heartbeat (Item 4)", () => {
	it("emits prompt_submit heartbeat at configured interval", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_start")?.[0]?.({} as never, createMockCtx() as never);

			// Advance by heartbeat interval (default 15s)
			vi.advanceTimersByTime(15000);

			// Should have prompt_submit from agent_start + 1 heartbeat
			const promptSubmits = write.mock.calls
				.filter((c) => String(c[1]).includes("prompt_submit"))
				.map((c) => {
					const json = String(c[1])
						.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
						.replace(/\x07$/, "");
					return JSON.parse(json);
				});
			expect(promptSubmits.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops heartbeat on agent_end", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_start")?.[0]?.({} as never, createMockCtx() as never);
			await captured.events.get("agent_end")?.[0]?.({ messages: [] } as never, createMockCtx() as never);

			const before = write.mock.calls.length;
			vi.advanceTimersByTime(30000); // 2x heartbeat interval

			const newHeartbeats = write.mock.calls.slice(before).filter((c) => String(c[1]).includes("prompt_submit"));
			expect(newHeartbeats.length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("pauses heartbeat during blocking tool", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_start")?.[0]?.({} as never, createMockCtx() as never);
			await captured.events.get("tool_call")?.[0]?.(
				{ toolName: "ask_user_question", input: {}, toolCallId: "tc1" } as never,
				createMockCtx() as never,
			);

			const before = write.mock.calls.length;
			vi.advanceTimersByTime(30000);

			const newHeartbeats = write.mock.calls.slice(before).filter((c) => String(c[1]).includes("prompt_submit"));
			expect(newHeartbeats.length).toBe(0);

			// Resume heartbeat on tool_execution_end
			await captured.events.get("tool_execution_end")?.[0]?.(
				{ toolCallId: "tc1", toolName: "ask_user_question", result: {}, isError: false } as never,
				createMockCtx() as never,
			);
			const afterResume = write.mock.calls.length;
			vi.advanceTimersByTime(15000);

			const resumedHeartbeats = write.mock.calls
				.slice(afterResume)
				.filter((c) => String(c[1]).includes("prompt_submit"));
			expect(resumedHeartbeats.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("session_shutdown handler (Item 5)", () => {
	it("clears idle timer and stops spinner", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			register(pi);

			await captured.events.get("agent_end")?.[0]?.({ messages: [] } as never, createMockCtx() as never);

			await captured.events.get("session_shutdown")?.[0]?.(
				{ type: "session_shutdown", reason: "quit" } as never,
				createMockCtx() as never,
			);

			vi.advanceTimersByTime(500);
			const idleWrites = write.mock.calls.filter((c) => String(c[1]).includes("idle_prompt"));
			expect(idleWrites.length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("tool_input preview (Item 6)", () => {
	it("captures tool input and passes to tool_complete", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);

		await captured.events.get("tool_call")?.[0]?.(
			{
				toolName: "ask_user_question",
				input: { questions: [{ question: "Continue?" }] },
				toolCallId: "tc1",
			} as never,
			createMockCtx() as never,
		);
		await captured.events.get("tool_execution_end")?.[0]?.(
			{ toolCallId: "tc1", toolName: "ask_user_question", result: {}, isError: false } as never,
			createMockCtx() as never,
		);

		const toolCompleteWrites = write.mock.calls.filter((c) => String(c[1]).includes("tool_complete"));
		expect(toolCompleteWrites.length).toBe(1);
		const json = String(toolCompleteWrites[0][1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		const payload = JSON.parse(json);
		expect(payload.tool_name).toBe("ask_user_question");
		expect(payload.tool_input).toEqual({ questions: [{ question: "Continue?" }] });
	});

	it("does not capture tool_input for non-blocking tools", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		register(pi);

		await captured.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", input: { command: "ls" }, toolCallId: "tc2" } as never,
			createMockCtx() as never,
		);
		await captured.events.get("tool_execution_end")?.[0]?.(
			{ toolCallId: "tc2", toolName: "bash", result: {}, isError: false } as never,
			createMockCtx() as never,
		);

		const toolCompleteWrites = write.mock.calls.filter((c) => String(c[1]).includes("tool_complete"));
		expect(toolCompleteWrites.length).toBe(0);
	});
});

describe("createWorkflowQuestionTransport", () => {
	function osc777Payloads(write: Mock) {
		return write.mock.calls
			.filter((c) => String(c[1]).startsWith("\x1b]777;notify;"))
			.map((c) => {
				const json = String(c[1])
					.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
					.replace(/\x07$/, "");
				return JSON.parse(json);
			});
	}

	it("asked emits session_start then question_asked for the runId", () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const transport = createWorkflowQuestionTransport("/tmp/projects/widget");
		transport.asked("run-xyz");
		const payloads = osc777Payloads(write);
		expect(payloads).toHaveLength(2);
		expect(payloads[0].event).toBe("session_start");
		expect(payloads[0].session_id).toBe("run-xyz");
		expect(payloads[0].project).toBe("widget");
		expect(payloads[1].event).toBe("question_asked");
		expect(payloads[1].session_id).toBe("run-xyz");
	});

	it("resolved emits a single tool_complete for the runId", () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const transport = createWorkflowQuestionTransport("/tmp/projects/widget");
		transport.resolved("run-xyz");
		const payloads = osc777Payloads(write);
		expect(payloads).toHaveLength(1);
		expect(payloads[0].event).toBe("tool_complete");
		expect(payloads[0].session_id).toBe("run-xyz");
		expect(payloads[0].tool_name).toBe("ask_user_question");
		expect(payloads[0].tool_input).toBeUndefined();
	});

	it("writes nothing when supportsStructured is false (outside Warp)", () => {
		// no Warp env vars set (beforeEach cleared them) → supportsStructured is false
		const { open } = primeFs();
		const transport = createWorkflowQuestionTransport("/tmp");
		transport.asked("run-xyz");
		transport.resolved("run-xyz");
		expect(open).not.toHaveBeenCalled();
	});

	it("writes nothing on a broken Warp build", () => {
		setBrokenWarpEnv();
		const { open } = primeFs();
		const transport = createWorkflowQuestionTransport("/tmp");
		transport.asked("run-xyz");
		transport.resolved("run-xyz");
		expect(open).not.toHaveBeenCalled();
	});
});

describe("blocking-tool abort (ESC) unblocks at agent_end", () => {
	it("emits tool_complete from agent_end when a blocking tool_call was never resolved (ESC path)", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		__resetState(); // isolate the pending-call map from prior tests
		register(pi);

		// Blocking tool asked → Warp badge goes Blocked.
		await captured.events.get("tool_call")?.[0]?.(
			{
				toolName: "ask_user_question",
				input: { questions: [{ question: "Continue?" }] },
				toolCallId: "tc1",
			} as never,
			createMockCtx() as never,
		);
		// User presses ESC: tool_execution_end never fires — the agent loop just ends.
		await captured.events.get("agent_end")?.[0]?.({ messages: [] } as never, createMockCtx() as never);

		const toolCompleteWrites = write.mock.calls.filter((c) => String(c[1]).includes("tool_complete"));
		expect(toolCompleteWrites.length).toBe(1); // the stale Blocked badge gets cleared
		const json = String(toolCompleteWrites[0][1])
			.replace(/^\x1b\]777;notify;warp:\/\/cli-agent;/, "")
			.replace(/\x07$/, "");
		const payload = JSON.parse(json);
		expect(payload.event).toBe("tool_complete");
		expect(payload.tool_name).toBe("ask_user_question");
		expect(payload.tool_input).toEqual({ questions: [{ question: "Continue?" }] });
	});

	it("does not re-emit tool_complete on a second agent_end (pending map drained)", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		__resetState();
		register(pi);

		await captured.events.get("tool_call")?.[0]?.(
			{ toolName: "ask_user_question", input: {}, toolCallId: "tc1" } as never,
			createMockCtx() as never,
		);
		await captured.events.get("agent_end")?.[0]?.({ messages: [] } as never, createMockCtx() as never);
		await captured.events.get("agent_end")?.[0]?.({ messages: [] } as never, createMockCtx() as never);

		const toolCompleteWrites = write.mock.calls.filter((c) => String(c[1]).includes("tool_complete"));
		expect(toolCompleteWrites.length).toBe(1);
	});

	it("normal answer (tool_execution_end fires) does NOT double-emit at agent_end", async () => {
		setWorkingWarpEnv();
		const { write } = primeFs();
		const { pi, captured } = createMockPi();
		__resetState();
		register(pi);

		await captured.events.get("tool_call")?.[0]?.(
			{ toolName: "ask_user_question", input: {}, toolCallId: "tc1" } as never,
			createMockCtx() as never,
		);
		await captured.events.get("tool_execution_end")?.[0]?.(
			{ toolCallId: "tc1", toolName: "ask_user_question", result: {}, isError: false } as never,
			createMockCtx() as never,
		);
		await captured.events.get("agent_end")?.[0]?.({ messages: [] } as never, createMockCtx() as never);

		const toolCompleteWrites = write.mock.calls.filter((c) => String(c[1]).includes("tool_complete"));
		expect(toolCompleteWrites.length).toBe(1); // only the real completion, not a duplicate from agent_end
	});
});
