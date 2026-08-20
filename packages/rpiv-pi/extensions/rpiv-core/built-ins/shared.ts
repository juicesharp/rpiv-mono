import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { type Artifact, handleToString, type Output, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { StagePreflightError } from "@juicesharp/rpiv-workflow/runner";

/**
 * A plan's structured `phases:` frontmatter array — the machine-readable phase
 * enumeration a plan-producing skill (`blueprint`, `plan`) derives from its
 * `## Phase N:` body headings — is what drives `implement` fanout. The
 * convention lives here; rpiv-workflow knows nothing about phases.
 *
 * Cap: a plan declaring more than 32 phases throws. The rpiv-pi planning skills
 * cap around 8 phases in practice; 32 leaves headroom for stretch plans without
 * letting a pathological (or hostile) plan drive an unbounded fanout loop.
 */
const MAX_PHASES = 32;

/**
 * One parsed entry of a plan's `phases:` array. `entry` carries the whole raw
 * frontmatter object, so a consumer can read fields beyond `{ n, title }`
 * without this parser knowing about them.
 */
interface PhaseRecord {
	entry: Record<string, unknown>;
	/** From `entry.n`, falling back to the 1-based array position. */
	n: number;
	/** From `entry.title`, or "" when absent. */
	title: string;
	/** 0-based position in the array. */
	index: number;
	/** Total phases in this plan. */
	total: number;
}

/** Read an artifact file, resolving a workflow-relative path against `cwd`. */
const readArtifactFile = (path: string, cwd: string): string =>
	readFileSync(isAbsolute(path) ? path : join(cwd, path), "utf-8");

/** Build the halting `StagePreflightError` shape every phase fanout/iterate guard `throw`s. */
const haltPreflight = (who: string, summary: string, detail: string): StagePreflightError =>
	new StagePreflightError("halt", who, summary, detail, true);

/** Latest `fs`-handle artifact most recently published under `name` (undefined if none). */
const latestFsArtifact = (state: RunView, name: string): Artifact | undefined =>
	state.named[name]?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");

/**
 * An `Artifact` narrowed to its `fs`-handle variant — the plan-path-carrying
 * shape the scope checks key the verdict path + `artifact` field off. Annotates
 * a captured artifact ACROSS loop iterations so the `if (a.handle.kind !== "fs")
 * continue` guard's narrowing carries to the post-loop `latest.handle.path` read
 * (the file's idiom — `designPathsBySlice` reads `.path` inside its own
 * same-scope guard; this loop captures the artifact across iterations, so the
 * narrowed type annotates the capture).
 */
type FsArtifact = Artifact & { handle: { kind: "fs"; path: string } };

/** The verdict directory the deterministic checks and the LLM grade panel share. */
const VERDICT_DIR = ".rpiv/artifacts/verdicts";
/** Binary verdict score: a clean pass. The gate keys off `severity`, never this number. */
const VERDICT_PASS_SCORE = 100;
/** Binary verdict score: at least one finding. The gate keys off `severity`, never this number. */
const VERDICT_FAIL_SCORE = 0;

/**
 * A `path:line` (or `path:line-line`) citation in an artifact's prose. Requires a
 * dotted extension so timestamps (`17:13:27`), ratios, and bare `Slice 2:` labels
 * never match — only file references with a real extension are verified.
 *
 * A citation may START with a single dot (`.github/workflows/ci.yml:12`,
 * `.eslintrc.js:3`) — without it, dot-dirs and dotfiles were captured with the
 * dot stripped and guaranteed to fail the floor as a mangled path. The leading
 * dot is taken only when the preceding char is not a word char or another dot
 * (`(?<![\w.])`), and a dotless start only at a word boundary (`(?<!\w)`), so a
 * prose ellipsis (`...packages/x.ts:5`) still yields `packages/x.ts`, never
 * `...packages/x.ts`.
 */
const FILE_LINE_CITATION_RE = /((?:(?<![\w.])\.)?(?<!\w)[\w][\w./-]*\.[a-zA-Z][a-zA-Z0-9]{0,4}):(\d+)(?:-(\d+))?/g;

/** A structure-dimension finding — the shared shape the deterministic verdict
 * checks emit (`detail` is the actionable message, `where` locates the defect).
 * `advisory: true` marks a finding that must be RECORDED but never BLOCK a gate
 * (citation ambiguity/drift — resolver limitations, not fabrication signal);
 * absent means blocking. */
type StructureFinding = { detail: string; where: string; advisory?: true };

/** An `fs` artifact handle (the only handle kind the verdict checks operate on). */
type FsHandle = { kind: "fs"; path: string };

/**
 * Write the shared `{ dimension: "structure" }` verdict and publish it on an fs
 * artifact. The three deterministic structure checks (`sliceStructureCheck`,
 * `subplanCoverageCheck`, `planCitationCheck`) all emit the SAME verdict shape
 * and basename-keyed JSON write, so it lives here once. `who` is the channel
 * prefix folded into the basename (so a re-run OVERWRITES its own slot —
 * idempotent across fix/reslice/re-dispatch rounds); `handle` is the artifact
 * the check inspected (serialized into `data.artifact` and basename-keyed).
 *
 * The severity tier is load-bearing: the gate routes via
 * `allDimensionsPass`/`subplanGatePasses`, whose severity floor silently passes
 * a `pass:false` verdict rated `low`/`none`. Any BLOCKING finding rates the
 * verdict `high` (a structural defect MUST rate `high` or it ships); a verdict
 * whose findings are ALL `advisory` rates `low` — honest (`pass: false`, the
 * findings persist on the trail and downstream readers see them) but
 * deliberately below the gate floor, so a resolver limitation never terminates
 * a loop-less preset. The `score` is the binary verdict scale (100 = clean,
 * 0 = finding; the gate keys off `severity`, never this number).
 *
 * `extra` lets a caller stamp additional gate-readable fields onto the verdict
 * data (and the persisted JSON, so the trail records them) — currently only
 * `sliceStructureCheck`'s `citeDischarged` stamp.
 */
const writeStructureVerdict = (
	who: string,
	handle: FsHandle,
	findings: StructureFinding[],
	cwd: string,
	extra?: Record<string, unknown>,
): Omit<Output, "meta"> => {
	const pass = findings.length === 0;
	const blocking = findings.some((f) => f.advisory !== true);
	const data = {
		dimension: "structure",
		pass,
		score: pass ? VERDICT_PASS_SCORE : VERDICT_FAIL_SCORE,
		severity: pass ? "none" : blocking ? "high" : "low",
		artifact: handleToString(handle),
		findings,
		feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
		...extra,
	};
	const rel = join(VERDICT_DIR, `${who}__${basename(handle.path, ".md")}.json`);
	mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify(data, null, 2), "utf-8");
	return { kind: "json", artifacts: [{ handle: { kind: "fs", path: rel } }], data };
};

