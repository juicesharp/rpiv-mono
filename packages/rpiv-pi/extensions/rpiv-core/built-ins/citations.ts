/**
 * The deterministic file:line citation verifier: resolves every `file:line`
 * citation in an artifact body against the working tree, with basename-index
 * suffix fallback and tiebreaks. Findings are advisory; blocking severity on
 * the shared structure verdict comes only from the plan coverage floor.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { fencedSpans } from "./markdown-fence.js";
import { containedPath, FILE_LINE_CITATION_RE, type StructureFinding } from "./shared.js";

/**
 * Verify every `file:line` citation in `body` resolves against the working tree:
 * the cited file must exist AND carry at least the cited line (a range's high end).
 * A path that misses direct (repo-root/absolute) resolution falls back to the
 * tree file whose path ends with it on whole segments — bare basenames and
 * package-relative forms both back the citation iff exactly ONE tree file
 * matches; an ambiguous suffix stays unresolved (the finding names the
 * candidates so the fix arm can disambiguate) unless one of two tiebreaks names
 * a single candidate: the caller's declared-`files:` union, then the nearest
 * preceding prose mention of a candidate's full path. A bare `path` with no
 * `:line` is not checked (the contract is "verifiable line numbers, or omit
 * them"). Returns one finding per bad citation.
 *
 * EVERY finding this verifier emits is ADVISORY (`StructureFinding.advisory`):
 * an advisory-only structure verdict rates `low`, which the gates'
 * `allDimensionsPass` severity floor rides through, so citation-resolution
 * findings are recorded on the trail — and handed to the ship grade panel via
 * `--cite-check` for symbol-level adjudication — but never stop a run. Blocking
 * severity on the shared structure
 * verdict comes ONLY from `verifyPhaseFilesCoverage` (an undeclared write
 * corrupts dep derivation — that floor stays load-bearing).
 */
/** Trees a citation must never resolve INTO — vendored deps, build copies, or
 * prior pipeline artifacts (a stale artifact copy would back a fabricated line).
 * `.rpiv` is skipped with one carve-out: the walk re-enters `.rpiv/guidance`
 * (see `buildBasenameIndex`) — the guidance shadow tree is a legitimate,
 * routinely-cited and routinely-edited target, and skipping it made every
 * suffix-form `architecture.md` citation a false "does not exist". */
const CITATION_WALK_SKIP: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "coverage", ".rpiv"]);
/** Backstop so a pathological tree can't stall the deterministic cite floor. */
const CITATION_WALK_FILE_CAP = 50_000;

/** The lazily-built basename → absolute-path(s) index backing the suffix
 *  fallback in `resolveCitationPath`. `truncated` marks a partial walk past
 *  `CITATION_WALK_FILE_CAP`, which disables the fallback (uniqueness
 *  untrustworthy). */
type BasenameIndex = { index: Map<string, string[]>; truncated: boolean };

/**
 * Index every source file's basename → its absolute path(s) under `cwd` — the
 * candidate pool behind the suffix fallback in `verifyCitations`. The generative
 * producers (slice/synthesize/elaborate) routinely cite a file by bare basename
 * (`built-in-workflows.ts:1431`) or by a package-relative suffix
 * (`validate/stage-rules.ts:70` for `packages/rpiv-workflow/validate/stage-rules.ts`)
 * — mechanical path-prefix omissions, not fabricated references. The basename
 * keys the candidates; `verifyCitations` narrows them by whole-segment suffix.
 * A UNIQUE match backs the citation; an AMBIGUOUS one stays unresolved — unless
 * one of `verifyCitations`' tiebreaks (the caller's declared-`files:` union,
 * then the nearest preceding prose mention) names exactly one
 * candidate — so the producer must disambiguate with the repo-root-relative
 * path. Skips
 * vendored/generated trees so a citation never resolves to a build copy or a
 * prior artifact. Bounded by the file cap.
 */
