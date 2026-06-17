/**
 * FakeConcurrentHost — a `WorkflowHostContext` double with NO Pi import, built
 * to PROVE the parallel fanout dispatcher's concurrency behavior end-to-end
 * through `runWorkflow`. Its `spawnChild`:
 *   - records `{ prompt, lane, model, signal, reattach, startOrder, endOrder }`
 *     per call so tests assert dispatch order + lane/model/signal threading;
 *   - tracks the live in-flight count + the PEAK (`maxActive`) so a test can
 *     assert "never more than `maxConcurrency` ran at once" and "exactly the cap
 *     ran concurrently";
 *   - optionally BLOCKS on a shared gate (`gate: true`) until `release()` so the
 *     test can freeze the run with the first `maxConcurrency` children in flight,
 *     inspect, then let it drain;
 *   - synthesizes a guaranteed-in-session child ctx (carrying `sendUserMessage`)
 *     whose `getBranch()` returns a scripted transcript — the parent ctx STAYS
 *     VALID (no swap).
 *
 * To simulate an abort, hand a `childBranch` that returns an assistant message
 * with `stopReason: "aborted"` (postStage then throws `WorkflowAbortError`).
 *
 * Casts (`as unknown as`) are acceptable here — this is a fixture, not
 * production code (test-utils boundary rule).
 */

import type {
	ExecutionLane,
	ModelSelection,
	WorkflowHostContext,
	WorkflowSessionContext,
} from "@juicesharp/rpiv-workflow";

/** What the host recorded for one `spawnChild` call. */
export interface FakeSpawnRecord {
	prompt: string;
	lane: ExecutionLane;
	model?: ModelSelection;
	signal?: AbortSignal;
	reattach?: { sessionFile: string };
	/** 1-based order in which this spawnChild was ENTERED. */
	startOrder: number;
	/** 1-based order in which this spawnChild SETTLED (-1 until settled). */
	endOrder: number;
}

export interface FakeConcurrentHostOptions {
	/** Background-lane concurrency cap the ctx advertises. Default 1 (sequential). */
	maxConcurrency?: number;
	/** Real temp dir — the run writes its JSONL trail under here. */
	cwd?: string;
	hasUI?: boolean;
	/** When true, every spawnChild BLOCKS until `release()` resolves the shared
	 *  gate — freezing the run with the first `maxConcurrency` children in flight. */
	gate?: boolean;
	/** Build the child's transcript branch for a spawn. Default: one assistant
	 *  message naming a unique `.rpiv/artifacts/<bucket>/unit-<n>.md` path so the
	 *  standard md collector succeeds. Return a message with `stopReason:"aborted"`
	 *  to simulate an abort. */
	childBranch?: (rec: FakeSpawnRecord, index: number) => unknown[];
	/** Artifact bucket the default `childBranch` writes into. Default "audits". */
	bucket?: string;
}

export interface FakeConcurrentHost {
	/** The per-command ctx handed to `runWorkflow`. */
	ctx: WorkflowHostContext;
	/** Every spawnChild call, in dispatch order. */
	spawns: FakeSpawnRecord[];
	/** PEAK number of concurrently in-flight spawnChild calls observed. */
	maxActive: number;
	/** Currently in-flight spawnChild calls. */
	active(): number;
	notifications: Array<{ msg: string; level: string }>;
	statusUpdates: Array<{ key: string; value: string | undefined }>;
	/** Change the advertised cap (call BEFORE `runWorkflow` — the dispatcher reads it once). */
	setMaxConcurrency(n: number): void;
	/** Release the shared gate (gate mode) — current AND future spawns proceed. */
	release(): void;
	/** Resolve once at least `n` spawnChild calls are simultaneously in flight. */
	waitForActive(n: number): Promise<void>;
}

/** An assistant-text branch entry (optionally carrying a `stopReason`). */
function assistantMessage(text: string, stopReason?: string): unknown {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			...(stopReason !== undefined ? { stopReason } : {}),
		},
	};
}

