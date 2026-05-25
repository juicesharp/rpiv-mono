/**
 * Default-export normalisation. Canonical files accept three default-export
 * shapes; drop-ins accept only the first two (`Workflow | Workflow[]`).
 * The envelope form is rejected for drop-ins so authors don't trip the
 * silent "default lives somewhere else" gotcha.
 *
 *   1. A single `Workflow`               — single-entry namespace
 *   2. `Workflow[]`                      — multi-entry, default required if > 1
 *   3. `{ workflows, default? }`         — full envelope, explicit default
 *
 * Missing-field policy for `threshold`-style predicates is documented at
 * `api.ts:threshold`; loader-side, missing fields surface as `NaN` after
 * `Number(...)` coercion in the predicate body — not a loader concern.
 */

import type { Workflow } from "../api.js";
import { describe, isEnvelope, isWorkflow } from "./shape-guards.js";

export type FileKind = "canonical" | "drop-in";

export interface ParsedConfig {
	workflows: Workflow[];
	default?: string;
}

export type NormalizeResult = { kind: "ok"; value: ParsedConfig } | { kind: "err"; error: string };

export function normalizeDefaultExport(raw: unknown, kind: FileKind): NormalizeResult {
	if (isWorkflow(raw)) return { kind: "ok", value: { workflows: [raw] } };
	if (Array.isArray(raw)) {
		if (raw.length === 0) {
			return { kind: "err", error: "default-export `Workflow[]` must contain at least one Workflow" };
		}
		if (!raw.every(isWorkflow)) {
			return { kind: "err", error: "default export array must contain only Workflow objects" };
		}
		// A bare Workflow[] omits the `default` slot; with more than one entry
		// there's no unambiguous pick. Require the envelope form so the choice
		// is explicit. (Single-entry arrays are accepted — only one workflow
		// to default to.) Drop-ins reject the envelope anyway, so a multi-entry
		// drop-in array gets the same hard error as a canonical one — that's
		// fine; the author should split into one file per workflow.
		if (raw.length > 1) {
			return {
				kind: "err",
				error:
					"default-export `Workflow[]` with more than one entry must be wrapped as " +
					'`{ workflows: [...], default: "<name>" }` so the default workflow is explicit',
			};
		}
		return { kind: "ok", value: { workflows: raw as Workflow[] } };
	}
	if (isEnvelope(raw)) {
		if (kind === "drop-in") {
			return {
				kind: "err",
				error:
					"drop-in workflow files must export a `Workflow` or `Workflow[]` — the " +
					"`{ workflows, default? }` envelope is only accepted in the canonical workflows.config.ts.",
			};
		}
		if (!raw.workflows.every(isWorkflow)) {
			return { kind: "err", error: "default-export `workflows` must contain only Workflow objects" };
		}
		return { kind: "ok", value: { workflows: raw.workflows, default: raw.default } };
	}
	return {
		kind: "err",
		error:
			"default export must be a Workflow, Workflow[], or { workflows: Workflow[]; default?: string } — " +
			`got ${describe(raw)}`,
	};
}