const buildBasenameIndex = (cwd: string): BasenameIndex => {
	// Unreadable dir → empty listing, never a throw from the deterministic floor.
	const listDir = (dir: string) => {
		try {
			return readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
	};
	const index = new Map<string, string[]>();
	const stack: string[] = [cwd];
	let seen = 0;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const e of listDir(dir)) {
			if (e.isDirectory()) {
				if (!CITATION_WALK_SKIP.has(e.name)) stack.push(join(dir, e.name));
				// The guidance carve-out — see CITATION_WALK_SKIP's note. A missing
				// guidance dir degrades to an empty listing.
				else if (e.name === ".rpiv") stack.push(join(dir, e.name, "guidance"));
				continue;
			}
			if (!e.isFile()) continue;
			// Past the cap the index is INCOMPLETE, so "exactly one match" can no
			// longer be trusted — mark it truncated and let the caller disable the
			// fallback (strict direct-resolution only) rather than back a possibly
			// wrong file off a partial walk.
			if (++seen > CITATION_WALK_FILE_CAP) return { index, truncated: true };
			const abs = join(dir, e.name);
			const arr = index.get(e.name);
			if (arr) arr.push(abs);
			else index.set(e.name, [abs]);
		}
	}
	return { index, truncated: false };
};

/** Outcome of resolving a single citation's `path` against `cwd`. `abs` is the
 *  one backing file when resolution is unique; `ambiguous` carries the candidate
 *  list (absolute paths) when more than one tree file matches, so the caller can
 *  render the disambiguation finding text. `undefined` ⇒ no match
 *  (does-not-exist). This is the minimal-deviation return shape — a plain
 *  `string | undefined` would drop the candidate list the disambiguation finding
 *  text depends on. */
type CitationResolution = { abs: string } | { ambiguous: string[] };

/** Strategy 4 of `resolveCitationPath`: tree files whose REPO-RELATIVE path ends
 *  with the cited `path` on WHOLE segments. A bare basename is the one-segment
 *  case; a multi-segment citation narrows the basename's candidates at a `/`
 *  boundary, so `workflow/validate/x.ts` can never match inside
 *  `rpiv-workflow/validate/x.ts`. Compared repo-relative (never against the
 *  absolute path) so the checkout directory's own name can never back a citation
 *  — `src/utils.ts` must not resolve to `<cwd>/utils.ts` just because the repo
 *  happens to be cloned at `/tmp/src`. Reads/writes the shared `indexHolder` so
 *  the basename index is built lazily ONCE and shared across citations (the
 *  first direct-resolution miss pays the tree walk). */
const suffixMatchesFor = (path: string, cwd: string, indexHolder: { value: BasenameIndex | undefined }): string[] => {
	indexHolder.value ??= buildBasenameIndex(cwd);
	if (indexHolder.value.truncated) return []; // partial index ⇒ uniqueness untrustworthy ⇒ strict
	const candidates = indexHolder.value.index.get(basename(path)) ?? [];
	if (!path.includes("/")) return candidates;
	const suffix = `/${path}`;
	return candidates.filter((abs) =>
		`/${abs
			.slice(cwd.length + 1)
			.split(sep)
			.join("/")}`.endsWith(suffix),
	);
};

/** Resolve a citation's `path` to one backing file under `cwd`, encapsulating
 *  all four strategies in order: (1) direct — `path` or `cwd/path`; (2,3)
 *  dependency probes — `node_modules/<path>` and `node_modules/@<path>` (the
 *  latter because the citation regex cannot carry `@`, so a cited
 *  `node_modules/@scope/pkg/f.js` parses as `scope/pkg/f.js`); DIRECT probes
 *  only — the suffix walk still skips `node_modules` (per `CITATION_WALK_SKIP`),
 *  so a bare basename never resolves into a dep; (4) suffix fallback — a UNIQUE
 *  tree-file suffix match backs the citation, an AMBIGUOUS one returns the
 *  candidate list. PURE: emits no findings and throws never — all finding text
 *  lives in `verifyCitations`. The lazily-built basename index is shared across
 *  calls via `indexHolder`. */
const resolveCitationPath = (
	path: string,
	cwd: string,
	indexHolder: { value: BasenameIndex | undefined },
): CitationResolution | undefined => {
	// existsSync-then-statSync races a concurrent delete into a throw OUT of the
	// deterministic floor (⇒ FAIL_SCRIPT_THREW) — one guarded probe instead.
	const isTreeFile = (p: string): boolean => {
		try {
			return statSync(p).isFile();
		} catch {
			return false;
		}
	};
	// Strategy 1 — direct. Containment-guarded (`containedPath`): a `..`-escaping
	// citation must not resolve to a file OUTSIDE the tree — an existing out-of-cwd
	// target would read as a BACKED citation (and leak its line count into the
	// verdict). An escaping path falls through to the suffix fallback and lands as
	// an ordinary unbacked/ambiguous finding.
	const direct = containedPath(cwd, path);
	if (direct !== undefined && isTreeFile(direct)) return { abs: direct };
	// Strategies 2 & 3 — dependency probes (lockfile-pinned dep source; the regex
	// cannot carry `@`, so `node_modules/@scope/pkg/f.js` is cited as `scope/pkg/f.js`).
	for (const candidate of [join("node_modules", path), join("node_modules", `@${path}`)]) {
		const abs = containedPath(cwd, candidate);
		if (abs !== undefined && isTreeFile(abs)) return { abs };
	}
	// Strategy 4 — suffix fallback: back the citation iff exactly ONE tree file matches.
	const matches = suffixMatchesFor(path, cwd, indexHolder);
	if (matches.length === 1) return { abs: matches[0] };
	if (matches.length > 1) return { ambiguous: matches };
	return undefined;
};

