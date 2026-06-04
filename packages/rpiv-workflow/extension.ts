/**
 * rpiv-workflow — thin Pi extension entry. `package.json` `pi.extensions` points
 * here, NOT at `./index.ts`: the barrel statically re-exports the whole runtime
 * (~530ms) and would tax every session. This pulls only the two registrars
 * (`/wf` registration is itself lazy); the barrel stays the embedder API surface.
 */

import { registerWorkflowCommand } from "./command.js";
import { type DocsProtocolHost, registerDocsProtocol } from "./docs-protocol.js";
import type { WorkflowHost } from "./host.js";

/** Host ports the `default` needs; Pi's `ExtensionAPI` structurally satisfies both. */
type ExtensionHost = WorkflowHost & DocsProtocolHost;

export default function (host: ExtensionHost): void {
	registerWorkflowCommand(host);
	registerDocsProtocol(host);
}
