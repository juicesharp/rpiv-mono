/**
 * semaphore.ts — bounded-concurrency gate for the parallel fanout dispatcher.
 *
 * `run(fn)` acquires a slot (queuing FIFO if `limit` are already in flight),
 * runs `fn`, and releases on settle. When `signal` aborts, every QUEUED waiter
 * rejects with a `WorkflowAbortError` so not-yet-started units never run;
 * already-active children are aborted by the host (the dispatcher threads
 * `signal` into each `spawnChild`). A fresh `acquire` after abort rejects
 * immediately. `Semaphore(1)` serializes — the cursor/`state.named`
 * representation is then identical to the sequential path.
 */

import { WorkflowAbortError, WorkflowConfigError } from "./internal-utils.js";

export class Semaphore {
	private active = 0;
	private readonly queue: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

	constructor(
		private readonly limit: number,
		private readonly signal?: AbortSignal,
	) {
		if (limit < 1) throw new WorkflowConfigError(`Semaphore limit must be ≥ 1, got ${limit}`);
		signal?.addEventListener("abort", () => this.drain(), { once: true });
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.signal?.aborted) return Promise.reject(new WorkflowAbortError());
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => this.queue.push({ resolve, reject }));
	}

	private release(): void {
		const next = this.queue.shift();
		if (next)
			next.resolve(); // transfer the slot to the next waiter (active unchanged)
		else this.active--;
	}

	private drain(): void {
		while (this.queue.length > 0) this.queue.shift()?.reject(new WorkflowAbortError());
	}
}
