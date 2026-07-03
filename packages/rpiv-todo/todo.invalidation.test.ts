import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerTodo from "./index.js";
import { getState, replaceState } from "./state/store.js";
import { __resetState } from "./todo.js";

// Pins the substring `isStaleCtxError` matches in pi-core's invalidated-proxy error.
const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload.";

// A ctx whose sessionManager getter throws — replayFromBranch reads
// ctx.sessionManager.getBranch() first, so this is where the stale proxy bites.
function throwingCtx(message: string) {
	return {
		hasUI: false,
		get sessionManager(): never {
			throw new Error(message);
		},
	};
}

const SEEDED = { tasks: [{ id: 1, subject: "keep me", status: "pending" }], nextId: 2 };
const SID = "s1";

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	return { captured };
}

beforeEach(() => __resetState());
afterEach(() => __resetState());

describe.each(["session_compact", "session_tree"] as const)("%s — stale ctx handling", (event) => {
	it("keeps current state on a stale ctx (replacement session replays)", async () => {
		const { captured } = setup();
		replaceState(SID, SEEDED as never);
		const handler = captured.events.get(event)?.[0];
		await expect(handler?.({} as never, throwingCtx(STALE_CTX_MESSAGE) as never)).resolves.toBeUndefined();
		// State untouched — no replay ran, the prior seed survives on the same session.
		expect(getState(SID)).toEqual(SEEDED);
	});

	it("propagates a non-stale replay error", async () => {
		const { captured } = setup();
		const handler = captured.events.get(event)?.[0];
		await expect(handler?.({} as never, throwingCtx("boom: real replay bug") as never)).rejects.toThrow("boom");
	});
});
