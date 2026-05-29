/**
 * prompt — the advisor system prompt, loaded once at module init from
 * prompts/advisor-system.txt. The URL is anchored one level up (../prompts/)
 * because this module sits in advisor/ while the asset ships at the package
 * root. ESM-safe, cache-stable.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ADVISOR_SYSTEM_PROMPT = readFileSync(
	fileURLToPath(new URL("../prompts/advisor-system.txt", import.meta.url)),
	"utf-8",
).trimEnd();
