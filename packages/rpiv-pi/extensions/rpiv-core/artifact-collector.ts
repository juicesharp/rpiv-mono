/**
 * rpiv-flavoured artifact collection — the `.rpiv/artifacts/<bucket>/<file>.md`
 * convention all rpiv-pi skills emit into. This module owns the
 * convention; the framework (`@juicesharp/rpiv-workflow`) ships only
 * the primitives (`ArtifactCollector`, `ArtifactParser`, handle
 * constructors, `defineCollector`, etc.) and stays layout-agnostic.
 *
 * Two collectors:
 *   - `rpivArtifactCollector` — accepts any `.rpiv/artifacts/<bucket>/...md`
 *     path the agent announces in text (bucket-agnostic). Use when a
 *     stage may emit to several sibling subfolders.
 *   - `rpivBucketCollector(bucket)` — accepts only that one bucket's
 *     paths. Use when the stage MUST land in a specific subfolder
 *     (`research`, `plans`, etc.) — the collector halts the chain if the
 *     agent strayed.
 *
 * Both collectors carry a disk-corroborated basename fallback: when the
 * full-path transcript scan misses (agent mangled the directory prefix in
 * prose), a bare `<file>.md` token from the transcript is accepted iff it
 * resolves to exactly one existing file under `.rpiv/artifacts/` — see the
 * fallback section below.
 *
 * One parser: `frontmatterParser` parses YAML frontmatter from the
 * primary fs artifact into `Record<string, unknown>` — what
 * `outputSchema` validates against for typed downstream narrowing.
 *
 * Pre-bundled outcome: `rpivArtifactMdOutcome` =
 * `{ collector: rpivArtifactCollector, parser: frontmatterParser }` —
 * the default rpiv-pi's built-in workflows wire into every
 * `produces()` stage.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type ArtifactCollector,
	type ArtifactParser,
	type BranchEntry,
	defineCollector,
	defineParser,
	fs as fsHandle,
	type Outcome,
	type ParseContext,
	transcriptPathCollector,
	// Runner-free entry — keeps the ~530ms engine off the startup path.
} from "@juicesharp/rpiv-workflow/registration";

// ---------------------------------------------------------------------------
// Collectors — text-scan over assistant transcript
// ---------------------------------------------------------------------------

// A prose ellipsis is a valid `[\w.-]+` string, so an agent's ELIDED reference to
// a sibling artifact ("`.rpiv/artifacts/elaborations/...__phase-4.md`") placed
// after its real announcement used to win the last-match scan and fatal the stage
// on a path that never existed. The tempered class below refuses ".." anywhere in
// a segment — the same hazard `FILE_LINE_CITATION_RE` guards with its
// lookbehinds. Under the documented slug conventions (timestamps, kebab-cased
// topics, "__phase-N" — prompt-enforced, not code-enforced) no legitimate path
// carries consecutive dots; a skill that ever emitted one would fail collection
// LOUDLY (fatal no-match), never silently.
//
// ONE encoding, shared by both collectors — the bucket-narrowed pattern is built
// from the same string so the two can never drift.
const TEMPERED_SEGMENT = String.raw`(?:(?!\.\.)[\w.-])+`;
const RPIV_ARTIFACT_PATTERN = new RegExp(String.raw`\.rpiv/artifacts/${TEMPERED_SEGMENT}/${TEMPERED_SEGMENT}\.md`, "g");

// ---------------------------------------------------------------------------
// Disk-corroborated basename fallback
// ---------------------------------------------------------------------------
//
// Regression: run 2026-08-21_12-15-19-ec5e, code (phase 1/7). The agent wrote
// its elaboration to the correct `.rpiv/artifacts/elaborations/...` path, but
// its final message announced the path as `.elaborations/<file>.md` — the
// directory prefix mangled in prose. The full-path scan missed, the stage
// fataled, and a verified-green 38KB artifact was orphaned: the transcript
// (the report of the work) was the only channel checked, never the filesystem
// (the work itself).
//
// The fallback closes that gap WITHOUT weakening the announcement contract:
// on a full-path miss, scan the transcript for bare `<file>.md` tokens
// (tempered — an elided `...__phase-N.md` still never resolves) and accept a
// candidate ONLY when it names exactly one existing file under
// `.rpiv/artifacts/<bucket>/` (the collector's bucket, or any bucket for the
// agnostic collector). The agent's own announcement still drives collection —
// disk existence corroborates it, so a stray prose mention of `README.md` or
// a sibling's elided path can never be collected. Ambiguity (same basename in
// two buckets) refuses that candidate; no unique resolution → the original
// fatal stands.
const BASENAME_PATTERN = new RegExp(String.raw`${TEMPERED_SEGMENT}\.md`, "g");

/** Bare `<file>.md` tokens from assistant text, last-mentioned first, deduped. */
function basenameCandidates(branch: BranchEntry[], offsetStart?: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = branch.length - 1; i >= start; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j]!;
			if (part.type !== "text" || typeof part.text !== "string") continue;
			const matches = part.text.match(BASENAME_PATTERN) ?? [];
			for (let k = matches.length - 1; k >= 0; k--) {
				const m = matches[k]!;
				if (!seen.has(m)) {
					seen.add(m);
					out.push(m);
				}
			}
		}
	}
	return out;
}

