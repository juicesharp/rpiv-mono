/**
 * voice-config — persistence of optional rpiv-voice settings at
 * `~/.config/rpiv-voice/voice.json`.
 *
 * Load is crash-resistant: malformed JSON or missing file resolves to an
 * empty config (warning emitted via `rpiv-config.loadJsonConfig`).
 *
 * Save returns a `boolean`; the caller (voice-session shell) notifies the
 * user on failure so the UI never lies about persistence ("saved" while the
 * disk write actually failed). chmod to 0600 is best-effort and never gates
 * the return — see `rpiv-config.saveJsonConfig` for the full contract.
 */

import { configPath, loadJsonConfigWithLegacyFallback, saveJsonConfig } from "@juicesharp/rpiv-config";

// ── Filesystem layout ────────────────────────────────────────────────────────
const CONFIG_PATH = configPath("rpiv-voice", "voice.json");

// ── Module-level singleton key (cleared by test/setup beforeEach) ────────────
const VOICE_STATE_KEY = Symbol.for("rpiv-voice");

export interface VoiceConfig {
	readonly hallucinationFilterEnabled?: boolean;
	readonly equalizerEnabled?: boolean;
	/**
	 * Decode thread count for the STT engine. JSON-only key: the settings
	 * screen never writes it, and it applies when `/voice` next constructs the
	 * engine (restart-to-apply). Integer 1–16 — invalid values decode to the
	 * default 4 and integers above 16 clamp to 16; see `resolveNumThreads`.
	 */
	readonly numThreads?: number;
}

/**
 * The hallucination filter defaults to ENABLED. We only persist the off-state
 * to keep voice.json minimal, which means "field absent" must be read as
 * "enabled".
 */
export function isHallucinationFilterEnabled(config: { hallucinationFilterEnabled?: boolean }): boolean {
	return config.hallucinationFilterEnabled !== false;
}

/**
 * The equalizer defaults to DISABLED. Mirror of the hallucination-filter
 * decoding rule but with the inverted polarity.
 */
export function isEqualizerEnabled(config: { equalizerEnabled?: boolean }): boolean {
	return config.equalizerEnabled === true;
}

/**
 * Decode-thread default. Mirrors the engine-side fallback constant in
 * `packages/rpiv-voice/audio/stt-engine.ts` — the engine applies the same
 * default when `numThreads` is absent from its constructor config.
 */
export const DEFAULT_NUM_THREADS = 4;

/**
 * Decode-thread ceiling. 16 covers the best datapoint measured while
 * investigating issue #200 and bounds ONNX Runtime intra-op thread
 * oversubscription — beyond it, extra threads only add contention.
 */
export const MAX_NUM_THREADS = 16;

/**
 * Decode the JSON-only `numThreads` key for engine construction: missing /
 * non-number ("8", null, NaN) / non-integer (8.5) / below-floor (0, negative)
 * values fall back to `DEFAULT_NUM_THREADS`; integers 1–16 pass through;
 * integers above 16 clamp to `MAX_NUM_THREADS`. Baked in when `/voice`
 * starts — changing voice.json requires re-running `/voice` to apply.
 */
export function resolveNumThreads(config: { numThreads?: number }): number {
	const value = config.numThreads;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		return DEFAULT_NUM_THREADS;
	}
	return Math.min(value, MAX_NUM_THREADS);
}

export function loadVoiceConfig(): VoiceConfig {
	return loadJsonConfigWithLegacyFallback<VoiceConfig>("rpiv-voice", "voice.json");
}

export function saveVoiceConfig(config: VoiceConfig): boolean {
	return saveJsonConfig(CONFIG_PATH, config);
}

export function __resetState(): void {
	const g = globalThis as unknown as { [k: symbol]: unknown };
	delete g[VOICE_STATE_KEY];
}
