/**
 * @juicesharp/rpiv-btw — Pi extension entry point.
 *
 * Registers /btw command + 2 lifecycle hooks (message_end snapshot,
 * session_compact/tree invalidation). No tool, no model picker, no disk
 * persistence. History lives in process-scoped globalThis state — survives
 * /new, /fork, /reload, /resume; lost on Pi process exit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand, registerInvalidationHooks, registerMessageEndSnapshot } from "./btw.ts";

export default function (pi: ExtensionAPI): void {
	registerBtwCommand(pi);
	registerMessageEndSnapshot(pi);
	registerInvalidationHooks(pi);
}
