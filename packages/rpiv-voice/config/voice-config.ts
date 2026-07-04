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
