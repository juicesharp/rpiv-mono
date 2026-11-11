import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RecordingStatus } from "../../state/state.ts";
import type { StatefulView } from "../stateful-view.ts";

const COLOR_ACCENT = "accent";
const COLOR_DIM = "dim";

// Vertical gradient: parse the theme's `accent` truecolor SGR and scale each
// channel per ring outward from the centerline. Falls back to Pi's discrete
// shade keys when the accent isn't truecolor (256/8-color themes, test mocks).
const GRADIENT_BRIGHTNESS = [1.0, 0.65, 0.4, 0.22] as const;
const SHADE_FALLBACK = ["accent", "borderAccent", "muted", "dim"] as const;
const ANSI_FG_RESET = "\x1b[39m";
const TRUECOLOR_FG_REGEX = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;

// Vertical lattice geometry. Amp counts rings outward from CENTER_ROW so
// every bar is mirror-symmetric (amp=1 lights only the centerline, amp=MAX
// fills the whole column).
const HALF_SPAN = 3;
const CENTER_ROW = HALF_SPAN;
const ROW_COUNT = HALF_SPAN * 2 + 1;
const MAX_AMP = HALF_SPAN + 1;

// Bars sit on even column indices; odd columns are mandatory spacing so
// adjacent strokes never visually merge.
const BAR_GLYPH = "█";
const SPACE_GLYPH = " ";
const BAR_STRIDE = 2;

// fBm noise drives the silhouette pattern. Three octaves at decreasing
// spatial scale + decorrelated time drift give an organic, non-periodic
// waveform that still clusters smoothly (adjacent bars share a trend).
const NOISE_OCTAVES = [
	{ spacing: 10, weight: 0.55, drift: 0.04, seed: 13.7 },
	{ spacing: 5, weight: 0.3, drift: 0.07, seed: 29.3 },
	{ spacing: 2.5, weight: 0.15, drift: 0.11, seed: 47.1 },
] as const;

// Standard fract(sin) shader hash. Multiplier and offset are arbitrary but
// well-tested for irrational-looking distribution.
const HASH_FREQ = 12.9898;
const HASH_AMP = 43758.5453;

// Mild over-gain on noise so constructive peaks saturate the quantizer at
// MAX_AMP — keeps the top of the lattice in use without flattening every
// cluster into a mesa.
const NOISE_PEAK_GAIN = 1.15;

// Perceptual mapping from RMS to display gain. sqrt(level * 15) saturates
// around level≈0.067 so normal speaking volume reaches full bars without
// projecting.
const PERCEPTUAL_GAIN = 15;

// Single-pole smoother on the live RMS — ~1 s natural decay to blank during
// silences, fast enough that onsets still punch through.
const SMOOTHING = 0.3;

// Blended Hann window: 0.5·rc² + 0.5·rc⁵. The rc² term keeps shoulders broad
// (smooth taper through every amp bucket); the rc⁵ term sharpens the centre
// tip (few slots reach MAX_AMP). Produces a parabolic bell silhouette.
function bellEnvelope(t: number): number {
	const rc = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
	const rc2 = rc * rc;
	const rc5 = rc2 * rc2 * rc;
	return 0.5 * rc2 + 0.5 * rc5;
}

export interface EqualizerViewProps {
	level: number;
	status: RecordingStatus;
	enabled: boolean;
}

export class EqualizerView implements StatefulView<EqualizerViewProps> {
	private props: EqualizerViewProps = { level: 0, status: "recording", enabled: false };
	private envelope: Float64Array = new Float64Array(0);
	private currentBarCount = 0;
	private phase = 0;
	private pendingTicks = 0;
	private smoothedLevel = 0;
	private gradient: readonly string[] | null = null;
	private gradientResolved = false;

	constructor(private readonly theme: Theme) {}

	setProps(props: EqualizerViewProps): void {
		if (props.enabled && props.status === "recording") {
			this.smoothedLevel = (1 - SMOOTHING) * this.smoothedLevel + SMOOTHING * props.level;
			this.pendingTicks += 1;
		}
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.props.enabled) return [];
		if (width <= 0) return new Array<string>(ROW_COUNT).fill("");

