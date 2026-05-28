import { isEventEnabled, loadTelemetryConfig, type TelemetryConfig } from "./config.js";
import type { TelemetryEvent } from "./types/events.js";
import type { TelemetryProvider } from "./types/provider.js";

/**
 * Bounded async telemetry dispatcher.
 *
 * Owns the provider registry plus the queue / in-flight / shutdown state.
 * Exported as a class so test isolation can be "discard the instance" rather
 * than "remember to call N clear functions." A module-level singleton + thin
 * function delegates preserve the historical functional API.
 */
export class Dispatcher {
	private readonly providers: TelemetryProvider[] = [];
	private queue: TelemetryEvent[] = [];
	private flushing = false;
	private inFlight: Promise<void> = Promise.resolve();
	private shuttingDown = false;
	private dropCount = 0;
	// Lazy-loaded on first dispatch — keeps module import side-effect-free.
	private cachedConfig: TelemetryConfig | null = null;
	// Names of providers whose last trackEvent rejected. Used to warn once on
	// first failure and once on recovery, instead of flooding logs every event.
	private readonly failedProviders = new Set<string>();

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

	dispatch(event: TelemetryEvent): void {
		if (this.shuttingDown) return;
		if (this.providers.length === 0) return;
		this.cachedConfig ??= loadTelemetryConfig();
		if (!isEventEnabled(event.kind, this.cachedConfig.events)) return;

		const maxQueueSize = this.cachedConfig.dispatcher.maxQueueSize;
		if (this.queue.length >= maxQueueSize) {
			this.queue.shift();
			this.dropCount++;
			if (this.dropCount % 10 === 0) {
				console.warn(`[rpiv-telemetry] dropped ${this.dropCount} events due to backpressure`);
			}
		}
		this.queue.push(event);
		this.scheduleFlush();
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;

		const remaining = this.queue;
		this.queue = [];
		this.flushing = false;

		if (remaining.length > 0) {
			const providers = this.getProviders();
			for (const evt of remaining) {
				await this.broadcastEvent(providers, evt);
			}
		}

		await this.inFlight;

		const providers = this.getProviders();
		await Promise.allSettled(providers.map((p) => p.flush()));
		await Promise.allSettled(providers.map((p) => p.shutdown()));
	}

	reset(): void {
		this.providers.length = 0;
		this.queue = [];
		this.flushing = false;
		this.shuttingDown = false;
		this.dropCount = 0;
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
			const name = provider.name;
			if (result.status === "rejected") {
				if (!this.failedProviders.has(name)) {
					this.failedProviders.add(name);
					console.warn(`[rpiv-telemetry] provider ${name} rejected event: ${formatReason(result.reason)}`);
				}
			} else if (this.failedProviders.has(name)) {
				this.failedProviders.delete(name);
				console.warn(`[rpiv-telemetry] provider ${name} recovered`);
			}
		});
	}
}

function formatReason(reason: unknown): string {
	if (reason instanceof Error) return reason.message;
	return String(reason);
}

// ---------------------------------------------------------------------------
// Module singleton + thin function delegates (historical functional API)
// ---------------------------------------------------------------------------

const singleton = new Dispatcher();

/** Dispatch a telemetry event to all registered providers (non-blocking). */
export function dispatchTelemetryEvent(event: TelemetryEvent): void {
	singleton.dispatch(event);
}

/** Return the singleton dispatcher instance. */
export function getTelemetryDispatcher(): Dispatcher {
	return singleton;
}

/** Graceful shutdown: drain queue, flush + shutdown all providers. */
export function shutdownTelemetryDispatcher(): Promise<void> {
	return singleton.shutdown();
}

/** Reset dispatcher state (providers + queue + config cache). Used by teardownTelemetry(). */
export function resetTelemetryDispatcher(): void {
	singleton.reset();
}

/** Register a telemetry provider. Returns a disposer that removes it. */
export function registerTelemetryProvider(provider: TelemetryProvider): () => void {
	return singleton.registerProvider(provider);
}

/** Snapshot of currently registered providers. */
export function getProviders(): readonly TelemetryProvider[] {
	return singleton.getProviders();
}
