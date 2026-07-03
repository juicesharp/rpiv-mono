/**
 * Semaphore — the bounded-concurrency gate behind the parallel fanout
 * dispatcher. Proves: never more than `limit` run at once, FIFO slot transfer
 * to queued waiters, and (abort) queued waiters reject with a
 * `WorkflowAbortError` while a fresh acquire after abort rejects immediately.
 */

import { describe, expect, it } from "vitest";
import { isAbortError, WorkflowConfigError } from "./internal-utils.js";
import { Semaphore } from "./semaphore.js";

/** A manually-resolvable promise — the test controls when each task settles. */
function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Flush all pending microtasks (and the timer queue) so chained awaits settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("Semaphore", () => {
	it("rejects a limit < 1 with a typed WorkflowConfigError", () => {
		expect(() => new Semaphore(0)).toThrow(WorkflowConfigError);
		expect(() => new Semaphore(0)).toThrow(/limit must be ≥ 1/);
	});

	it("never runs more than `limit` tasks concurrently", async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;
		const gates = Array.from({ length: 5 }, () => deferred());

		const runs = gates.map((g, i) =>
			sem.run(async () => {
				active++;
				peak = Math.max(peak, active);
				await g.promise;
				active--;
				return i;
			}),
		);

		// Let the queue settle — only 2 should be active, the rest queued.
		await flush();
		expect(active).toBe(2);
		expect(peak).toBe(2);

		// Drain in waves; the peak never exceeds the limit.
		for (const g of gates) {
			g.resolve();
			await flush();
		}
		const results = await Promise.all(runs);
		expect(results).toEqual([0, 1, 2, 3, 4]);
		expect(peak).toBe(2);
	});

	it("transfers a freed slot to the next queued waiter in FIFO order", async () => {
		const sem = new Semaphore(1);
		const order: number[] = [];
		const gates = Array.from({ length: 3 }, () => deferred());

		const runs = gates.map((g, i) =>
			sem.run(async () => {
				order.push(i);
				await g.promise;
			}),
		);

		await flush();
		expect(order).toEqual([0]); // only the first acquired the single slot

		gates[0]!.resolve();
		await flush();
		expect(order).toEqual([0, 1]); // slot handed to waiter 1 (FIFO), not 2

		gates[1]!.resolve();
		await flush();
		expect(order).toEqual([0, 1, 2]);

		gates[2]!.resolve();
		await Promise.all(runs);
	});

	it("aborting rejects every QUEUED waiter with a WorkflowAbortError", async () => {
		const ctrl = new AbortController();
		const sem = new Semaphore(1, ctrl.signal);
		const gate = deferred();

		// One active task holds the slot; two more queue behind it.
		const active = sem.run(async () => {
			await gate.promise;
		});
		const queued1 = sem.run(async () => {}).catch((e) => e);
		const queued2 = sem.run(async () => {}).catch((e) => e);

		await Promise.resolve();
		ctrl.abort();

		const [e1, e2] = await Promise.all([queued1, queued2]);
		expect(isAbortError(e1)).toBe(true);
		expect(isAbortError(e2)).toBe(true);

		// The in-flight task still settles normally (the host aborts it separately).
		gate.resolve();
		await active;
	});

	it("a fresh acquire after abort rejects immediately", async () => {
		const ctrl = new AbortController();
		const sem = new Semaphore(2, ctrl.signal);
		ctrl.abort();
		const err = await sem.run(async () => "never").catch((e) => e);
		expect(isAbortError(err)).toBe(true);
	});
});
