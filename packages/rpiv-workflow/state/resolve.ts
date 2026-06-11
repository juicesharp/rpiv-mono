/**
 * Run-reference resolution — the one composer that sits ABOVE both the raw
 * readers (`reads.ts`) and the names index (`names.ts`). Moved out of
 * `reads.ts` (D9): a name-aware resolver doesn't belong in the raw-reads
 * module, and housing it there forced `reads.ts` to import `names.ts`.
 */

import { basename } from "node:path";
import { isValidName, readNamesIndex, rebuildIndex } from "./names.js";
import { readHeader } from "./reads.js";
import type { WorkflowHeader } from "./state.js";

/**
 * Resolve a run *reference* to its header — the ref-resolution seam.
 *
 * Which to call: reach for `resolveRun` when the ref is **user-supplied** (the
 * `/wf @<ref>` token, a CLI arg); reach for `readHeader` when you already hold
 * a concrete `runId` (e.g. straight off `RunSummary.runId`). The split is
 * intent, not behaviour.
 *
 * Resolution order:
 *  1. Check the names index (`names.json`) for a name → runId mapping on the
 *     RAW ref. If found and the target JSONL exists, return its header.
 *  2. Fall back to runId lookup via `readHeader`, on the ref normalized to a
 *     slug — a trailing `.jsonl` is stripped and any directory prefix is
 *     dropped (`basename`). This lets `/wf @<path>` accept an editor's
 *     file-autosuggested path to the run's JSONL (`.../runs/<id>.jsonl`),
 *     a bare `<id>.jsonl`, or the plain `<id>` slug interchangeably.
 *  3. Index-miss recovery: if both lookups failed AND the ref is a
 *     well-formed run name absent from the index, rebuild `names.json` from
 *     the JSONL headers (`rebuildIndex`) and retry the name lookup once —
 *     a deleted/corrupt `names.json` no longer orphans named runs.
 *
 * Name lookup stays on the raw ref: a run name is never a path, so a name like
 * `auth.jsonl` (were it ever claimed) must match verbatim, not as a slug.
 *
 * Fail-soft like every reader — returns undefined when the ref doesn't resolve.
 */
export function resolveRun(cwd: string, ref: string): WorkflowHeader | undefined {
	// Try the names index first — O(1) lookup for human-readable aliases.
	// Matched on the raw ref: a name is never a path/`.jsonl` file.
	const index = readNamesIndex(cwd);
	if (index?.[ref]) {
		const resolved = readHeader(cwd, index[ref]!);
		if (resolved) return resolved;
	}
	// Fall back to runId lookup, tolerating a pasted/autosuggested path:
	// reduce to the bare slug (drop dir prefix + trailing `.jsonl`).
	const slug = basename(ref).replace(/\.jsonl$/, "");
	const bySlug = readHeader(cwd, slug);
	if (bySlug) return bySlug;
	// Recovery: a lost/corrupt names.json silently orphans named runs. Rebuild
	// from headers only when the ref LOOKS like a name the index should have
	// carried (valid shape, not present) — an unresolvable runId slug never
	// triggers the O(runs) rescan.
	if (isValidName(ref) && !index?.[ref]) {
		const runId = rebuildIndex(cwd)?.[ref];
		if (runId) return readHeader(cwd, runId);
	}
	return undefined;
}