/**
 * The reconcile write-restriction's static allowlist — a conservative test-path
 * classifier. A directive may apply its `find → replace` ONLY to a co-located test
 * file (`*.test.{ts,tsx,js,jsx}`); any other target is flagged and left untouched
 * (fail-closed: golden masters, fixtures, `*.t.ts`, and production sources are NOT
 * auto-applied). Narrow by design — do not widen it to compensate for a weak
 * directive (correctness rests on this neither false-failing a legit test edit
 * nor false-allowing a non-test target).
 */
const TEST_PATH_RE = /\.test\.[tj]sx?$/;

/**
 * Resolve `target` against `cwd` and require the result to stay INSIDE `cwd`.
 * Returns the resolved absolute path, or `undefined` when the target escapes
 * (an absolute path outside `cwd`, or `..` traversal — `resolve` collapses the
 * dot segments, `relative` exposes an escape as a leading `..` or a different
 * root). The guard runs on the SAME resolved string the fs sinks operate on,
 * so a suffix/charset check on the raw directive or citation text can never be
 * bypassed by an absolute target or a mid-path `..`.
 */
const containedPath = (cwd: string, target: string): string | undefined => {
	const abs = resolve(cwd, target);
	const rel = relative(cwd, abs);
	return rel.startsWith("..") || isAbsolute(rel) ? undefined : abs;
};

export type { FsArtifact, PhaseRecord, StructureFinding };
export {
	containedPath,
	FILE_LINE_CITATION_RE,
	haltPreflight,
	latestFsArtifact,
	MAX_PHASES,
	readArtifactFile,
	TEST_PATH_RE,
	VERDICT_DIR,
	VERDICT_FAIL_SCORE,
	VERDICT_PASS_SCORE,
	writeStructureVerdict,
};