		const nBars = Math.ceil(width / BAR_STRIDE);
		if (this.currentBarCount !== nBars) {
			this.envelope = new Float64Array(nBars);
			for (let i = 0; i < nBars; i++) {
				const t = nBars === 1 ? 0.5 : i / (nBars - 1);
				this.envelope[i] = bellEnvelope(t);
			}
			this.currentBarCount = nBars;
		}

		this.phase += this.pendingTicks;
		this.pendingTicks = 0;

		// smoothedLevel only advances while recording, so freezing it during
		// pause naturally preserves the last bar heights.
		const audioGain = Math.min(1, Math.sqrt(this.smoothedLevel * PERCEPTUAL_GAIN));
		// Fold the noise lookup around the centerline so slot i and its mirror
		// see identical noise — silhouette stays centred every frame.
		const center = (nBars - 1) / 2;
		const amps = new Uint8Array(nBars);
		for (let i = 0; i < nBars; i++) {
			const shape = fbmShape(Math.abs(i - center), this.phase);
			amps[i] = quantize(shape * this.envelope[i]! * audioGain);
		}

		this.ensureGradient();
		const recording = this.props.status === "recording";
		const out: string[] = new Array(ROW_COUNT);
		for (let r = 0; r < ROW_COUNT; r++) {
			let raw = "";
			for (let c = 0; c < width; c++) {
				if (c % BAR_STRIDE !== 0) {
					raw += SPACE_GLYPH;
					continue;
				}
				raw += rowLit(amps[c / BAR_STRIDE]!, r) ? BAR_GLYPH : SPACE_GLYPH;
			}
			out[r] = this.paintRow(raw, r, recording);
		}
		return out;
	}

	private ensureGradient(): void {
		if (this.gradientResolved) return;
		this.gradientResolved = true;
		const themeWithAnsi = this.theme as { getFgAnsi?: (key: string) => string };
		if (typeof themeWithAnsi.getFgAnsi !== "function") return;
		const accentAnsi = themeWithAnsi.getFgAnsi(COLOR_ACCENT);
		const match = accentAnsi.match(TRUECOLOR_FG_REGEX);
		if (!match) return;
		const r = Number(match[1]);
		const g = Number(match[2]);
		const b = Number(match[3]);
		this.gradient = GRADIENT_BRIGHTNESS.map((factor) => rgbAnsi(r * factor, g * factor, b * factor));
	}

	private paintRow(raw: string, row: number, recording: boolean): string {
		if (!recording) return this.theme.fg(COLOR_DIM, raw);
		const dist = Math.abs(row - CENTER_ROW);
		if (this.gradient) {
			const idx = Math.min(dist, this.gradient.length - 1);
			return `${this.gradient[idx]}${raw}${ANSI_FG_RESET}`;
		}
		const fallbackIdx = Math.min(dist, SHADE_FALLBACK.length - 1);
		return this.theme.fg(SHADE_FALLBACK[fallbackIdx]!, raw);
	}
}

function valueNoise(x: number, seed: number): number {
	const xi = Math.floor(x);
	const xf = x - xi;
	const u = xf * xf * (3 - 2 * xf);
	const a = valueHash(xi, seed);
	const b = valueHash(xi + 1, seed);
	return a + (b - a) * u;
}

function valueHash(x: number, seed: number): number {
	const v = Math.sin(x * HASH_FREQ + seed) * HASH_AMP;
	return v - Math.floor(v);
}

function fbmShape(i: number, phase: number): number {
	let sum = 0;
	for (const o of NOISE_OCTAVES) {
		sum += valueNoise(i / o.spacing + phase * o.drift, o.seed) * o.weight;
	}
	return sum * NOISE_PEAK_GAIN;
}

function rgbAnsi(r: number, g: number, b: number): string {
	return `\x1b[38;2;${clamp8(r)};${clamp8(g)};${clamp8(b)}m`;
}

function clamp8(v: number): number {
	const rounded = Math.round(v);
	return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

function rowLit(amp: number, row: number): boolean {
	if (amp <= 0) return false;
	return Math.abs(row - CENTER_ROW) < amp;
}

function quantize(level: number): number {
	const idx = Math.round(level * MAX_AMP);
	return idx < 0 ? 0 : idx > MAX_AMP ? MAX_AMP : idx;
}