export function createFakeConcurrentHost(opts: FakeConcurrentHostOptions = {}): FakeConcurrentHost {
	const spawns: FakeSpawnRecord[] = [];
	const notifications: Array<{ msg: string; level: string }> = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const cwd = opts.cwd ?? "/tmp/fake-concurrent-cwd";
	const bucket = opts.bucket ?? "audits";

	let maxConcurrency = opts.maxConcurrency ?? 1;
	let active = 0;
	let maxActive = 0;
	let started = 0;
	let ended = 0;

	// Shared gate — a single deferred every spawn awaits in gate mode. Resolving
	// it lets ALL blocked AND future spawns proceed (the Semaphore still caps how
	// many run at once, so the peak never exceeds maxConcurrency).
	let releaseGate: () => void = () => {};
	const gatePromise = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});

	// Active-threshold waiters — resolve a test's `waitForActive(n)` the moment
	// the in-flight count reaches `n`.
	const activeWaiters: Array<{ n: number; resolve: () => void }> = [];
	const notifyActiveWaiters = (): void => {
		for (let i = activeWaiters.length - 1; i >= 0; i--) {
			if (active >= activeWaiters[i]!.n) {
				activeWaiters[i]!.resolve();
				activeWaiters.splice(i, 1);
			}
		}
	};

	const childBranch =
		opts.childBranch ??
		((_rec: FakeSpawnRecord, index: number): unknown[] => [
			assistantMessage(`wrote .rpiv/artifacts/${bucket}/unit-${index}.md`),
		]);

	const ui = {
		notify: (msg: string, level: "info" | "warning" | "error" = "info"): void => {
			notifications.push({ msg, level });
		},
		setStatus: (key: string, text: string | undefined): void => {
			statusUpdates.push({ key, value: text });
		},
	};

	const sessionManagerFor = (branch: unknown[], file: string | undefined) => ({
		getBranch: () => branch,
		getSessionId: () => "fake-session",
		getSessionFile: () => file,
	});

	const spawnChild = async <T>(options: {
		prompt: string;
		lane: ExecutionLane;
		model?: ModelSelection;
		signal?: AbortSignal;
		reattach?: { sessionFile: string };
		withSession: (child: WorkflowSessionContext) => Promise<T>;
	}): Promise<T> => {
		const index = spawns.length;
		const rec: FakeSpawnRecord = {
			prompt: options.prompt,
			lane: options.lane,
			model: options.model,
			signal: options.signal,
			reattach: options.reattach,
			startOrder: ++started,
			endOrder: -1,
		};
		spawns.push(rec);
		active++;
		if (active > maxActive) maxActive = active;
		notifyActiveWaiters();
		try {
			if (opts.gate) await gatePromise;
			// reattach opens a persisted session WITHOUT replaying the prompt — model
			// that as an empty resumed transcript for the body to promote from.
			const branch = options.reattach ? [] : childBranch(rec, index);
			const child = {
				cwd,
				hasUI: opts.hasUI ?? false,
				ui,
				sessionManager: sessionManagerFor(branch, undefined),
				waitForIdle: async () => {},
				maxConcurrency,
				signal: options.signal,
				sendUserMessage: async () => {},
				spawnChild,
			} as unknown as WorkflowSessionContext;
			return await options.withSession(child);
		} finally {
			active--;
			rec.endOrder = ++ended;
		}
	};

	const ctx = {
		cwd,
		hasUI: opts.hasUI ?? false,
		ui,
		sessionManager: sessionManagerFor([], `${cwd}/.session.jsonl`),
		waitForIdle: async () => {},
		get maxConcurrency() {
			return maxConcurrency;
		},
		spawnChild,
	} as unknown as WorkflowHostContext;

	return {
		ctx,
		spawns,
		get maxActive() {
			return maxActive;
		},
		active: () => active,
		notifications,
		statusUpdates,
		setMaxConcurrency: (n: number) => {
			maxConcurrency = n;
		},
		release: () => releaseGate(),
		waitForActive: (n: number) =>
			active >= n ? Promise.resolve() : new Promise<void>((resolve) => activeWaiters.push({ n, resolve })),
	};
}
