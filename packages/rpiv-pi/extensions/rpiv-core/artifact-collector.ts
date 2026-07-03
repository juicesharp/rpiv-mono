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
 * One parser: `frontmatterParser` parses YAML frontmatter from the
 * primary fs artifact into `Record<string, unknown>` — what
 * `outputSchema` validates against for typed downstream narrowing.
 *
 * Pre-bundled outcome: `rpivArtifactMdOutcome` =
 * `{ collector: rpivArtifactCollector, parser: frontmatterParser }` —
 * the default rpiv-pi's built-in workflows wire into every
 * `produces()` stage.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type ArtifactCollector,
	type ArtifactParser,
	defineParser,
	type Outcome,
	type ParseCtx,
	transcriptPathCollector,
	// Runner-free entry — keeps the ~530ms engine off the startup path.
} from "@juicesharp/rpiv-workflow/registration";

// ---------------------------------------------------------------------------
// Collectors — text-scan over assistant transcript
// ---------------------------------------------------------------------------

const RPIV_ARTIFACT_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Bucket-agnostic — accepts any `.rpiv/artifacts/<bucket>/...md`. */
export const rpivArtifactCollector: ArtifactCollector = transcriptPathCollector({ pattern: RPIV_ARTIFACT_PATTERN });

/** Bucket-narrowed — accepts only `.rpiv/artifacts/<bucket>/...md`. */
export function rpivBucketCollector(bucket: string): ArtifactCollector {
	const escaped = bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`\\.rpiv/artifacts/${escaped}/[\\w.-]+\\.md`, "g");
	return transcriptPathCollector({ pattern });
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
	parse(ctx: ParseCtx<undefined>) {
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
