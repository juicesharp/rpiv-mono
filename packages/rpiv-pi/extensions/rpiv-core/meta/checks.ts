/**
 * Deterministic graders — code nodes with exactly one correct answer. Each is
 * a program a machine can evaluate, never "the output looks good": a file
 * exists, a count clears a floor, a command exits 0.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { FILE_LINE_CITATION_RE, planCitationCheck } from "../built-ins/index.js";
import type { Check, CheckContext, Failure } from "./unit-graph.js";

const abs = (ctx: CheckContext, p: string) => (isAbsolute(p) ? p : join(ctx.cwd, p));

const body = (ctx: CheckContext): string | undefined =>
	ctx.artifactPath && existsSync(abs(ctx, ctx.artifactPath))
		? readFileSync(abs(ctx, ctx.artifactPath), "utf-8")
		: undefined;

/** GREEN when the unit's artifact exists and is non-trivial. */
export const artifactWritten = (minLines = 10): Check => ({
	name: "artifact-written",
	run: (ctx) => {
		const b = body(ctx);
		if (b === undefined) return [{ source: "artifact-written", reason: "the unit produced no artifact file" }];
		const n = b.split("\n").length;
		return n < minLines
			? [
					{
						source: "artifact-written",
						reason: `artifact has ${n} lines (< ${minLines})`,
						evidence: ctx.artifactPath,
					},
				]
			: [];
	},
});

/** GREEN when the artifact carries at least `min` file:line citations ("every claim carries a source line"). */
export const minCitations = (min: number): Check => ({
	name: "citations",
	run: (ctx) => {
		const b = body(ctx) ?? "";
		const n = [...b.matchAll(new RegExp(FILE_LINE_CITATION_RE))].length;
		return n < min
			? [
					{
						source: "citations",
						reason: `only ${n} file:line citations (need ≥ ${min}) — ground claims in code`,
						evidence: ctx.artifactPath,
					},
				]
			: [];
	},
});

/**
 * GREEN when every acceptance item carries runnable evidence (`command`) or an
 * explicit `manual` note. Reads the unit's own published frontmatter.
 */
export const acceptanceWellFormed: Check = {
	name: "acceptance-shape",
	run: (ctx) => {
		const items = (ctx.state.named.acceptance?.at(-1)?.data as { items?: unknown } | undefined)?.items;
		if (!Array.isArray(items) || items.length === 0)
			return [{ source: "acceptance-shape", reason: "frontmatter `items:` is empty or missing" }];
		return items
			.map((it) => it as { id?: string; command?: string; manual?: string })
			.filter((it) => !it.command && !it.manual)
			.map((it) => ({ source: "acceptance-shape", reason: `item ${it.id ?? "?"} has neither command nor manual` }));
	},
};

/**
 * GREEN when the plan's citations resolve and every edited path is declared —
 * build's own floor (`planCitationCheck`), reused verbatim; only its blocking
 * (non-advisory) findings fail the unit.
 */
export const planCitations: Check = {
	name: "plan-citations",
	run: (ctx) => {
		const out = planCitationCheck(`${ctx.unit}-cite-check`)(ctx);
		const findings = ((out.data as { findings?: unknown[] } | undefined)?.findings ?? []) as Array<{
			advisory?: boolean;
			detail?: string;
			message?: string;
			where?: string;
		}>;
		return findings
			.filter((f) => f.advisory !== true)
			.map((f) => ({
				source: "plan-citations",
				reason: f.detail ?? f.message ?? JSON.stringify(f),
				evidence: f.where,
			}));
	},
};

/** GREEN when the plan disposes every acceptance id (implemented / deferred / rebound). */
export const acceptanceDisposed: Check = {
	name: "acceptance-disposed",
	run: (ctx) => {
		const items = (
			(ctx.state.named.acceptance?.at(-1)?.data as { items?: Array<{ id?: string }> } | undefined)?.items ?? []
		)
			.map((i) => i.id)
			.filter((id): id is string => !!id);
		const disposed = new Set(
			(
				(ctx.state.named.plans?.at(-1)?.data as { acceptance?: Array<{ id?: string }> } | undefined)?.acceptance ??
				[]
			).map((d) => d.id),
		);
		return items
			.filter((id) => !disposed.has(id))
			.map((id) => ({
				source: "acceptance-disposed",
				reason: `acceptance item ${id} has no disposition in the plan's frontmatter \`acceptance:\``,
			}));
	},
};

const run = (cmd: string, cwd: string, timeoutMs: number): { ok: boolean; tail: string } => {
	try {
		execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, shell: "/bin/bash" });
		return { ok: true, tail: "" };
	} catch (err) {
		const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
		const tail = `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`
			.trim()
			.split("\n")
			.slice(-12)
			.join("\n");
		return { ok: false, tail: tail || (e.message ?? "failed") };
	}
};

/** GREEN when a shell command exits 0 (e.g. the build or the test suite). */
export const commandPasses = (name: string, cmd: string, timeoutMs = 20 * 60_000): Check => ({
	name,
	run: (ctx) => {
		const r = run(cmd, ctx.cwd, timeoutMs);
		return r.ok ? [] : [{ source: name, reason: `\`${cmd}\` exited non-zero`, evidence: r.tail }];
	},
});

/**
 * GREEN when every frozen acceptance evidence command exits 0 on the tree —
 * the executable standard of completion. A plan `rebound` disposition swaps in
 * its replacement command; `deferred` and `manual` items are skipped. One
 * failure per red item, so a correction returns only those items.
 */
export const acceptanceCommands = (timeoutMs = 20 * 60_000): Check => ({
	name: "acceptance",
	run: (ctx) => {
		const items = ((ctx.state.named.acceptance?.at(-1)?.data as { items?: unknown[] } | undefined)?.items ??
			[]) as Array<{
			id?: string;
			statement?: string;
			command?: string;
			expect?: string;
		}>;
		const disp = new Map(
			(
				((ctx.state.named.plans?.at(-1)?.data as { acceptance?: unknown[] } | undefined)?.acceptance ??
					[]) as Array<{
					id?: string;
					disposition?: string;
					command?: string;
				}>
			).map((d) => [d.id, d]),
		);
		const failures: Failure[] = [];
		for (const it of items) {
			const d = disp.get(it.id);
			const kind = d?.disposition;
			if (kind === "deferred" || !it.command) continue;
			const cmd = kind === "rebound" && d?.command ? d.command : it.command;
			const r = run(cmd, ctx.cwd, timeoutMs);
			if (!r.ok) {
				failures.push({
					source: "acceptance",
					reason: `${it.id}: ${it.statement ?? "acceptance item"} — \`${cmd}\` failed (expected: ${it.expect ?? "exit 0"})`,
					evidence: r.tail,
				});
			}
		}
		return failures;
	},
});

/** GREEN when the working tree has changes (a side-effect unit actually did something). */
export const treeChanged: Check = {
	name: "tree-changed",
	run: (ctx) => {
		const out = execSync("git status --porcelain", { cwd: ctx.cwd }).toString().trim();
		return out.length === 0 ? [{ source: "tree-changed", reason: "the unit left the working tree unchanged" }] : [];
	},
};
