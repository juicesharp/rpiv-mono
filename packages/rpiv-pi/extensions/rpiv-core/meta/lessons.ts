/**
 * The learning edge — the long return path. A unit that went red and was then
 * corrected to green in an ACCEPTED run (the run reached `learn`) leaves each
 * corrected failure behind as a standing constraint; every later run's
 * producer for that unit reads the most frequent ones in its brief. It fixes
 * every run after, where the correction edge only fixes the run it is in.
 *
 * Deterministic and cross-run by design: one JSON file under `.rpiv/lessons/`,
 * keyed by unit + source + reason, counted. A failure a unit keeps hitting run
 * after run rises to the top of its brief.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScriptContext } from "@juicesharp/rpiv-workflow/registration";

export const LESSONS_FILE = ".rpiv/lessons/meta-lessons.json";
const MAX_IN_BRIEF = 8;
const MAX_REASON = 240;

interface Lesson {
	unit: string;
	source: string;
	reason: string;
	count: number;
	lastRun: string;
}

type LessonBook = Record<string, Lesson>;

const read = (cwd: string): LessonBook => {
	const p = join(cwd, LESSONS_FILE);
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as LessonBook;
	} catch {
		return {};
	}
};

export function lessonsBlock(cwd: string, unit: string): string {
	const top = Object.values(read(cwd))
		.filter((l) => l.unit === unit)
		.sort((a, b) => b.count - a.count || b.lastRun.localeCompare(a.lastRun))
		.slice(0, MAX_IN_BRIEF);
	if (top.length === 0) return "";
	return [
		"",
		"## Standing constraints (learned from earlier accepted runs)",
		"Earlier runs of this unit went red on the items below and had to be corrected. Get them right the first time:",
		...top.map((l) => `- [${l.source}, seen ${l.count}×] ${l.reason}`),
	].join("\n");
}

interface RedRecord {
	unit?: string;
	pass?: boolean;
	failures?: Array<{ source?: string; reason?: string }>;
}

export function recordLessons({ state, cwd }: ScriptContext, units: readonly string[]): void {
	const runId = (state.output?.meta as { runId?: string } | undefined)?.runId ?? new Date().toISOString();
	const book = read(cwd);
	let added = 0;
	for (const unit of units) {
		const reds = [...(state.named[`${unit}-check`] ?? []), ...(state.named[`${unit}-gate`] ?? [])]
			.map((o) => o.data as RedRecord)
			.filter((r) => r && r.pass === false);
		for (const r of reds) {
			for (const f of r.failures ?? []) {
				if (!f.reason) continue;
				const reason = f.reason.slice(0, MAX_REASON);
				const key = `${unit}::${f.source ?? "?"}::${reason}`;
				const prev = book[key];
				book[key] = { unit, source: f.source ?? "?", reason, count: (prev?.count ?? 0) + 1, lastRun: runId };
				added++;
			}
		}
	}
	if (added === 0) return;
	const p = join(cwd, LESSONS_FILE);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(book, null, 2)}\n`);
}
