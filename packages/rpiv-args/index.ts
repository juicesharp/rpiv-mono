/**
 * rpiv-args — Pi extension entry point.
 *
 * Registers the `input` event handler, a `before_agent_start` system-prompt
 * augmenter, and a `session_start` cache invalidator. All logic lives in
 * args.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArgsHandler } from "./args.js";

/**
 * Presence marker: rpiv-args registers no tool or command, so rpiv-pi's sibling
 * detection cannot see it by source path when it is loaded outside the settings
 * file (bundled in another package, a project install). rpiv-pi reads this
 * `globalThis` slot instead (`SIBLINGS` in rpiv-pi's siblings.ts) — #216.
 */
export const LOADED_MARKER = "@juicesharp/rpiv-args:loaded";

export default function (pi: ExtensionAPI): void {
	(globalThis as Record<symbol, unknown>)[Symbol.for(LOADED_MARKER)] = true;
	registerArgsHandler(pi);
}
