/**
 * model-download — fetches the multilingual Whisper base model archive into
 * `~/.pi/models/whisper-base/`, extracts it, prunes unused fp32 duplicates,
 * and writes a sentinel file marking the install complete.
 *
 * The upstream archive ships BOTH fp32 (~290 MB) and int8 (~155 MB) variants
 * in one tarball. We use int8 for CPU inference, so we delete the fp32
 * duplicates after extraction to keep on-disk usage to ~157 MB.
 *
 * Progress is surfaced phase-by-phase (downloading → extracting → verifying);
 * we deliberately don't forward per-chunk fetch progress, because callers
 * pipe phase strings into a single-line ctx.ui.setStatus and per-chunk would
 * spam the status surface.
 */

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { loadVoiceConfig } from "../config/voice-config.js";
import { t } from "../state/i18n-bridge.js";

const execFileAsync = promisify(execFile);

// ── Paths ────────────────────────────────────────────────────────────────────
export const MODELS_DIR = join(homedir(), ".pi", "models");
export const WHISPER_BASE_DIR = join(MODELS_DIR, "whisper-base");
export const SENTINEL_FILE = ".download-complete";

export function getModelDir(flavour: string): string {
	return join(MODELS_DIR, `whisper-${flavour}`);
}

function getWhisperFlavour(): string {
	const config = loadVoiceConfig();
	return config.whisperModelType || "base";
}

// ── Source archive ───────────────────────────────────────────────────────────
// Approx archive size on the wire is ~198 MB; the splash now shows the exact
// total once Content-Length is parsed, so we no longer encode the estimate
// in any user-facing string. Kept here for documentation only.
const MODEL_RELEASE_TAG = "asr-models";

// ── Tar invocation ───────────────────────────────────────────────────────────
const TAR_BIN = "tar";
// `--strip-components=1` flattens sherpa's top-level wrapper directory so the
// REQUIRED_FILES land directly inside the model directory.
const TAR_FLAGS: readonly string[] = ["-xjf"];
const TAR_STRIP_FLAG = "--strip-components=1";

// ── Status messages ──────────────────────────────────────────────────────────
// Resolved at progress-emit time (not module load) so live `/languages` flips
// take effect mid-download.
const msgDownloading = (flavour: string): string => t("splash.downloading", `Downloading Whisper ${flavour} model…`);
const msgExtracting = (): string => t("splash.extracting", "Extracting model files…");
const msgVerifying = (): string => t("splash.verifying", "Verifying model files…");

// ── Public API ───────────────────────────────────────────────────────────────

export interface DownloadProgress {
	phase: "downloading" | "extracting" | "verifying";
	/** 0-100 integer when total size is known. Omitted when the server didn't
	 *  send a Content-Length, or when the phase isn't byte-bounded. */
	percent?: number;
	/** Bytes received so far during the download phase (cumulative). */
	bytesReceived?: number;
	/** Total expected bytes when known via Content-Length. */
	totalBytes?: number;
	message?: string;
}
export type ProgressCallback = (progress: DownloadProgress) => void;

// Bound how often we surface byte-count updates: terminals re-flow on every
// emit and a fast network can fire chunks at >1 kHz, which would burn CPU on
// no-op renders. 200 ms feels lively without being chatty.
const PROGRESS_THROTTLE_MS = 200;

export interface ModelPaths {
	encoderPath: string;
	decoderPath: string;
	tokensPath: string;
}

export type ModelInstallStage = "download" | "extract" | "verify";

/**
 * Tagged failure surface for `ensureModelDownloaded` — lets callers distinguish
 * "couldn't fetch the bytes" (network / HTTP) from "got the bytes but the
 * archive was bad" (tar exit, missing file). Diagnostics matter: previously
 * every stage rolled up to the same "check your internet connection" string.
 */
export class ModelInstallError extends Error {
	constructor(
		readonly stage: ModelInstallStage,
		cause: unknown,
	) {
		super(`model install failed at ${stage}`, { cause: cause as Error });
		this.name = "ModelInstallError";
	}
}

export function isModelDownloaded(): boolean {
	const flavour = getWhisperFlavour();
	return existsSync(join(getModelDir(flavour), SENTINEL_FILE));
}

export function getModelPaths(): ModelPaths {
	const flavour = getWhisperFlavour();
	const modelDir = getModelDir(flavour);
	return {
		encoderPath: join(modelDir, `${flavour}-encoder.int8.onnx`),
		decoderPath: join(modelDir, `${flavour}-decoder.int8.onnx`),
		tokensPath: join(modelDir, `${flavour}-tokens.txt`),
	};
}

/**
 * Re-runs the post-extraction file existence check against an "already
 * downloaded" install. The sentinel only proves the *previous* run wrote it —
 * a user (or another tool) can have removed a required `.onnx` since then,
 * which would otherwise surface as an opaque native crash inside
 * sherpa-onnx's `OfflineRecognizer` constructor. Callers should call this
 * after `isModelDownloaded()` returns true and *before* loading the engine,
 * and on failure should `removeModelInstall()` so the next launch redownloads.
 */
