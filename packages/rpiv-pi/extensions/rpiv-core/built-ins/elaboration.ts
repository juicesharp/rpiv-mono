/**
 * The elaborate stage's outcome: the `elaborations` bucket collector with a
 * parser that adds two body-derived facts beside the frontmatter, so the
 * skill contract's `outputSchema` can refuse a section the stitch would
 * mis-splice while the lane is still alive to fix it.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineParser, type Outcome, type ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { frontmatterParser, rpivBucketOutcome } from "../artifact-collector.js";
import { countHeadingsOutsideFences, openFenceLine } from "./markdown-fence.js";
import { PLAN_PHASE_RE } from "./plan-phases.js";

interface ElaborationStructure {
	/** `"balanced"`, or the diagnosis the contract's enum failure surfaces verbatim. */
	fence_walk: string;
	/** `## Phase N:` headings outside fences — the splice anchor count, contractually 1. */
	phase_headings: number;
}

/** Structural facts of one elaboration body under the shared fence walk. */
const elaborationStructure = (content: string): ElaborationStructure => {
	const open = openFenceLine(content);
	return {
		fence_walk:
			open === undefined
				? "balanced"
				: `open from line ${open} — a bare \`\`\` inside a \`\`\` block closes it; open and close the outer block with four backticks (\`\`\`\`)`,
		phase_headings: countHeadingsOutsideFences(content, PLAN_PHASE_RE),
	};
};

/** Frontmatter plus the derived structure; derived keys win over authored ones. */
const elaborationParser = defineParser<undefined, "artifact-md", Record<string, unknown>>({
	async parse(ctx: ParseContext<undefined>) {
		const base = await frontmatterParser.parse(ctx);
		const primary = ctx.artifacts[0];
		if (base.kind !== "ok" || primary?.handle.kind !== "fs") return base;
		const path = primary.handle.path;
		const content = readFileSync(isAbsolute(path) ? path : join(ctx.cwd, path), "utf-8");
		return {
			kind: "ok",
			payload: { kind: "artifact-md", data: { ...base.payload.data, ...elaborationStructure(content) } },
		};
	},
});

const elaborationOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
	...rpivBucketOutcome("elaborations"),
	parser: elaborationParser,
};

export { type ElaborationStructure, elaborationOutcome, elaborationParser, elaborationStructure };
