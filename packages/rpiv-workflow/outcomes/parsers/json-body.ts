/**
 * JSON-body parser — parses the primary fs artifact's body via
 * `JSON.parse`. The companion to `transcriptPathCollector` (or any
 * fs-emitting collector) for stages whose output is a JSON document
 * the next stage validates against an `inputSchema`.
 *
 * Fail cases:
 *   - primary artifact is not an `fs` handle      → fatal
 *   - file announced but missing on disk          → fatal
 *   - body does not parse as JSON                 → fatal
 *
 * Authors who want to read only the frontmatter of a markdown file
 * use rpiv-pi's `frontmatterParser` (or write their own); this parser
 * intentionally does no Markdown handling.
 *
 * `kind` is `"json"`; `data` is the parsed value (typed `unknown` —
 * narrow it via the stage's `outputSchema` for typed downstream
 * narrowing through `output.data`).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { formatError } from "../../internal-utils.ts";
import type { ArtifactParser } from "../../output-spec.ts";
import { defineParser } from "../../output-spec.ts";

export const jsonBodyParser: ArtifactParser<unknown, "json", unknown> = defineParser({
	parse: (ctx) => {
		const primary = ctx.artifacts[0];
		if (primary?.handle.kind !== "fs") {
			return {
				kind: "fatal",
				message: `${ctx.skill}: jsonBodyParser requires an fs artifact (got ${primary?.handle.kind ?? "none"})`,
			};
		}
		const abs = isAbsolute(primary.handle.path) ? primary.handle.path : join(ctx.cwd, primary.handle.path);
		if (!existsSync(abs)) {
			return { kind: "fatal", message: `agent announced ${primary.handle.path} but file does not exist on disk` };
		}
		try {
			const data = JSON.parse(readFileSync(abs, "utf-8"));
			return { kind: "ok", payload: { kind: "json", data } };
		} catch (e) {
			return {
				kind: "fatal",
				message: `${ctx.skill}: failed to parse JSON from ${primary.handle.path} — ${formatError(e)}`,
			};
		}
	},
});
