import { createMockCommandCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acts, defineWorkflow, produces } from "./api.js";
import { registerBuiltInsProvider } from "./built-ins.js";

// Mock runner to avoid needing the full Pi session runtime. The resume path
// delegates to resumeWorkflowByRunId (which owns resolve → load-gate → find →
// resumeWorkflow); its internals are covered in runner/by-run-id.test.ts.
vi.mock("./runner/index.js", () => ({
	runWorkflow: vi.fn(async () => ({ stagesCompleted: 2, success: true })),
	resumeWorkflowByRunId: vi.fn(async () => ({ runId: "r", stagesCompleted: 1, success: true })),
}));

// Mock load.ts to avoid jiti + filesystem I/O. The mock provides a stable
// LoadedWorkflows shape every test reuses; per-test overrides via mockReturnValueOnce.
const tinyWorkflow = defineWorkflow({
	name: "tiny",
	start: "research",
	stages: { research: produces(), commit: acts() },
	edges: { research: "commit", commit: "stop" },
});
const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	stages: {
		research: produces(),
		implement: acts(),
		commit: acts(),
	},
	edges: { research: "implement", implement: "commit", commit: "stop" },
});
const reviewWorkflow = defineWorkflow({
	name: "review",
	start: "code-review",
	stages: { "code-review": produces(), commit: acts() },
	edges: { "code-review": "commit", commit: "stop" },
});

vi.mock("./load/index.js", () => ({
	loadWorkflows: vi.fn(async () => ({
		workflows: [tinyWorkflow, midWorkflow, reviewWorkflow],
		default: "mid",
		workflowSources: new Map([
			["tiny", "built-in"],
			["mid", "built-in"],
			["review", "built-in"],
		]),
		layers: ["built-in"],
		issues: [],
		skillAliases: {},
		skillContracts: new Map(),
	})),
	findWorkflow: vi.fn((loaded: { workflows: { name: string }[] }, name: string) =>
		loaded.workflows.find((w) => w.name === name),
	),
}));

import {
	FLAG_EXTRACTORS,
	MSG_RUNTIME_LOADING,
	makeWfHandler,
	PREWARM_DELAY_MS,
	parseArgs,
	registerWorkflowCommand,
} from "./command.js";
import { loadWorkflows } from "./load/index.js";
import { resumeWorkflowByRunId, runWorkflow } from "./runner/index.js";

beforeEach(() => {
	vi.mocked(runWorkflow).mockReset();
	vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 2, success: true });
	vi.mocked(resumeWorkflowByRunId).mockReset();
	vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ runId: "r", stagesCompleted: 1, success: true });
});