/** Example-path namespaces the skill prompts use in illustrative citations
 *  (`path/to/file.ext:12`, `packages/x/y.ts:42`). Artifacts quote — and models
 *  imitate — these examples in unfenced prose, where the fence skip cannot
 *  reach them; a citation under one of these prefixes is documentation shape,
 *  never a claim about the tree, and prosecuting one buys a full LLM fix round
 *  for zero risk averted (three of f329's floor failures were this class). */
const PLACEHOLDER_CITATION_PREFIXES: readonly string[] = ["path/to/", "packages/x/"];

/**
 * Proximity tiebreak for a citation left ambiguous by the declared-`files:`
 * intersection: resolve to the candidate whose repo-root-relative path has the
 * nearest PRECEDING prose mention — the common artifact idiom of naming a file
 * once in full, then citing it by bare basename. Prose only: mentions inside
 * YAML frontmatter (`files:` ordering carries no authorial intent — a tie there
 * stays a tie) or fenced spans (example/fixture territory) don't count, and
 * matches are token-bounded so a candidate never back-matches inside a longer
 * path mention (`a/dup.ts` inside `x/a/dup.ts`). Returns the winner's absolute
 * path, or `undefined` — the citation then stays unbacked as before.
 */
const nearestProseMention = (
	body: string,
	upTo: number,
	candidates: readonly string[],
	cwd: string,
	fenced: readonly [number, number][],
	proseStart: number,
): string | undefined => {
	let bestAbs: string | undefined;
	let bestIdx = -1;
	for (const abs of candidates) {
		if (!abs.startsWith(cwd + sep)) continue;
		const rel = abs
			.slice(cwd.length + 1)
			.split(sep)
			.join("/");
		// Walk mentions nearest-first; the first CLEAN one (token-bounded, in
		// prose, outside fences) is this candidate's best — earlier ones can't win.
		let from = upTo - rel.length;
		while (from >= 0) {
			const i = body.lastIndexOf(rel, from);
			if (i < 0 || i < proseStart) break;
			from = i - 1;
			const prev = i > 0 ? (body[i - 1] as string) : "";
			const next = body[i + rel.length] ?? "";
			if (prev !== "" && /[\w.@/-]/.test(prev)) continue;
			if (next !== "" && /[\w-]/.test(next)) continue;
			if (fenced.some(([s, e]) => i >= s && i < e)) continue;
			if (i > bestIdx) {
				bestIdx = i;
				bestAbs = abs;
			}
			break;
		}
	}
	return bestAbs;
};

