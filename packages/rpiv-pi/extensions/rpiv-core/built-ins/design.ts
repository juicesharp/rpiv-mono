/**
 * The slice-design stage's outcome: the `designs` bucket collector with a
 * parser that adds one path-derived fact beside the frontmatter, so the
 * design-slice skill contract can refuse a filename that fails to carry the
 * slice it designs while the lane is still alive to rename it — the twin of
 * elaboration.ts's `fence_walk`. Identity downstream (`designSliceOf`) reads
 * `slice_n` first, so this check guards the FILENAME carrier that
 * `sourcesCoverageGaps` can only ever see as a path string in `sources:`.
 */
import { basename } from "node:path";
import { defineParser, type Outcome, type ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { frontmatterParser, rpivBucketOutcome } from "../artifact-collector.js";
import { DESIGN_SLICE_RE } from "./slices.js";

interface DesignStructure {
	/** `"matches"`, or the diagnosis the contract's enum failure surfaces verbatim. */
	filename_slice: string;
}

/** The path-vs-frontmatter slice agreement of one design artifact. */
const designStructure = (path: string, frontmatter: Record<string, unknown>): DesignStructure => {
	const name = basename(path);
	const token = DESIGN_SLICE_RE.exec(name);
	const sliceN = frontmatter.slice_n;
	if (typeof sliceN !== "number" || !Number.isInteger(sliceN) || sliceN <= 0) {
		return {
			filename_slice: `frontmatter slice_n is ${sliceN === undefined ? "missing" : JSON.stringify(sliceN)} — stamp slice_n: <N> from the dispatched 'Slice N' and name the file <slug>_slice-<N>_<topic>.md`,
		};
	}
	if (!token) {
		return {
			filename_slice: `${name} carries no 'slice-<N>' token — the path is <slug>_slice-${sliceN}_<topic>.md (the slice title is the topic, never the slice id); write the design to that path`,
		};
	}
	if (Number(token[1]) !== sliceN) {
		return {
			filename_slice: `${name} says slice-${token[1]} but frontmatter slice_n is ${sliceN} — the two must agree; the dispatched 'Slice N' is the slice, name the file <slug>_slice-${sliceN}_<topic>.md`,
		};
	}
	return { filename_slice: "matches" };
};

/** Frontmatter plus the derived structure; the derived key wins over an authored one. */
const designParser = defineParser<undefined, "artifact-md", Record<string, unknown>>({
	async parse(ctx: ParseContext<undefined>) {
		const base = await frontmatterParser.parse(ctx);
		const primary = ctx.artifacts[0];
		if (base.kind !== "ok" || primary?.handle.kind !== "fs") return base;
		return {
			kind: "ok",
			payload: {
				kind: "artifact-md",
				data: { ...base.payload.data, ...designStructure(primary.handle.path, base.payload.data) },
			},
		};
	},
});

const designOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
	...rpivBucketOutcome("designs"),
	parser: designParser,
};

export { type DesignStructure, designOutcome, designParser, designStructure };
