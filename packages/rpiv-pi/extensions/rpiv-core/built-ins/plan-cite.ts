/**
 * The plan citation/coverage floor: verifies every `file:line` citation in the
 * latest plan resolves and that each phase body's edit paths are declared in
 * its frontmatter `files:`.
 */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Output, ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { verifyCitations } from "./citations.js";
import { forEachLineOutsideFences } from "./markdown-fence.js";
import { PLAN_PHASE_RE, phaseFiles } from "./plan-phases.js";
import { haltPreflight, latestFsArtifact, readArtifactFile, writeStructureVerdict } from "./shared.js";

/**
 * Slice a plan body into per-phase text keyed by phase number, splitting on
 * `## Phase N:` headings OUTSIDE fenced code blocks (a heading inside a ``` or
 * ~~~ fence is example/fixture text, not a structural phase boundary — mirrors
 * `countHeadingsOutsideFences` so the slice and the derive-check agree). The
 * body for phase N runs from its heading line up to (not including) the next
 * out-of-fence `## Phase M:` heading, or end-of-text for the last phase.
 * Returns a `Map<number, string>` (phase n → body text, heading included).
 */
const phaseBodySlices = (content: string): Map<number, string> => {
	const lineRe = new RegExp(PLAN_PHASE_RE.source); // drop g/m; per-line test, lastIndex can't drift
	const lines = content.split("\n");
	const openings: { n: number; start: number }[] = [];
	forEachLineOutsideFences(content, (line, i) => {
		const m = lineRe.exec(line);
		if (m?.[1]) openings.push({ n: Number(m[1]), start: i });
	});
	const slices = new Map<number, string>();
	for (let idx = 0; idx < openings.length; idx++) {
		const end = idx + 1 < openings.length ? openings[idx + 1].start : lines.length;
		slices.set(openings[idx].n, lines.slice(openings[idx].start, end).join("\n"));
	}
	return slices;
};

/** Strip a trailing `:line` or `:line-line` citation suffix from a path token. */
const stripLineSuffix = (p: string): string => p.replace(/:\d+(?:-\d+)?$/, "");

/** Well-known extensionless filenames — the extension heuristic below would drop
 *  them, so an undeclared write to one would silently escape the coverage floor.
 *  Recognized bare or as the basename of a path. */
const EXTENSIONLESS_FILENAME_RE =
	/^(?:Makefile|Dockerfile|Rakefile|Gemfile|Justfile|Procfile|LICENSE|NOTICE|CODEOWNERS)$/;

/** Path-like test mirroring slice-overlap.mjs's `looksLikePath`, applied AFTER
 *  stripping a `:line` suffix (the blueprint MODIFY heading — `#### N. path/to/file.ext`
 *  with a `:12-30` range appended — carries a line range the bare form rejects).
 *  Extensionless recognition is allowlist-only (never "any `/`-bearing token"):
 *  prose like `and/or` must not read as a declared write. The extension is
 *  bounded to 1–5 chars starting with a letter (mirroring FILE_LINE_CITATION_RE)
 *  so a dotted IDENTIFIER (`deps.finalize` — an observed false coverage
 *  finding) never reads as a file. */