// ---------------------------------------------------------------------------
// parseArgs — pure helper
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};

	it("parses a leading --max-jumps <n> on a run and threads it as maxBackwardJumps", () => {
		expect(parseArgs("--max-jumps 6 mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			maxBackwardJumps: 6,
		});
	});

	it("parses a trailing --max-jumps <n> on a resume", () => {
		expect(parseArgs("@2026-09-05_10-01-29-cc02 --max-jumps 6", built)).toEqual({
			kind: "resume",
			ref: "2026-09-05_10-01-29-cc02",
			maxBackwardJumps: 6,
		});
	});

	it("leaves a mid-position --max-jumps in the input text", () => {
		expect(parseArgs("mid fix the --max-jumps 6 handling", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "fix the --max-jumps 6 handling",
		});
	});

	it("parses workflow name + input", () => {
		expect(parseArgs("mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
		});
	});

	it("defaults to the default workflow when no name is recognized", () => {
		expect(parseArgs("Add dark mode", built)).toEqual({ kind: "run", workflow: "mid", input: "Add dark mode" });
	});

	it("a workflow-name-only token is a preview of that workflow (nothing to run)", () => {
		expect(parseArgs("review", built)).toStrictEqual({ kind: "preview", workflow: "review" });
	});

	it("handles empty string — a preview with no workflow (the listing)", () => {
		expect(parseArgs("", built)).toStrictEqual({ kind: "preview" });
	});

	it("handles whitespace-only string — the listing", () => {
		expect(parseArgs("   ", built)).toStrictEqual({ kind: "preview" });
	});

	// The preview decision is made on the flag-stripped residual. The old
	// handler re-tested the RAW line against the workflow names, so any flag
	// beside a bare workflow token fell through to the generic listing.
	it("a bare workflow token beside caps flags previews that workflow, flags carried", () => {
		expect(parseArgs("--max-jumps 6 --max-jumps 9 tiny", built)).toStrictEqual({
			kind: "preview",
			workflow: "tiny",
			maxBackwardJumps: 6,
			duplicateFlags: ["--max-jumps"],
		});
		expect(parseArgs("tiny --max-laps 8", built)).toStrictEqual({ kind: "preview", workflow: "tiny", maxLaps: 8 });
	});

	it("flags alone are the listing, flags carried", () => {
		expect(parseArgs("--max-jumps 6", built)).toStrictEqual({ kind: "preview", maxBackwardJumps: 6 });
		expect(parseArgs("--name x", built)).toStrictEqual({ kind: "preview", name: "x" });
	});

	it("a bare DEFAULT workflow token previews it too (explicit token, not the default fallback)", () => {
		expect(parseArgs("--max-jumps 6 mid", built)).toStrictEqual({
			kind: "preview",
			workflow: "mid",
			maxBackwardJumps: 6,
		});
	});

	it("uses custom default when no workflow name is recognized", () => {
		const customConfig = {
			workflowNames: new Set(["my-flow"]),
			default: "my-flow",
		};
		expect(parseArgs("Add feature", customConfig)).toEqual({
			kind: "run",
			workflow: "my-flow",
			input: "Add feature",
		});
	});

	it("extracts a LEADING --name and strips it from the input", () => {
		expect(parseArgs("--name auth-spike mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			name: "auth-spike",
		});
	});

	it("leaves a MID-INPUT --name in the prompt text untouched and flags it", () => {
		// `/wf mid fix the --name handling bug` — the flag tokens are the user's
		// own prompt text; silently claiming "handling" as a run name would
		// corrupt the input seed.
		expect(parseArgs("mid fix the --name handling bug", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "fix the --name handling bug",
			name: undefined,
			nameFlagIgnored: true,
		});
	});

	it("extracts --name when bound to the default workflow", () => {
		expect(parseArgs("Add dark mode --name spike", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			name: "spike",
		});
	});

	it("extracts --name on a workflow-name-only invocation (a preview of that workflow)", () => {
		expect(parseArgs("review --name r1", built)).toStrictEqual({
			kind: "preview",
			workflow: "review",
			name: "r1",
		});
	});

	it("leaves name absent when --name is not supplied", () => {
		expect(parseArgs("mid go", built)).toEqual({ kind: "run", workflow: "mid", input: "go" });
	});
});

// ---------------------------------------------------------------------------
// parseArgs — caps flags (--max-jumps / --max-laps) permutation pins. The
// extraction is a fixpoint (each pass: leading form of every not-yet-
// extracted flag, else its trailing form, until a pass extracts nothing), so
// the two caps + --name parse in ANY relative leading/trailing order — the
// old fixed jumps-then-name sequence silently stranded one caps flag in
// same-slot permutations.
// ---------------------------------------------------------------------------

