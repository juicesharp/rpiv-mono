import { isEventEnabled, loadTelemetryConfig, type TelemetryConfig } from "./config.ts";
import type { TelemetryEvent } from "./types/events.ts";
import type { TelemetryProvider } from "./types/provider.ts";

/**
 * Bounded async telemetry dispatcher.
 *
 * Owns the provider registry plus the queue / in-flight / shutdown state.
 * One instance per Pi process via the module-level singleton below; the
 * public API is the function delegates (`dispatchTelemetryEvent`, etc.) —
 * the class itself is exported only for direct test reach-in and is NOT
 * re-exported through the package barrel.
 *
 * @internal
 */
export class Dispatcher {
	private readonly providers: TelemetryProvider[] = [];
	private queue: TelemetryEvent[] = [];
	private flushing = false;
	private inFlight: Promise<void> = Promise.resolve();
	private shuttingDown = false;
	// Lazy-loaded on first dispatch — keeps module import side-effect-free.
	private cachedConfig: TelemetryConfig | null = null;
	// Names of providers whose last trackEvent rejected. Used to warn once on
	// first failure and once on recovery, instead of flooding logs every event.
	private readonly failedProviders = new Set<string>();
	// Transition tracker for the backpressure drop path — warns once when the
	// queue first reaches capacity and again when it drains below capacity.
	// Mirrors the `failedProviders` posture: no periodic spam.
	private backpressureActive = false;

	registerProvider(provider: TelemetryProvider): () => void {
		this.providers.push(provider);
		return () => {
			const idx = this.providers.indexOf(provider);
			if (idx >= 0) this.providers.splice(idx, 1);
		};
	}

	getProviders(): readonly TelemetryProvider[] {
		return [...this.providers];
	}

	/**
	 * Enqueue an event for fan-out. Events emitted before any provider is
	 * registered are silently dropped — register providers before Pi handlers
	 * begin firing (see README's "lifecycle" section).
	 */
	dispatch(event: TelemetryEvent): void {
		if (this.shuttingDown) return;
		if (this.providers.length === 0) return;
		this.cachedConfig ??= loadTelemetryConfig();
		if (!isEventEnabled(event.kind, this.cachedConfig.events)) return;

		const maxQueueSize = this.cachedConfig.dispatcher.maxQueueSize;
		if (this.queue.length >= maxQueueSize) {
			this.queue.shift();
			if (!this.backpressureActive) {
				this.backpressureActive = true;
				console.warn(`[rpiv-telemetry] backpressure: queue saturated at ${maxQueueSize}; dropping oldest events`);
			}
		} else if (this.backpressureActive && this.queue.length < maxQueueSize - 1) {
			// Hysteresis: only clear once we're back well under cap.
			this.backpressureActive = false;
			console.warn("[rpiv-telemetry] backpressure recovered: queue back under capacity");
		}
		this.queue.push(event);
		this.scheduleFlush();
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;

		// Snapshot the queue *before* awaiting inFlight so any drain currently
		// running owns its captured batch and our `remaining` here owns the
		// post-batch tail. Preserves FIFO at the provider boundary.
		const remaining = this.queue;
		this.queue = [];
		this.flushing = false;

		// Drain the in-flight batch first so providers see older events
		// before the post-batch tail — preserves FIFO under shutdown-mid-drain.
		await this.inFlight;

		if (remaining.length > 0) {
			const providers = this.getProviders();
			for (const evt of remaining) {
				await this.broadcastEvent(providers, evt);
			}
		}

		const providers = this.getProviders();
		await Promise.allSettled(providers.map((p) => p.flush()));
		await Promise.allSettled(providers.map((p) => p.shutdown()));
	}

	reset(): void {
		this.providers.length = 0;
		this.queue = [];
		this.flushing = false;
		this.shuttingDown = false;
		this.backpressureActive = false;
		this.inFlight = Promise.resolve();
		this.cachedConfig = null;
		this.failedProviders.clear();
	}

	private scheduleFlush(): void {
		if (this.flushing) return;
		this.flushing = true;
		this.drain();
	}

	private drain(): void {
		if (this.queue.length === 0) {
			this.flushing = false;
			return;
		}
		const batch = this.queue;
		this.queue = [];

		this.inFlight = this.inFlight.then(async () => {
			const providers = this.getProviders();
			for (const evt of batch) {
				await this.broadcastEvent(providers, evt);
			}
			if (this.queue.length > 0) {
				const handle = setImmediate(() => this.drain());
				if (typeof (handle as ReturnType<typeof setImmediate>).unref === "function") {
					(handle as ReturnType<typeof setImmediate>).unref();
				}
			} else {
				this.flushing = false;
			}
		});
	}

	// Fan an event out to providers and surface per-provider failure transitions
	// once. First rejection logs "rejected event"; first success after a
	// rejection logs "recovered". Steady-state success/failure is silent.
	private async broadcastEvent(providers: readonly TelemetryProvider[], evt: TelemetryEvent): Promise<void> {
		const results = await Promise.allSettled(providers.map((p) => p.trackEvent(evt)));
		results.forEach((result, idx) => {
			const provider = providers[idx];
			if (!provider) return;
			const name = provider.meta.name;
			if (result.status === "rejected") {
				if (!this.failedProviders.has(name)) {
					this.failedProviders.add(name);
					const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
					console.warn(`[rpiv-telemetry] provider ${name} rejected event: ${reason}`);
				}
			} else if (this.failedProviders.has(name)) {
				this.failedProviders.delete(name);
				console.warn(`[rpiv-telemetry] provider ${name} recovered`);
			}
		});
	}
}

// ---------------------------------------------------------------------------
// Module singleton + thin function delegates (historical functional API)
// ---------------------------------------------------------------------------

const singleton = new Dispatcher();

/**
 * Dispatch a telemetry event to all registered providers (non-blocking).
 *
 * Events emitted before any provider is registered are silently dropped.
 * Hosts that build custom provider registrations should call
 * `registerTelemetryProvider` before Pi's lifecycle handlers begin firing.
 */
export function dispatchTelemetryEvent(event: TelemetryEvent): void {
	singleton.dispatch(event);
}

/** Graceful shutdown: drain queue, flush + shutdown all providers. */
export function shutdownTelemetryDispatcher(): Promise<void> {
	return singleton.shutdown();
}

/** Reset dispatcher state (providers + queue + config cache). Used by teardownTelemetry(). */
export function resetTelemetryDispatcher(): void {
	singleton.reset();
}

/**
 * Register a telemetry provider. Returns a disposer that removes it.
 *
 * **Lifecycle contract:** call this before Pi handlers fan out their first
 * event. Events that land before any provider is registered are dropped at the
 * dispatcher boundary (no buffer). In the built-in flow, `initInstrumentation`
 * registers configured providers before attaching `pi.on(...)` handlers, so
 * the drop window is empty.
 */
export function registerTelemetryProvider(provider: TelemetryProvider): () => void {
	return singleton.registerProvider(provider);
}

/** Snapshot of currently registered providers. */
export function getProviders(): readonly TelemetryProvider[] {
	return singleton.getProviders();
}