const isPathLike = (s: string): boolean => {
	if (/\s/.test(s)) return false;
	if (EXTENSIONLESS_FILENAME_RE.test(s.slice(s.lastIndexOf("/") + 1))) return true;
	return /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(s) && (s.includes("/") || /^[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(s));
};

/**
 * Extract the edit paths a phase body names, across the three artifact
 * conventions the plan/blueprint/synthesize skills emit, OUTSIDE fenced code
 * blocks (a path inside a ``` fence is a code reference, not a declared write —
 * post-`code-splice` safety, since code-splice folds elaborations' fenced code
 * into the plan and those fenced paths must NOT read as phase writes):
 *   • `**File**:` / `**Files**:` — plan/blueprint's per-change file line
 *     (a backticked comma-list under `**Files**:`, or a single path under `**File**:`).
 *   • `#### N. path/to/file.ext` — blueprint's change subsection heading
 *     (may carry a `:line`-range suffix on MODIFY entries — stripped).
 *   • `- `path/to/file.ts`` — synthesize's backticked-path list item under
 *     `### Changes` (the form `elaborate`/`synthesize` emit).
 * Strips a trailing `:line`/`:line-line` suffix. Mirrors slice-overlap.mjs's
 * `filesOf` + `looksLikePath` and extends them with the synthesize list-item
 * form. Returns a de-duplicated `string[]`.
 */
const editPathsOfPhase = (phaseBody: string): string[] => {
	const files = new Set<string>();
	const add = (raw: string) => {
		const stripped = stripLineSuffix(raw.replace(/[`*]/g, "").trim());
		if (stripped && isPathLike(stripped)) files.add(stripped);
	};
	// The list-item form is scoped to a Changes section (`### Changes` heading or
	// a `**Changes**:` field line): a backticked bullet elsewhere in the body is
	// a REFERENCE ("mirror `x/state.ts`"), not a declared write — unscoped, those
	// read as coverage gaps and block. Any other heading or `**Field**:` label
	// exits the scope; `**File(s)**:` lines don't flip it (they're the path form
	// themselves and legitimately precede `**Changes**:`).
	let inChanges = false;
	forEachLineOutsideFences(phaseBody, (line) => {
		const heading = line.match(/^#{2,5}\s+(.*)$/);
		if (heading) inChanges = /^changes\b/i.test(heading[1].trim());
		const fm = line.match(/^\*\*Files?\*\*:\s*(.+)$/);
		if (fm) {
			for (const tok of fm[1].split(/[,\s]+/)) add(tok);
			return;
		}
		const label = line.match(/^\*\*([A-Za-z][A-Za-z ]*)\*\*:/);
		if (label?.[1]) inChanges = /^changes$/i.test(label[1].trim());
		const hm = line.match(/^#{3,4}\s+\d+\.\s+(\S+)/);
		if (hm) {
			add(hm[1]);
			return;
		}
		const lm = line.match(/^-\s+`([^`]+)`/);
		if (lm && inChanges) add(lm[1]);
	});
	return [...files];
};

/**
 * Deterministic plan-time coverage floor: every edit path a phase body NAMES
 * (in `### Changes`/`#### N. path`/`**File**:`) must be DECLARED in that phase's
 * frontmatter `files:` array. An undeclared write is the per-phase attribution
 * gap the dep-gated implement fanout and the lane-level scope floor both need
 * closed upstream — a body edit not in `files:` is invisible to dependency
 * derivation and unattributable under concurrency. PURE: no LLM judgment, never
 * throws (a malformed frontmatter degrades to `[]`). A `files:`-LESS phase
 * (absent key) yields NO findings — empty-set degradation so a legacy/
 * `files:`-less plan never false-fails; a phase that declares `files: []` is
 * checked (every body edit is a gap). Folded into `planCitationCheck(who)` so
 * both the `plan-cite-check` and `code-cite-check` arms emit coverage findings
 * on their shared `dimension: "structure"` verdict — no new stage/channel/route.
 */
const verifyPhaseFilesCoverage = (content: string, who: string, path: string): { detail: string; where: string }[] => {
	let fm: Record<string, unknown>;
	try {
		const { frontmatter } = parseFrontmatter(content);
		fm = frontmatter as Record<string, unknown>;
	} catch {
		return []; // malformed frontmatter → degrade to no findings, never throw
	}
	const phases = Array.isArray(fm.phases) ? fm.phases : [];
	const entryByN = new Map<number, Record<string, unknown>>();
	phases.forEach((entry, idx) => {
		const e = (entry ?? {}) as Record<string, unknown>;
		const n = typeof e.n === "number" ? e.n : idx + 1;
		entryByN.set(n, e);
	});
	const findings: { detail: string; where: string }[] = [];
	for (const [n, body] of phaseBodySlices(content)) {
		const entry = entryByN.get(n);
		if (!entry) continue; // body phase with no matching frontmatter entry — derive-check's concern, not coverage's
		// `files:` key ABSENT → degradation (legacy plan): skip. Present (even `[]`) → check.
		if (!Array.isArray(entry.files)) continue;
		const declared = new Set(phaseFiles(entry));
		for (const editPath of editPathsOfPhase(body)) {
			if (declared.has(editPath)) continue;
			// Whole-segment suffix tolerance: a body form citing the file by bare
			// basename or partial path (`#### 2. config.ts` for a declared
			// `packages/x/config.ts`) is covered by the declaration — exact-match
			// only was fixable solely by polluting `files:` with the bare name,
			// corrupting the very dep derivation this floor protects.
			if ([...declared].some((d) => `/${d}`.endsWith(`/${editPath}`) || `/${editPath}`.endsWith(`/${d}`))) continue;
			findings.push({
				detail: `Phase ${n} names edit path ${editPath} in its body but does not declare it in its frontmatter 'files:' array. Every path a phase creates or edits must be listed in 'files:' (repo-root-relative, never a bare basename) so the plan-time coverage floor and the dep-gated implement fanout see the phase's full write set. Add ${editPath} to phase ${n}'s 'files:' array, or drop the body reference if the write belongs to another phase.`,
				where: `${who} ${path} phase ${n}: ${editPath}`,
			});
		}
	}
	return findings;
};

/**
 * The union of every phase's declared `files:` across the plan's frontmatter —
 * the disambiguation pool `planCitationCheck` hands `verifyCitations`. A plan's
 * write-set is the one place the plan itself names its files repo-root-relative
 * (the coverage floor enforces exactly that), so it is a deterministic
 * tiebreaker for the ambiguous-suffix findings that would otherwise STOP a
 * loop-less preset (ship) over a bare `messages.ts:18` whose owning file the
 * plan already declares. Degrades to the empty set on malformed frontmatter —
 * never throws out of the deterministic floor.
 */
const declaredPlanFiles = (content: string): ReadonlySet<string> => {
	let fm: Record<string, unknown>;
	try {
		fm = parseFrontmatter(content).frontmatter as Record<string, unknown>;
	} catch {
		return new Set();
	}
	const phases = Array.isArray(fm.phases) ? fm.phases : [];
	const declared = new Set<string>();
	for (const entry of phases) for (const f of phaseFiles(entry)) declared.add(f);
	return declared;
};

/**
 * Deterministic citation floor for a synthesized/spliced plan — the plan-scope
 * twin of `sliceStructureCheck`'s citation backing, extending the citation
 * floor past the slice map to the plan and the code-bearing plan (a fabricated `file:line` in
 * the plan misdirects `implement`). Verifies every
 * citation resolves against the working tree and emits a `{ dimension:
 * "structure" }` verdict on `who`'s channel that the gate route folds via
 * `allDimensionsPass`; the matching `<fix>` stage reads `fanin(who)` so the
 * findings DRIVE the amend rather than blind-halt. Reuses `verifyCitations` — no
 * fuzzy wrong-symbol heuristic — threading the plan's declared `files:` union so
 * an ambiguous suffix citation resolves when exactly one candidate is in the
 * plan's own write-set. Basename-keyed ⇒ idempotent across fix rounds.
 */
const planCitationCheck =
	(who: string) =>
	({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
		const latest = latestFsArtifact(state, "plans");
		if (latest?.handle.kind !== "fs") {
			throw haltPreflight(
				who,
				`${who}: no plan to check`,
				`${who}: no fs artifact on the 'plans' channel — the plan must be produced before the citation check`,
			);
		}
		const body = readArtifactFile(latest.handle.path, cwd);
		const findings = verifyCitations(body, cwd, declaredPlanFiles(body));
		// Plan-time coverage floor: a body edit not declared in its phase's `files:`
		// fails structurally, same channel/verdict/route as an unbacked citation.
		findings.push(...verifyPhaseFilesCoverage(body, who, latest.handle.path));
		return writeStructureVerdict(who, latest.handle, findings, cwd);
	};

export { planCitationCheck };
