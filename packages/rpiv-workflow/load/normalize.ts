/**
 * Default-export normalisation. Config files accept three default-export
 * shapes; packs accept only the first two (`Workflow | Workflow[]`).
 * The envelope form is rejected for packs so authors don't trip the
 * silent "default lives somewhere else" gotcha.
 *
 *   1. A single `Workflow`               — single-entry namespace
 *   2. `Workflow[]`                      — multi-entry, default required if > 1
 *   3. `{ workflows, default? }`         — full envelope, explicit default
 *
 * Missing-field policy for `gate(...)` routes is documented at
 * `api.ts:gate`; loader-side, missing fields surface as `NaN` after
 * `Number(...)` coercion in the predicate body — not a loader concern.
 */

import type { Workflow } from "../api.js";
import { describe, isEnvelope, isWorkflow } from "./shape-guards.js";

export type FileKind = "config" | "pack";

export interface ParsedConfig {
	workflows: Workflow[];
	default?: string;
	skillAliases?: Record<string, string>;
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
		// to default to.) Packs reject the envelope anyway, so a multi-entry
		// pack array gets the same hard error as a config-file one — that's
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
		if (kind === "pack") {
			return {
				kind: "err",
				error:
					"pack workflow files must export a `Workflow` or `Workflow[]` — the " +
					"`{ workflows, default?, skillAliases? }` envelope is only accepted in the config file config.ts.",
			};
		}
		// `isEnvelope` recognises the envelope when `skillAliases`/`default` is
		// present even if `workflows` is absent or malformed. A present-but-non-array
		// `workflows` must error explicitly: `??` only guards null/undefined, so a
		// truthy non-array (string, object) would otherwise reach `.every()` and
		// throw a `TypeError`, violating the loader's "never throws" contract.
		if (raw.workflows !== undefined && !Array.isArray(raw.workflows)) {
			return { kind: "err", error: "default-export `workflows` must be a Workflow[]" };
		}
		const workflows = raw.workflows ?? [];
		if (!workflows.every(isWorkflow)) {
			return { kind: "err", error: "default-export `workflows` must contain only Workflow objects" };
		}
		if (raw.skillAliases !== undefined) {
			const aliases = raw.skillAliases as unknown;
			const ok =
				typeof aliases === "object" &&
				aliases !== null &&
				!Array.isArray(aliases) &&
				Object.values(aliases).every((t) => typeof t === "string");
			if (!ok) {
				return {
					kind: "err",
					error: "`skillAliases` must be a Record<string, string> (skill name → skill name)",
				};
			}
		}
		return { kind: "ok", value: { workflows, default: raw.default, skillAliases: raw.skillAliases } };
	}
	return {
		kind: "err",
		error:
			"default export must be a Workflow, Workflow[], or { workflows: Workflow[]; default?: string } — " +
			`got ${describe(raw)}`,
	};
}