export function assertModelIntact(): void {
	const flavour = getWhisperFlavour();
	const modelDir = getModelDir(flavour);
	verifyModelFiles(flavour, modelDir);
}

/** Wipe the entire model directory — used to recover from any partial /
 * corrupt install state. Idempotent and silent on missing dir. */
export function removeModelInstall(): void {
	const flavour = getWhisperFlavour();
	const modelDir = getModelDir(flavour);
	rmSync(modelDir, { recursive: true, force: true });
}

export async function ensureModelDownloaded(onProgress: ProgressCallback, signal?: AbortSignal): Promise<ModelPaths> {
	if (isModelDownloaded()) return getModelPaths();

	const flavour = getWhisperFlavour();
	const modelDir = getModelDir(flavour);

	mkdirSync(modelDir, { recursive: true });
	const archiveName = `sherpa-onnx-whisper-${flavour}.tar.bz2`;
	const archivePath = join(modelDir, archiveName);
	const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${MODEL_RELEASE_TAG}/${archiveName}`;

	// Any failure between mkdir and writeSentinel leaves a half-populated
	// directory (partial archive, partially-extracted .onnx, etc.) but no
	// sentinel — so the next run would re-enter this function and overwrite,
	// but only after wasting bandwidth. Wiping the dir on failure makes that
	// redownload start from a clean slate and prevents a hypothetical
	// race where another caller observes the partial state mid-run.
	try {
		onProgress({ phase: "downloading", message: msgDownloading(flavour) });
		try {
			let lastEmitMs = 0;
			await downloadArchive(url, archivePath, signal, (stats) => {
				const now = Date.now();
				const isFinal = stats.totalBytes !== undefined && stats.bytesReceived >= stats.totalBytes;
				if (!isFinal && now - lastEmitMs < PROGRESS_THROTTLE_MS) return;
				lastEmitMs = now;
				const percent =
					stats.totalBytes && stats.totalBytes > 0
						? Math.min(100, Math.floor((stats.bytesReceived / stats.totalBytes) * 100))
						: undefined;
				onProgress({
					phase: "downloading",
					message: msgDownloading(flavour),
					percent,
					bytesReceived: stats.bytesReceived,
					totalBytes: stats.totalBytes,
				});
			});
		} catch (err) {
			throw new ModelInstallError("download", err);
		}

		onProgress({ phase: "extracting", message: msgExtracting() });
		try {
			await extractArchive(archivePath, modelDir);
			rmSync(archivePath, { force: true });
			pruneFp32Duplicates(flavour, modelDir);
		} catch (err) {
			throw new ModelInstallError("extract", err);
		}

		onProgress({ phase: "verifying", message: msgVerifying() });
		try {
			verifyModelFiles(flavour, modelDir);
		} catch (err) {
			throw new ModelInstallError("verify", err);
		}

		writeSentinel(modelDir);
		return getModelPaths();
	} catch (err) {
		removeModelInstall();
		throw err;
	}
}

// ── Internals ────────────────────────────────────────────────────────────────

interface DownloadStats {
	bytesReceived: number;
	totalBytes?: number;
}

async function downloadArchive(
	url: string,
	destPath: string,
	signal: AbortSignal | undefined,
	onStats?: (stats: DownloadStats) => void,
): Promise<void> {
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) {
		throw new Error(`Model download failed: HTTP ${response.status}`);
	}

	// Servers occasionally omit `Content-Length` for chunked / proxied
	// responses; downstream we treat undefined as "unknown total" and the
	// splash falls back to a byte-counter without a percentage.
	const totalBytes = parsePositiveInt(response.headers.get("content-length"));

	let bytesReceived = 0;
	const tap = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			bytesReceived += chunk.length;
			onStats?.({ bytesReceived, totalBytes });
			cb(null, chunk);
		},
	});

	const out = createWriteStream(destPath);
	await pipeline(Readable.fromWeb(response.body as never), tap, out, { signal });
}

const DECIMAL_RADIX = 10;

function parsePositiveInt(raw: string | null | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number.parseInt(raw, DECIMAL_RADIX);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
	await execFileAsync(TAR_BIN, [...TAR_FLAGS, archivePath, "-C", destDir, TAR_STRIP_FLAG]);
}

// The Whisper archive ships fp32 + int8 side-by-side (~290 MB of fp32 we
// don't use on CPU). Drop them so the install settles around ~157 MB.
function pruneFp32Duplicates(flavour: string, modelDir: string): void {
	const fp32Files = [`${flavour}-encoder.onnx`, `${flavour}-decoder.onnx`];
	for (const name of fp32Files) {
		rmSync(join(modelDir, name), { force: true });
	}
}

function verifyModelFiles(flavour: string, modelDir: string): void {
	const requiredFiles = [`${flavour}-encoder.int8.onnx`, `${flavour}-decoder.int8.onnx`, `${flavour}-tokens.txt`];
	for (const name of requiredFiles) {
		if (!existsSync(join(modelDir, name))) {
			throw new Error(`Model verification failed: missing ${name}`);
		}
	}
}

function writeSentinel(modelDir: string): void {
	writeFileSync(join(modelDir, SENTINEL_FILE), "", "utf-8");
}
