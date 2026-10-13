#!/usr/bin/env node
/**
 * A/B harness: run two /wf pipelines on the SAME brief from the SAME commit,
 * in parallel, in isolated git worktrees, then compare them on the same
 * held-out checks.
 *
 *   node ab.mjs setup   <repo> <label> "<brief>" [--arms build,meta]
 *   node ab.mjs compare <repo> <label> [--eval "<cmd>"]... [--no-acceptance] [--adopt-lessons]
 *
 * setup   — one worktree + branch per arm (ab/<label>/<arm>) at HEAD. Copies the
 *           gitignored .rpiv/guidance into every arm (parity) and .rpiv/lessons
 *           into meta arms. Prints the command to launch each arm.
 * compare — reads each arm's run trail + session transcripts and reports:
 *           outcome, wall clock, active time, sessions, tokens, stage visits,
 *           correction rounds, the diff, and a SHARED scorecard: every --eval
 *           command plus EVERY arm's frozen acceptance commands, executed on
 *           every arm's tree (so no arm is graded only by its own standard).
 *           Writes <repo>/.rpiv/ab/<label>-report.md.
 *
 * Write the --eval commands BEFORE looking at either result — the check first.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [, , cmd, repoArg, label, ...rest] = process.argv;
if (!cmd || !repoArg || !label) {
	console.error('usage:\n  ab.mjs setup <repo> <label> "<brief>" [--arms build,meta]\n  ab.mjs compare <repo> <label> [--eval "<cmd>"]... [--adopt-lessons]');
	process.exit(2);
}
const repo = resolve(repoArg);
const abDir = join(repo, ".rpiv", "ab");
const manifestPath = join(abDir, `${label}.json`);
const sh = (c, cwd = repo, timeout = 30 * 60_000) => execSync(c, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout, shell: "/bin/bash" }).toString();
const tryRun = (c, cwd) => {
	const t0 = Date.now();
	try {
		sh(c, cwd);
		return { ok: true, ms: Date.now() - t0 };
	} catch (e) {
		const tail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().split("\n").slice(-3).join(" | ");
		return { ok: false, ms: Date.now() - t0, tail };
	}
};
const flag = (name) => {
	const out = [];
	for (let i = 0; i < rest.length; i++) if (rest[i] === name) out.push(rest[++i]);
	return out;
};

// ---------------------------------------------------------------------------
if (cmd === "setup") {
	const brief = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--arms");
	if (!brief) throw new Error("setup needs a brief");
	const arms = (flag("--arms")[0] ?? "build,meta").split(",");
	const base = sh("git rev-parse HEAD").trim();
	if (sh("git status --porcelain --untracked-files=no").trim()) {
		console.warn("warning: the repo has uncommitted tracked changes — worktrees start from HEAD and will NOT include them");
	}
	mkdirSync(abDir, { recursive: true });
	const parent = dirname(repo);
	const entries = arms.map((arm) => {
		const path = join(parent, `${basename(repo)}-ab-${label}-${arm}`);
		const branch = `ab/${label}/${arm}`;
		if (existsSync(path)) throw new Error(`${path} already exists — pick another label`);
		sh(`git worktree add -b ${branch} ${JSON.stringify(path)} ${base}`);
		for (const sub of ["guidance", ...(arm.startsWith("meta") ? ["lessons"] : [])]) {
			const src = join(repo, ".rpiv", sub);
			if (existsSync(src)) cpSync(src, join(path, ".rpiv", sub), { recursive: true });
		}
		return { arm, path, branch, runName: `ab-${label}-${arm}` };
	});
	writeFileSync(manifestPath, `${JSON.stringify({ label, brief, base, created: new Date().toISOString(), arms: entries }, null, 2)}\n`);
	console.log(`A/B "${label}" from ${base.slice(0, 8)} — launch each arm in its own terminal (they run in parallel):\n`);
	for (const e of entries) {
		// A meta arm's escalation (implement → plan) adds a re-entry on top of the
		// per-unit correction rounds; lift the per-destination jump budget for it.
		const jumps = e.arm.startsWith("meta") ? " --max-jumps 6" : "";
		console.log(`  # ${e.arm}\n  cd ${JSON.stringify(e.path)} && pi\n  /wf ${e.arm} ${brief} --name ${e.runName}${jumps}\n`);
	}
	console.log(`When both finish:  node ${process.argv[1]} compare ${repo} ${label} --eval "<held-out check>" ...`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
if (cmd !== "compare") throw new Error(`unknown command ${cmd}`);
const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
const evals = flag("--eval");

const readJsonl = (p) =>
	readFileSync(p, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);

function findRun(arm) {
	const runs = join(arm.path, ".rpiv", "workflows", "runs");
	if (!existsSync(runs)) return undefined;
	const names = existsSync(join(runs, "names.json")) ? JSON.parse(readFileSync(join(runs, "names.json"), "utf-8")) : {};
	const byName = names[arm.runName];
	const id =
		(typeof byName === "string" ? byName : byName?.runId) ??
		readdirSync(runs)
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.at(-1)
			?.replace(/\.jsonl$/, "");
	return id ? { id, file: join(runs, `${id}.jsonl`), sessions: join(runs, id, "sessions") } : undefined;
}

function tokens(dir) {
	if (!existsSync(dir)) return { total: 0, output: 0 };
	let total = 0;
	let output = 0;
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
		const body = readFileSync(join(dir, f), "utf-8");
		for (const mm of body.matchAll(/"usage":\{"input":\d+,"output":(\d+),[^{}]*?"totalTokens":(\d+)/g)) {
			output += Number(mm[1]);
			total += Number(mm[2]);
		}
	}
	return { total, output };
}

function analyze(arm) {
	const run = findRun(arm);
	if (!run || !existsSync(run.file)) return { arm: arm.arm, missing: true };
	const rows = readJsonl(run.file);
	const stages = rows.filter((r) => r.stage && r.ts && !r.type);
	const ts = rows.map((r) => Date.parse(r.ts)).filter(Number.isFinite).sort((a, b) => a - b);
	let active = 0;
	for (let i = 1; i < ts.length; i++) active += Math.min(ts[i] - ts[i - 1], 30 * 60_000);
	const visits = {};
	for (const r of stages.filter((r) => !r.parent)) visits[r.stage] = (visits[r.stage] ?? 0) + 1;
	const revisits = Object.values(visits).reduce((a, n) => a + Math.max(0, n - 1), 0);
	const committed = stages.some((r) => r.stage === "commit" && r.status === "completed");
	const last = stages.at(-1);
	const routeNotes = rows.filter((r) => r.type === "routing" && r.note).map((r) => r.note);
	const failed = stages.find((r) => r.status === "failed");
	const outcome = committed
		? "committed"
		: failed
			? `failed at ${failed.stage}: ${(failed.errMsg ?? "").slice(0, 120)}`
			: `stopped after ${last?.stage ?? "?"}${routeNotes.length ? `: ${routeNotes.at(-1).slice(0, 120)}` : ""}`;
	const loopRounds = Object.fromEntries(
		Object.entries(visits)
			.filter(([s]) => s.endsWith("-check"))
			.map(([s, n]) => [s.replace(/-check$/, ""), n]),
	);
	const diff = (() => {
		try {
			return sh(`git diff --shortstat ${m.base} HEAD`, arm.path).trim() || "(no committed diff)";
		} catch {
			return "?";
		}
	})();
	const acceptance = (() => {
		const dir = join(arm.path, ".rpiv", "artifacts", "acceptance");
		if (!existsSync(dir)) return [];
		const f = readdirSync(dir).sort().at(-1);
		if (!f) return [];
		const fm = readFileSync(join(dir, f), "utf-8").split(/^---$/m)[1] ?? "";
		return [...fm.matchAll(/^\s*-?\s*id:\s*(\S+)[\s\S]*?^\s*command:\s*(.+)$/gm)].map((x) => ({
			id: `${arm.arm}:${x[1]}`,
			command: x[2].trim().replace(/^["']|["']$/g, ""),
		}));
	})();
	return {
		arm: arm.arm,
		runId: run.id,
		outcome,
		wallMin: ts.length ? Math.round((ts.at(-1) - ts[0]) / 60_000) : 0,
		activeMin: Math.round(active / 60_000),
		sessions: stages.filter((r) => r.session).length,
		tokens: tokens(run.sessions),
		stageVisits: Object.values(visits).reduce((a, b) => a + b, 0),
		revisits,
		loopRounds,
		diff,
		acceptance,
		routeNotes,
	};
}

const results = m.arms.map((a) => ({ ...analyze(a), path: a.path }));
const checks = [
	...evals.map((c, i) => ({ id: `eval${i + 1}`, command: c })),
	...(rest.includes("--no-acceptance") ? [] : results.flatMap((r) => r.acceptance ?? [])),
];
const score = results.map((r) =>
	r.missing ? checks.map(() => ({ ok: false, tail: "no run" })) : checks.map((c) => tryRun(c.command, r.path)),
);

const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const lines = [
	`# A/B ${m.label}`,
	"",
	`Brief: ${m.brief}`,
	`Base: ${m.base.slice(0, 10)} · created ${m.created}`,
	"",
	`| | ${results.map((r) => r.arm).join(" | ")} |`,
	`|---|${results.map(() => "---").join("|")}|`,
	...[
		["outcome", (r) => r.outcome ?? "no run"],
		["wall clock", (r) => `${r.wallMin ?? "-"} min`],
		["active time (gaps capped 30m)", (r) => `${r.activeMin ?? "-"} min`],
		["child sessions", (r) => r.sessions ?? "-"],
		["tokens (total / output)", (r) => (r.tokens ? `${fmtK(r.tokens.total)} / ${fmtK(r.tokens.output)}` : "-")],
		["stage visits / re-entries", (r) => `${r.stageVisits ?? "-"} / ${r.revisits ?? "-"}`],
		["correction rounds per unit", (r) => (r.loopRounds && Object.keys(r.loopRounds).length ? Object.entries(r.loopRounds).map(([u, n]) => `${u}:${n}`).join(" ") : "—")],
		["diff vs base", (r) => r.diff ?? "-"],
		[
			"shared scorecard",
			(r, i) => `${score[i].filter((s) => s.ok).length}/${checks.length} green`,
		],
	].map(([k, f]) => `| ${k} | ${results.map((r, i) => String(f(r, i)).replace(/\|/g, "\\|")).join(" | ")} |`),
	"",
	"## Shared scorecard (every check, run on every arm's tree)",
	"",
	`| check | ${results.map((r) => r.arm).join(" | ")} |`,
	`|---|${results.map(() => "---").join("|")}|`,
	...checks.map((c, j) => `| \`${c.id}\` ${c.command.slice(0, 70).replace(/\|/g, "\\|")} | ${score.map((s) => (s[j].ok ? "✅" : "❌")).join(" | ")} |`),
	"",
	"## Route notes",
	...results.flatMap((r) => [`### ${r.arm}`, ...(r.routeNotes?.length ? r.routeNotes.map((n) => `- ${n}`) : ["- (none)"])]),
];
mkdirSync(abDir, { recursive: true });
const reportPath = join(abDir, `${m.label}-report.md`);
writeFileSync(reportPath, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\nreport: ${reportPath}`);

if (rest.includes("--adopt-lessons")) {
	for (const r of results) {
		const src = join(r.path, ".rpiv", "lessons");
		if (r.arm.startsWith("meta") && existsSync(src)) {
			cpSync(src, join(repo, ".rpiv", "lessons"), { recursive: true });
			console.log(`adopted lessons from ${r.arm}`);
		}
	}
}
