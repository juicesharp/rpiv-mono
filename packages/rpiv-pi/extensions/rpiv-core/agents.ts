/**
 * Agent auto-copy subsystem — public barrel.
 *
 * Copies bundled agents into ~/.pi/agent/agents/. Pure utility. No
 * ExtensionAPI interactions.
 *
 * The implementation lives in the agents-*.ts family, layered so each module
 * imports only the layers above it:
 *   1. agents-types.ts     — SYNC_OP / CLEANUP_SKIP_REASON pairs, result
 *                            shapes, summarizeCleanupSkips (zero imports)
 *   2. agents-allowlist.ts — isManagedAgentName / safeJoin path-traversal gate
 *   3. agents-manifest.ts  — sha256 manifest read/write, atomic tmp+rename
 *                            (owns the inter-process race caveat)
 *   4. agents-inject.ts    — injectModelFrontmatter pure transform
 *   5. agents-sync.ts      — syncBundledAgents / cleanupPerCwdAgents /
 *                            isSafeDestructiveOp engine
 *
 * This barrel re-exports exactly the pre-split public surface — col-0
 * re-export statements keep every child on the extension's static import
 * graph. Internal layer symbols (safeJoin, readManifest, writeManifest,
 * sha256, the result factories, …) are intentionally NOT re-exported.
 * Consumers import "./agents.js" unchanged.
 */

export type { AgentInjectionContext } from "./agents-inject.js";
export { injectModelFrontmatter } from "./agents-inject.js";
export { cleanupPerCwdAgents, isSafeDestructiveOp, syncBundledAgents } from "./agents-sync.js";
export type {
	CleanupResult,
	CleanupSkip,
	CleanupSkipReason,
	SyncError,
	SyncOp,
	SyncResult,
} from "./agents-types.js";
export { CLEANUP_SKIP_REASON, SYNC_OP, summarizeCleanupSkips } from "./agents-types.js";