describe("parseArgs — caps flag permutations", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};

	it("parses --max-laps leading before --max-jumps and --name (the same-slot permutation)", () => {
		expect(parseArgs("--max-laps 8 --max-jumps 6 --name x mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			name: "x",
			maxBackwardJumps: 6,
			maxLaps: 8,
		});
	});

	it("parses the trailing mirror — --name, --max-jumps, --max-laps all trailing", () => {
		expect(parseArgs("mid Add dark mode --name x --max-jumps 6 --max-laps 8", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			name: "x",
			maxBackwardJumps: 6,
			maxLaps: 8,
		});
	});

	it("parses trailing-only caps in both relative orders", () => {
		expect(parseArgs("Add dark mode --max-laps 8 --max-jumps 6", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			maxBackwardJumps: 6,
			maxLaps: 8,
		});
		expect(parseArgs("Add dark mode --max-jumps 6 --max-laps 8", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			maxBackwardJumps: 6,
			maxLaps: 8,
		});
	});

	it("parses a leading --max-laps on a run (the --max-jumps twin)", () => {
		expect(parseArgs("--max-laps 8 mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			maxLaps: 8,
		});
	});

	it("parses both caps on the @resume arm (trailing pair after the ref)", () => {
		expect(parseArgs("@2026-09-05_10-01-29-cc02 --max-laps 8 --max-jumps 6", built)).toEqual({
			kind: "resume",
			ref: "2026-09-05_10-01-29-cc02",
			maxBackwardJumps: 6,
			maxLaps: 8,
		});
	});

	it("leaves a mid-position --max-laps in the input text (silent, like --max-jumps)", () => {
		expect(parseArgs("mid fix the --max-laps 8 handling", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "fix the --max-laps 8 handling",
		});
	});

	it("a doubled --name across caps extraction: first wins, the repeat is stripped and reported (not left as input)", () => {
		expect(parseArgs("--name a mid go --name b --max-laps 8", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "go",
			name: "a",
			maxLaps: 8,
			duplicateFlags: ["--name"],
		});
	});

	// Doubled caps flags. Before the duplicate rule, pass 1 stripped the first
	// `--max-jumps 6` and the `extracted` set skipped the second, leaving
	// `--max-jumps 9 research fix X` as the residual: `--max-jumps` is not a
	// workflow name, so the WHOLE line — the user's intended workflow token
	// included — bound as prompt input to the DEFAULT workflow. Now the repeat
	// is consumed (first wins) and surfaced for the command layer to warn on.
	it("a doubled leading --max-jumps resolves the user's workflow, not the default (the hijack)", () => {
		expect(parseArgs("--max-jumps 6 --max-jumps 9 tiny fix X", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			maxBackwardJumps: 6,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("a doubled leading --max-laps resolves the same way", () => {
		expect(parseArgs("--max-laps 6 --max-laps 9 tiny fix X", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			maxLaps: 6,
			duplicateFlags: ["--max-laps"],
		});
	});

	it("a doubled trailing caps flag keeps the FIRST-TYPED value (the end-peel is corrected for)", () => {
		// Trailing extraction peels from the END — `9` is extracted first — but
		// the inner `6` was typed first, so it wins; `9` is the repeat.
		expect(parseArgs("tiny fix X --max-jumps 6 --max-jumps 9", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			maxBackwardJumps: 6,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("a tripled trailing caps flag keeps the first-typed value", () => {
		expect(parseArgs("tiny fix X --max-jumps 1 --max-jumps 2 --max-jumps 3", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			maxBackwardJumps: 1,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("a trailing double interleaved with another trailing flag still keeps the first-typed value", () => {
		expect(parseArgs("tiny fix X --max-jumps 9 --name a --max-jumps 6", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			name: "a",
			maxBackwardJumps: 9,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("a doubled trailing --name (the tail run) keeps the first-typed name, strips the repeat, sets no mid-input flag", () => {
		expect(parseArgs("mid go --name a --name b", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "go",
			name: "a",
			duplicateFlags: ["--name"],
		});
	});

	it("a doubled trailing caps flag on the @resume arm keeps the first-typed value", () => {
		expect(parseArgs("@2026-09-05_10-01-29-cc02 --max-laps 4 --max-laps 9", built)).toEqual({
			kind: "resume",
			ref: "2026-09-05_10-01-29-cc02",
			maxLaps: 4,
			duplicateFlags: ["--max-laps"],
		});
	});

	it("a leading + trailing pair of the same caps flag: leading wins, trailing is the repeat", () => {
		expect(parseArgs("--max-jumps 6 tiny fix X --max-jumps 9", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			maxBackwardJumps: 6,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("both caps doubled report both tokens, each once, in flag-table order", () => {
		expect(parseArgs("--max-jumps 6 --max-laps 8 --max-jumps 7 --max-laps 9 tiny fix X", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			maxBackwardJumps: 6,
			maxLaps: 8,
			duplicateFlags: ["--max-jumps", "--max-laps"],
		});
	});

	it("a tripled caps flag reports its token once", () => {
		expect(parseArgs("--max-jumps 1 --max-jumps 2 --max-jumps 3 tiny fix X", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X",
			maxBackwardJumps: 1,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("a doubled caps flag on the @resume arm strips the repeat before the ref is read", () => {
		expect(parseArgs("--max-jumps 6 --max-jumps 9 @2026-09-05_10-01-29-cc02", built)).toEqual({
			kind: "resume",
			ref: "2026-09-05_10-01-29-cc02",
			maxBackwardJumps: 6,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("a repeat WITHOUT a numeric value matches no form and stays as input text (no duplicate reported)", () => {
		expect(parseArgs("--max-jumps 6 tiny fix X --max-jumps", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "fix X --max-jumps",
			maxBackwardJumps: 6,
		});
	});

	// The head-flag shapes: a flag whose leading occurrence is masked by a
	// LATER-row flag at the head of the line is extracted trailing first, and
	// its earlier-typed leading occurrence only surfaces in pass 2. A slot
	// heuristic ("overwrite on trailing-after-trailing") kept the later-typed
	// value here; ranking by typed offset keeps the first.
	it("a head --max-laps masking a leading --max-jumps: the earlier-typed leading value still wins", () => {
		expect(parseArgs("--max-laps 8 --max-jumps 6 tiny go --max-jumps 7", built)).toEqual({
			kind: "run",
			workflow: "tiny",
			input: "go",
			maxBackwardJumps: 6,
			maxLaps: 8,
			duplicateFlags: ["--max-jumps"],
		});
	});

	it("a head --max-jumps masking a leading --name: the earlier-typed name wins (it is the one claimed on disk)", () => {
		expect(parseArgs("--max-jumps 6 --name x mid go --name y", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "go",
			name: "x",
			maxBackwardJumps: 6,
			duplicateFlags: ["--name"],
		});
	});

	it("keeps absent caps keys absent when only --name is supplied (toStrictEqual — absent, not present-undefined)", () => {
		expect(parseArgs("--name auth mid go", built)).toStrictEqual({
			kind: "run",
			workflow: "mid",
			input: "go",
			name: "auth",
		});
	});

	it("keeps an absent --name / droppedName ABSENT on both arms (one key-presence convention)", () => {
		expect(parseArgs("mid go", built)).toStrictEqual({ kind: "run", workflow: "mid", input: "go" });
		expect(parseArgs("@2026-06-03_07-30-00-ab12", built)).toStrictEqual({
			kind: "resume",
			ref: "2026-06-03_07-30-00-ab12",
		});
	});
});

// ---------------------------------------------------------------------------
// parseArgs — exhaustive leading/trailing permutation property. Three review
// rounds each found the next unpinned duplicate cell of the extractor; hand
// pins close one cell at a time. This enumerates EVERY sequence of 1..4 flag
// tokens over the three keys and every split of it into a leading run and a
// trailing run around a fixed body, and checks each parse against a plain
// reference model: the kept value is the first-typed occurrence, the input
// is the body untouched, and `duplicateFlags` names exactly the repeated
// keys in flag-table order. Leading and trailing tokens are all peelable
// by the fixpoint (any relative order), so the model is exact over this
// grammar — a mid-position token is outside it by design.
// ---------------------------------------------------------------------------

describe("parseArgs — every leading/trailing permutation keeps the first-typed value", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};
	// Grammar derived from the extractor table itself — a fourth flag row
	// enters the enumeration without a lockstep edit here.
	type Key = (typeof FLAG_EXTRACTORS)[number]["key"];
	const KEYS: readonly Key[] = FLAG_EXTRACTORS.map((f) => f.key);
	const TOKEN = Object.fromEntries(FLAG_EXTRACTORS.map((f) => [f.key, f.token])) as Record<Key, string>;
	const REF = "2026-06-03_07-30-00-ab12";

	// Both arms: the run body resolves a workflow + input; the @ref body is
	// the resume sigil, where a name is carried as `droppedName` (the command
	// layer warns it is ignored) and the caps thread through unchanged. The
	// same flag arrangements are enumerated around each body so the resume
	// arm's masked-head cells are covered structurally, not by hand pins.
	const BODIES = [
		{ label: "run", text: "tiny fix the thing", base: { kind: "run", workflow: "tiny", input: "fix the thing" } },
		{ label: "resume", text: `@${REF}`, base: { kind: "resume", ref: REF } },
	] as const;

	/** Every sequence of `n` keys (with repetition). */
	const sequences = (n: number): Key[][] =>
		n === 0 ? [[]] : sequences(n - 1).flatMap((prefix) => KEYS.map((k) => [...prefix, k]));

	/** `--name n3` for names, `--max-jumps 3` for caps — the ordinal doubles as the typed value. */
	const render = (key: Key, ordinal: number) => `${TOKEN[key]} ${key === "name" ? `n${ordinal}` : ordinal}`;

	const cases: { line: string; expected: Record<string, unknown> }[] = [];
	for (const body of BODIES) {
		for (let n = 1; n <= 4; n++) {
			for (const seq of sequences(n)) {
				for (let split = 0; split <= n; split++) {
					const tokens = seq.map((key, i) => ({ key, ordinal: i + 1, text: render(key, i + 1) }));
					const leading = tokens.slice(0, split).map((t) => t.text);
					const trailing = tokens.slice(split).map((t) => t.text);
					const line = [...leading, body.text, ...trailing].join(" ");

					const expected: Record<string, unknown> = { ...body.base };
					const seen = new Set<Key>();
					const repeated = new Set<Key>();
					for (const t of tokens) {
						if (seen.has(t.key)) {
							repeated.add(t.key);
							continue;
						}
						seen.add(t.key);
						const value = t.key === "name" ? `n${t.ordinal}` : t.ordinal;
						// The resume arm carries the name as `droppedName`, never `name`.
						expected[t.key === "name" && body.label === "resume" ? "droppedName" : t.key] = value;
					}
					// Reported in flag-table order, whatever the typed order.
					const duplicateFlags = KEYS.filter((k) => repeated.has(k)).map((k) => TOKEN[k]);
					if (duplicateFlags.length > 0) expected.duplicateFlags = duplicateFlags;
					cases.push({ line, expected });
				}
			}
		}
	}

	it(`enumerates the grammar (${cases.length} cases)`, () => {
		// Per body: 3 + 9 + 27 + 81 sequences × (n + 1) splits each = 546; two bodies.
		expect(cases).toHaveLength(2 * (3 * 2 + 9 * 3 + 27 * 4 + 81 * 5));
	});

	// Strict: an absent key and a present-undefined key are DIFFERENT shapes
	// here — `toEqual` equates them and could not see a regression either way.
	it.each(cases)("$line", ({ line, expected }) => {
		expect(parseArgs(line, built)).toStrictEqual(expected);
	});
});

// ---------------------------------------------------------------------------
// FLAG_EXTRACTORS — the anchor invariant the typed-offset ranking relies on.
// ---------------------------------------------------------------------------

describe("FLAG_EXTRACTORS — anchor invariant", () => {
	it.each(FLAG_EXTRACTORS.map((f) => [f.token, f] as const))(
		"%s: leading is ^-anchored, trailing is \\s+-prefixed and $-anchored",
		(_token, f) => {
			expect(f.leading.source.startsWith("^")).toBe(true);
			expect(f.trailing.source.startsWith("\\s+")).toBe(true);
			expect(f.trailing.source.endsWith("$")).toBe(true);
			// Neither form is global/sticky — `exec` must be stateless across passes.
			expect(f.leading.flags).toBe("");
			expect(f.trailing.flags).toBe("");
		},
	);

	it("keys and tokens are unique", () => {
		expect(new Set(FLAG_EXTRACTORS.map((f) => f.key)).size).toBe(FLAG_EXTRACTORS.length);
		expect(new Set(FLAG_EXTRACTORS.map((f) => f.token)).size).toBe(FLAG_EXTRACTORS.length);
	});
});

// ---------------------------------------------------------------------------
// parseArgs — resume sigil
// ---------------------------------------------------------------------------

describe("parseArgs — resume (@ref)", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};

	it("parses @ref as resume kind", () => {
		expect(parseArgs("@2026-06-03_07-30-00-ab12", built)).toEqual({
			kind: "resume",
			ref: "2026-06-03_07-30-00-ab12",
		});
	});

	it("parses @ alone as resume with empty ref", () => {
		expect(parseArgs("@", built)).toEqual({ kind: "resume", ref: "" });
	});

	it("extracts only the first token after @ (ignores trailing tokens)", () => {
		expect(parseArgs("@run-id extra stuff", built)).toEqual({ kind: "resume", ref: "run-id" });
	});

	it("@ with whitespace-only trailing content returns empty ref", () => {
		expect(parseArgs("@   ", built)).toEqual({ kind: "resume", ref: "" });
	});

	it("tolerates a space after the sigil (@ ref === @ref)", () => {
		expect(parseArgs("@ run-id", built)).toEqual({ kind: "resume", ref: "run-id" });
	});

	it("carries a --name supplied with @resume as droppedName (resolved later as ignored)", () => {
		expect(parseArgs("@run-id --name x", built)).toEqual({
			kind: "resume",
			ref: "run-id",
			droppedName: "x",
		});
	});
});

// ---------------------------------------------------------------------------
// /wf handler shape + dispatch
// ---------------------------------------------------------------------------

describe("/wf — command shape", () => {
	it('registers under "wf"', () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		expect(captured.commands.has("wf")).toBe(true);
	});
});

describe("/wf — !hasUI", () => {
	it("notifies an error and exits without calling runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: false });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — no input", () => {
	it("shows the workflow listing when no input is provided", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — valid invocation", () => {
	it("calls runWorkflow with the resolved workflow object", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid Add dark mode", ctx);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.workflow.name).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
	});

	it("falls back to default workflow when first token is unknown", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("Add dark mode", ctx);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.workflow.name).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
	});

	it("bare workflow-name token shows that workflow's detail view (not the full list)", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("review", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("workflow: review"), "info");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("whitespace-only input shows the full workflow list", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("   ", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("a bare workflow token beside a flag shows THAT workflow's details, not the generic list", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("--max-jumps 6 review", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("workflow: review"), "info");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("a bare workflow token with a trailing --name shows its details (the name is a run-time concern)", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("review --name r1", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("workflow: review"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("flags alone show the full list", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("--max-jumps 6", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("an invalid --name still refuses on a preview (unchanged from the run path)", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("review --name 1bad", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("invalid name"), "error");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("workflow: review"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — --name flag", () => {
	it("rejects an invalid --name before calling runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid go --name 1bad", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("invalid name"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("threads a valid trailing --name through to runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid go --name auth", ctx);
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]?.name).toBe("auth");
	});

	it("warns on a mid-input --name and keeps it in the workflow input", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid fix the --name handling bug", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("first or last token"), "warning");
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]?.name).toBeUndefined();
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]?.input).toBe("fix the --name handling bug");
	});

	it("surfaces a pre-flight collision rejection (success:false, no runId)", async () => {
		vi.mocked(runWorkflow).mockResolvedValueOnce({
			stagesCompleted: 0,
			success: false,
			error: "name 'auth' already used by run r0",
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid --name auth go", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already used"), "error");
	});

	it("warns that --name is ignored on @resume and still resumes", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@run-id --name x", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("--name has no effect"), "warning");
		expect(resumeWorkflowByRunId).toHaveBeenCalledWith(ctx, "run-id", expect.anything());
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Runtime memoization — Pi's jiti loader runs with moduleCache:false, so an
// unmemoized import() re-evaluates the whole command-run graph (~0.9s UI
// freeze) on every /wf. The handler closure memoizes the import promise.
// ---------------------------------------------------------------------------

describe("/wf — command-run import memoization", () => {
	it("runs the importer once across invocations", async () => {
		const importer = vi.fn(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await handler("mid first", createMockCommandCtx({ hasUI: true }));
		await handler("mid second", createMockCommandCtx({ hasUI: true }));
		expect(importer).toHaveBeenCalledTimes(1);
		expect(runWorkflow).toHaveBeenCalledTimes(2);
	});

	it("shows the cold-path loading toast on the first invocation only", async () => {
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi);
		const cold = createMockCommandCtx({ hasUI: true });
		await handler("mid go", cold);
		expect(cold.ui.notify).toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		const warm = createMockCommandCtx({ hasUI: true });
		await handler("mid again", warm);
		expect(warm.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
	});

	it("suppresses the loading toast when !hasUI", async () => {
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi);
		const ctx = createMockCommandCtx({ hasUI: false });
		await handler("mid go", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
	});

	it("clears the memo on import rejection so the next /wf retries", async () => {
		const importer = vi
			.fn<() => Promise<typeof import("./command-run.js")>>()
			.mockRejectedValueOnce(new Error("transient import failure"))
			.mockImplementation(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await expect(handler("mid go", createMockCommandCtx({ hasUI: true }))).rejects.toThrow(
			"transient import failure",
		);
		await handler("mid go", createMockCommandCtx({ hasUI: true }));
		expect(importer).toHaveBeenCalledTimes(2);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Pre-warm — registerWorkflowCommand schedules the memoized import shortly
// after registration so the first real /wf finds the graph ready. A failed
// pre-warm clears the memo (degrades to the pre-warm-less behavior).
// ---------------------------------------------------------------------------

describe("/wf — pre-warm", () => {
	it("prewarm() shares the memo: a later /wf shows no toast and reuses the import", async () => {
		const importer = vi.fn(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await handler.prewarm();
		const ctx = createMockCommandCtx({ hasUI: true });
		await handler("mid go", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		expect(importer).toHaveBeenCalledTimes(1);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});

	it("shows the toast when /wf arrives while the pre-warm is still in flight", async () => {
		let release!: (mod: typeof import("./command-run.js")) => void;
		const gate = new Promise<typeof import("./command-run.js")>((resolve) => {
			release = resolve;
		});
		const importer = vi.fn(() => gate);
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		const warming = handler.prewarm();
		const ctx = createMockCommandCtx({ hasUI: true });
		const invocation = handler("mid go", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		release(await import("./command-run.js"));
		await Promise.all([warming, invocation]);
		expect(importer).toHaveBeenCalledTimes(1);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});

	it("a failed prewarm() clears the memo — the next /wf retries the import", async () => {
		const importer = vi
			.fn<() => Promise<typeof import("./command-run.js")>>()
			.mockRejectedValueOnce(new Error("prewarm boom"))
			.mockImplementation(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await expect(handler.prewarm()).rejects.toThrow("prewarm boom");
		const ctx = createMockCommandCtx({ hasUI: true });
		await handler("mid go", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		expect(importer).toHaveBeenCalledTimes(2);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});

	it("prewarm() flushes lazy built-in providers ahead of the first /wf", async () => {
		const provider = vi.fn();
		registerBuiltInsProvider(provider);
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi);
		await handler.prewarm();
		expect(provider).toHaveBeenCalledTimes(1);
	});

	it("registerWorkflowCommand pre-warms after PREWARM_DELAY_MS — first /wf shows no toast", async () => {
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			registerWorkflowCommand(pi);
			await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
			const ctx = createMockCommandCtx({ hasUI: true });
			await captured.commands.get("wf")?.handler("mid go", ctx);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
			expect(runWorkflow).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Issue surfacing — load + validation errors
// ---------------------------------------------------------------------------

describe("/wf — issue surfacing", () => {
	it("surfaces validation warnings as 'warning' notifies", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [tinyWorkflow],
			default: "tiny",
			workflowSources: new Map([["tiny", "built-in"]]),
			layers: ["built-in"],
			issues: [
				{
					kind: "validation",
					workflow: "tiny",
					stage: "research",
					severity: "warning",
					code: "stage-unreachable",
					params: { start: "research" },
					message: "orphan check",
					layer: "built-in",
				},
			],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("tiny Add feature", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("orphan check"), "warning");
	});

	it("aborts on load errors — runWorkflow is not invoked", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [tinyWorkflow],
			default: "tiny",
			workflowSources: new Map([["tiny", "built-in"]]),
			layers: ["built-in"],
			issues: [{ kind: "load", layer: "project", path: "rpiv.config.ts", severity: "error", message: "broke" }],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("tiny Add feature", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("config error"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Empty registry — standalone rpiv-workflow install (no rpiv-pi, no overlays).
// The loader used to return `default: "mid"` even with zero workflows; the
// dispatch then either silently went into a not-found notify or, worse,
// looked up "mid" in an empty map. Now: `default: undefined` and the command
// emits an explicit "no workflows registered" notify.
// ---------------------------------------------------------------------------

describe("/wf — empty registry", () => {
	it("emits MSG_NO_WORKFLOWS_REGISTERED when user provides input but no workflows are loaded", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [],
			default: undefined,
			workflowSources: new Map(),
			layers: [],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("Add dark mode", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no workflows registered"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("no-args still shows the (empty) workflow listing instead of erroring", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [],
			default: undefined,
			workflowSources: new Map(),
			layers: [],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("parseArgs — empty registry", () => {
	it('returns workflow="" when no default is set and the first token doesn\'t match a workflow', () => {
		const empty = { workflowNames: new Set<string>(), default: undefined };
		expect(parseArgs("Add feature", empty)).toEqual({ kind: "run", workflow: "", input: "Add feature" });
		expect(parseArgs("", empty)).toStrictEqual({ kind: "preview" });
	});
});

// ---------------------------------------------------------------------------
// /wf @<ref> — resume dispatch
// ---------------------------------------------------------------------------

const RESUME_RUN_ID = "2026-06-03_07-30-00-ab12";

describe("/wf @<run-id> — guard: empty run-id", () => {
	it("notifies usage message and does not call resumeWorkflowByRunId", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("usage"), "error");
		expect(resumeWorkflowByRunId).not.toHaveBeenCalled();
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<run-id> — delegates to resumeWorkflowByRunId", () => {
	it("strips the @ sigil and forwards the run-id + host", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(resumeWorkflowByRunId).toHaveBeenCalledTimes(1);
		const [, runId, opts] = vi.mocked(resumeWorkflowByRunId).mock.calls[0]!;
		expect(runId).toBe(RESUME_RUN_ID);
		expect(opts?.host).toBe(pi);
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<run-id> — notify discriminator (runId presence)", () => {
	it("notifies a no-JSONL refusal (no runId on the envelope) exactly once", async () => {
		vi.mocked(resumeWorkflowByRunId).mockResolvedValueOnce({
			stagesCompleted: 0,
			success: false,
			error: 'rpiv: no run found for "gone"',
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@gone", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no run found"), "error");
	});

	it("does NOT re-notify an in-run failure (envelope carries a runId — machinery already notified)", async () => {
		vi.mocked(resumeWorkflowByRunId).mockResolvedValueOnce({
			runId: RESUME_RUN_ID,
			stagesCompleted: 1,
			success: false,
			error: "stage build failed",
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("stage build failed"), "error");
	});

	it("does not notify on success", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.anything(), "error");
	});
});

describe("/wf @<run-id> — hard throw", () => {
	it("catches a thrown resumeWorkflowByRunId and notifies the generic failure", async () => {
		vi.mocked(resumeWorkflowByRunId).mockRejectedValueOnce(new Error("boom"));
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("boom"), "error");
	});
});