const verifyCitations = (body: string, cwd: string, declared?: ReadonlySet<string>): StructureFinding[] => {
	const findings: StructureFinding[] = [];
	const seen = new Set<string>();
	// Fenced text is example/fixture territory, not prose asserting a real
	// file:line — a fenced placeholder shaped like a citation must not fail the
	// floor (it false-failed the very plan that fixes this). Span check, not a
	// placeholder-pattern skip: a REAL citation that merely looks placeholder-ish
	// still verifies when it appears in prose.
	const fenced = fencedSpans(body);
	// Prose begins past the YAML frontmatter: the proximity tiebreak must not
	// read the `files:` array as a mention (its ordering carries no intent — a
	// tie inside the declared set stays a tie).
	let proseStart = 0;
	if (body.startsWith("---\n")) {
		const end = body.indexOf("\n---\n", 3);
		if (end !== -1) proseStart = end + "\n---\n".length;
	}
	// Built lazily and reused across citations — only the first direct-resolution
	// miss pays the tree walk, and only when at least one such citation exists.
	const indexHolder: { value: BasenameIndex | undefined } = { value: undefined };
	for (const m of body.matchAll(FILE_LINE_CITATION_RE)) {
		const [, path, startStr, endStr] = m;
		if (!path || !startStr) continue;
		if (fenced.some(([s, e]) => m.index >= s && m.index < e)) continue;
		if (PLACEHOLDER_CITATION_PREFIXES.some((p) => path.startsWith(p))) continue;
		const key = `${path}:${startStr}${endStr ? `-${endStr}` : ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		let resolved = resolveCitationPath(path, cwd, indexHolder);
		if (resolved && "ambiguous" in resolved && declared !== undefined) {
			// Declared-write-set tiebreak: when the caller supplies the artifact's own
			// declared `files:` union and exactly ONE ambiguous candidate is in it, the
			// artifact has already named the file it means — resolve there instead of
			// halting the run over a path-prefix omission. A tie INSIDE the declared
			// set (two declared `command.ts` files) stays ambiguous: the citation is
			// then genuinely unreadable even against the artifact's own write-set.
			const declaredMatches = resolved.ambiguous.filter(
				(abs) =>
					abs.startsWith(cwd + sep) &&
					declared.has(
						abs
							.slice(cwd.length + 1)
							.split(sep)
							.join("/"),
					),
			);
			if (declaredMatches.length === 1) resolved = { abs: declaredMatches[0] };
		}
		if (resolved && "ambiguous" in resolved) {
			// Proximity tiebreak: the nearest preceding prose mention of a
			// candidate's full path names the file the author means.
			const near = nearestProseMention(body, m.index, resolved.ambiguous, cwd, fenced, proseStart);
			if (near !== undefined) resolved = { abs: near };
		}
		if (resolved && "ambiguous" in resolved) {
			// More than one tree file matches — name the candidates so the fix arm can disambiguate.
			const shown = resolved.ambiguous
				.slice(0, 3)
				.map((a) => (a.startsWith(cwd + sep) ? a.slice(cwd.length + 1) : a));
			findings.push({
				detail: `Unbacked citation ${key} — ${path} matches ${resolved.ambiguous.length} tree files (${shown.join(", ")}${resolved.ambiguous.length > shown.length ? ", …" : ""}); a citation must name ONE file. Disambiguate with the repo-root-relative path.`,
				where: key,
				// Every candidate is a REAL tree file — advisory per the tier above.
				advisory: true,
			});
			continue;
		}
		let abs = resolved?.abs;
		if (abs === undefined && declared !== undefined) {
			// Declared-write-set rescue on a NO-MATCH resolution — the ambiguity
			// tiebreak's missing twin. A unique whole-segment suffix match inside
			// the plan's own `files:` names the file the author means: verify
			// against it when it exists on disk; a declared file ABSENT from the
			// tree is a planned CREATE — the citation is a forward reference to
			// planned content, unverifiable at this revision, so no finding.
			const matches = [...declared].filter((d) => d === path || `/${d}`.endsWith(`/${path}`));
			if (matches.length === 1) {
				const cand = join(cwd, matches[0]);
				if (!existsSync(cand)) continue;
				abs = cand;
			}
		}
		if (!abs) {
			findings.push({
				detail: `Unbacked citation ${key} — the cited file does not exist at this revision. A file:line citation must resolve, or the line numbers must be omitted. Fix the path (repo-root-relative, or node_modules/<pkg>/… for an installed dependency file) or drop the citation.`,
				where: key,
				// Advisory like every citation-resolution finding — see the tier
				// note in the function header.
				advisory: true,
			});
			continue;
		}
		// A file that vanishes or turns unreadable between resolution and the read
		// is an unbacked citation, never a throw out of the deterministic floor.
		let lineCount: number;
		try {
			lineCount = readFileSync(abs, "utf-8").split("\n").length;
		} catch {
			findings.push({
				detail: `Unbacked citation ${key} — ${path} resolved but could not be read at this revision. A file:line citation must be verifiable, or the line numbers must be omitted. Fix the path (repo-root-relative) or drop the citation.`,
				where: key,
				// The file EXISTS (it resolved) — advisory per the tier above.
				advisory: true,
			});
			continue;
		}
		const high = Math.max(Number(startStr), endStr ? Number(endStr) : 0);
		if (high > lineCount) {
			findings.push({
				detail: `Unbacked citation ${key} — ${path} has ${lineCount} lines, so line ${high} matches no version of the file. A file:line citation must be verifiable, or the line numbers must be omitted. Correct the range or drop the line numbers.`,
				where: key,
				// The file exists; only the ordinate drifted — advisory per the tier above.
				advisory: true,
			});
		}
	}
	return findings;
};

export { verifyCitations };
