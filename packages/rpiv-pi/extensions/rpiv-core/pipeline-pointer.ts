/**
 * Pipeline pointer — a compact, model-visible index of the RPIV stage skills.
 *
 * The pipeline/fanout skills carry `disable-model-invocation: true` (issue #77),
 * so Pi excludes their descriptions from the system prompt (~3k tokens saved per
 * session, multiplied across workflow children). That also removes the model's
 * only map from user intent ("help me design this") to the stage commands. This
 * module buys that discoverability back for ~120 tokens: a hidden message listing
 * the commands so the agent can route the developer to `/skill:<name>` instead of
 * improvising the workflow itself.
 *
 * Injected at `session_start` and re-injected after `session_compact`, mirroring
 * `injectRootGuidance` (session-hooks.ts owns the wiring). Stateless — both hooks
 * fire exactly once per (re)start, right after `resetInjectionState()`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLAG_DEBUG, MSG_TYPE_PIPELINE_INDEX } from "./constants.js";

/**
 * Keep this in sync with the `disable-model-invocation: true` skill set under
 * packages/rpiv-pi/skills/. Grouping mirrors the tiers from issue #77: ordered
 * pipeline stages, other explicit-only commands, and workflow-internal fanout
 * units the agent must never suggest.
 */
export const PIPELINE_POINTER = [
	"[rpiv pipeline index — reference material, NOT a task. The RPIV stage skills",
	"are hidden from the skill list and run only when the developer explicitly",
	"invokes /skill:<name>. Never start a stage yourself; when the user's request",
	"matches one, point them at the command.]",
	"",
	"Pipeline stages (in order): /skill:discover → /skill:research → /skill:design",
	"(or /skill:explore to weigh approaches first) → /skill:plan or /skill:blueprint",
	"→ /skill:implement → /skill:validate",
	"Other explicit-only commands: /skill:slice, /skill:revise, /skill:elaborate,",
	"/skill:architecture-review, /skill:frontend-design",
	"Workflow-internal (dispatched by lanes — never suggest): amend, design-slice,",
	"design-review, synthesize, grade",
].join("\n");

export function injectPipelinePointer(pi: ExtensionAPI): void {
	pi.sendMessage({
		customType: MSG_TYPE_PIPELINE_INDEX,
		content: PIPELINE_POINTER,
		display: !!pi.getFlag(FLAG_DEBUG),
	});
}
