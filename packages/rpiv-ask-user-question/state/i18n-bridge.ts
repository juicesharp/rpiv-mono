/**
 * i18n bridge for rpiv-ask-user-question — single thin import surface so every
 * call site routes through one place. Backed by `@juicesharp/rpiv-i18n`'s SDK.
 *
 * - `t(key, fallback)` is `scope("@juicesharp/rpiv-ask-user-question")`.
 * - `displayLabel(kind)` resolves a sentinel kind to its locale-aware label,
 *   with the canonical English `ROW_INTENT_META[kind].label` as fallback so
 *   nothing renders blank if the namespace isn't registered.
 *
 * Strings are registered ONCE at extension load (see ../index.ts). Call sites
 * MUST use this module at render time — never bake the result into a top-level
 * `const X = displayLabel(...)`.
 *
 * Reserved-label validation stays English-locked: `RESERVED_LABEL_SET` checks
 * the canonical `ROW_INTENT_META[kind].label`, never `displayLabel(kind)`.
 */

import { scope } from "@juicesharp/rpiv-i18n";
import { ROW_INTENT_META, type SentinelKind } from "./row-intent.js";

export const I18N_NAMESPACE = "@juicesharp/rpiv-ask-user-question";

export const t = scope(I18N_NAMESPACE);

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
