/**
 * Typed surface of reconcile-directives.mjs for the TS consumer
 * (extensions/rpiv-core/built-ins/reconcile.ts). Keep in lockstep with the
 * .mjs exports — the runtime source of truth.
 */

/** One `#### Reconciliation` directive parsed from a plan body. */
export interface ReconciliationDirective {
	/** Repo-root-relative target declared in the plan's write-set. */
	target: string;
	/** Substring to find (replaced exactly once via `String.replace`). */
	find: string;
	/** Replacement string. */
	replace: string;
}

/** What applying a directive to the target's current content would do. */
export type ApplicationClass = "already-applied" | "apply" | "deletion-satisfied" | "missing";

export declare function reconciliationRecords(body: string): {
	directives: ReconciliationDirective[];
	malformed: string[];
};

export declare function classifyApplication(directive: ReconciliationDirective, content: string): ApplicationClass;

export declare function declaredWriteSet(body: string): Set<string>;

export declare function phaseSection(body: string, n: number | string): string | undefined;