/** Existing `.rpiv/artifacts/<bucket>/<basename>` paths (repo-relative). */
function resolveUnderArtifacts(cwd: string, basename: string, bucket?: string): string[] {
	const root = join(cwd, ".rpiv", "artifacts");
	if (!existsSync(root)) return [];
	const buckets = bucket
		? [bucket]
		: readdirSync(root, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name);
	return buckets.filter((b) => existsSync(join(root, b, basename))).map((b) => `.rpiv/artifacts/${b}/${basename}`);
}

/** Full-path scan first; on miss, the disk-corroborated basename fallback. */
function withDiskFallback(primary: ArtifactCollector, bucket?: string): ArtifactCollector {
	return defineCollector({
		collect: async (ctx) => {
			const scanned = await primary.collect(ctx);
			if (scanned.kind === "ok") return scanned;
			for (const basename of basenameCandidates(ctx.branch, ctx.branchOffset)) {
				const hits = resolveUnderArtifacts(ctx.cwd, basename, bucket);
				if (hits.length === 1) {
					return { kind: "ok", artifacts: [{ handle: fsHandle(hits[0]!), role: "primary" }] };
				}
			}
			return scanned; // the original fatal — no unique on-disk corroboration
		},
	});
}

/** Bucket-agnostic — accepts any `.rpiv/artifacts/<bucket>/...md`. */
export const rpivArtifactCollector: ArtifactCollector = withDiskFallback(
	transcriptPathCollector({ pattern: RPIV_ARTIFACT_PATTERN }),
);

/** Bucket-narrowed — accepts only `.rpiv/artifacts/<bucket>/...md`. The filename
 *  segment is `TEMPERED_SEGMENT`, so an elided prose path never outranks the
 *  real announcement here either. */
export function rpivBucketCollector(bucket: string): ArtifactCollector {
	const escaped = bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(String.raw`\.rpiv/artifacts/${escaped}/${TEMPERED_SEGMENT}\.md`, "g");
	return withDiskFallback(transcriptPathCollector({ pattern }), bucket);
}

// ---------------------------------------------------------------------------
// Parser — markdown frontmatter
// ---------------------------------------------------------------------------

/**
 * Reads YAML frontmatter from the primary fs artifact. Files without
 * frontmatter — or with frontmatter the YAML parser chokes on — produce
 * `data: {}`. Fatals only when the announced path doesn't exist on disk
 * (the agent claimed to write but didn't).
 *
 * Fail-soft on malformed YAML is deliberate: `parseFrontmatter` throws on
 * an agent-authored scalar that smuggles in a bare `: ` (e.g.
 * `target: foo (lane UI: L0–L2)` reads as a nested mapping). Letting that
 * throw escape converts a single stray colon — in the LAST write of a
 * multi-hour stage — into a fatal that halts the whole workflow. Degrading
 * to `{}` keeps the artifact (the real work) and defers any missing-field
 * judgement to the stage's `outputSchema` validation, exactly as a file
 * with no frontmatter at all already does.
 */
export const frontmatterParser: ArtifactParser<undefined, "artifact-md", Record<string, unknown>> = defineParser({
	parse(ctx: ParseContext<undefined>) {
		const primary = ctx.artifacts[0];
		if (primary?.handle.kind !== "fs") {
			return {
				kind: "fatal",
				message: `${ctx.skill}: frontmatterParser requires an fs artifact (got ${primary?.handle.kind ?? "none"})`,
			};
		}
		const abs = isAbsolute(primary.handle.path) ? primary.handle.path : join(ctx.cwd, primary.handle.path);
		if (!existsSync(abs)) {
			return {
				kind: "fatal",
				message: `agent announced ${primary.handle.path} but file does not exist on disk`,
			};
		}
		const content = readFileSync(abs, "utf-8");
		let frontmatter: unknown;
		try {
			({ frontmatter } = parseFrontmatter(content));
		} catch {
			// Malformed YAML (unquoted `: ` in a scalar, bad indentation, …) →
			// degrade to no-frontmatter rather than killing the chain.
			frontmatter = undefined;
		}
		return {
			kind: "ok",
			payload: {
				kind: "artifact-md",
				data: frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {},
			},
		};
	},
});

// ---------------------------------------------------------------------------
// Outcome — pre-bundled wiring rpiv-pi workflows plug in
// ---------------------------------------------------------------------------

/** Default rpiv-pi produces outcome — bucket-agnostic text scan + frontmatter parse. */
export const rpivArtifactMdOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
	collector: rpivArtifactCollector,
	parser: frontmatterParser,
};

/**
 * Per-bucket variant — narrows accepted paths to the supplied subfolder
 * AND publishes the resulting `Output` under `state.named[bucket]` so
 * downstream stages can reference it via `reads: [bucket, ...]` without
 * restating the bucket on each producing stage. Multiple stages wiring
 * the same bucket converge to one named slot (latest entry wins on read).
 */
export function rpivBucketOutcome(bucket: string): Outcome<unknown, "artifact-md", Record<string, unknown>> {
	return { name: bucket, collector: rpivBucketCollector(bucket), parser: frontmatterParser };
}
