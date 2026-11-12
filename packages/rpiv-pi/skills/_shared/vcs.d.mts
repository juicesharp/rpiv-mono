/**
 * Typed surface of vcs.mjs for the TS consumer (vcs.test.ts). Keep in lockstep
 * with the .mjs exports — the runtime source of truth. `vcs.test.ts` asserts the
 * key set matches, because `tsconfig.base.json` only includes `*.ts` and the
 * `.mjs` implementation is never type-checked.
 */

/** One working-copy entry in the git `XY` vocabulary. */
export interface VcsStatusEntry {
	xy: string;
	path: string;
}

/** `{ ok, out }` for `bin args...` run in `cwd`; `ok` is false on any failure. */
export declare function readOk(bin: string, args: string[], cwd?: string): { ok: boolean; out: string };

/** Raw stdout of `bin args...`; `fb` on failure or empty output. NOT trimmed. */
export declare function readRaw(bin: string, args: string[], fb?: string, cwd?: string): string;

/** Trimmed stdout of `bin args...` run in `cwd`; `fb` on failure or empty output. */
export declare function read(bin: string, args: string[], fb?: string, cwd?: string): string;

/** `{ backend, root }` for `cwd`. jj wins when both backends could answer. */
export declare function detect(cwd?: string): { backend: "jj" | "git" | "none"; root: string };

/** `jj diff --summary` rewritten into git's `XY <path>` grammar. */
export declare function jjSummaryToStatus(raw: string): string;

/** Working-copy status as `{ xy, path }` entries; `[]` when no backend answers. */
export declare function statusEntries(cwd?: string, backend?: "jj" | "git" | "none"): VcsStatusEntry[];

/** Working-copy status as `XY <path>` lines; `""` when no backend answers. */
export declare function statusText(cwd?: string, backend?: "jj" | "git" | "none"): string;
