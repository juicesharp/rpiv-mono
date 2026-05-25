/**
 * Detect which SIBLINGS are installed by reading the active Pi settings file.
 * Pure utility — no ExtensionAPI.
 */

import { SIBLINGS, type SiblingPlugin } from "./siblings.js";
import { readPiAgentSettings } from "./utils.js";

/**
 * Return the SIBLINGS not currently installed.
 * Reads the active Pi settings file once per call — callers that need both the
 * full snapshot and the missing subset should call this once and filter.
 */
export function findMissingSiblings(): SiblingPlugin[] {
	const result = readPiAgentSettings();
	if (!result) return [...SIBLINGS];
	const installed = result.packages.filter((e): e is string => typeof e === "string");
	return SIBLINGS.filter((s) => !installed.some((entry) => s.matches.test(entry)));
}
