/**
 * rpiv-wf — run rpiv-workflow pipelines on Claude Code, no Pi process.
 *
 *   rpiv-wf list
 *   rpiv-wf run <workflow> [input…] [--name N] [--model M] [--concurrency N]
 *                                   [--permission-mode M] [--plugin-dir D] [--cwd D]
 *   rpiv-wf resume <run-id|name>    [same flags]
 *
 * Same catalog as `/wf` in Pi: rpiv-pi's built-ins, then user and project
 * overlays (`.rpiv/workflows/`). Run state lands in `.rpiv/workflows/runs/`,
 * so a run started here can be listed or resumed from Pi and vice versa.
 *
 * Exit codes: 0 completed, 1 failed, 2 usage error, 130 interrupted.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunWorkflowResult, WorkflowHostContext } from "@juicesharp/rpiv-workflow";
import { type ClaudeHostDeps, ClaudeWorkflowHost } from "./claude-host.js";
import { registerRpivWorkflowSupport } from "./rpiv-support.js";
import { defaultPluginDir, loadSkillCatalog, skillRegistryHost } from "./skills.js";

export const EXIT = { ok: 0, failed: 1, usage: 2, interrupted: 130 } as const;

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

const USAGE = `usage:
  rpiv-wf list
  rpiv-wf run <workflow> [input...] [options]
  rpiv-wf resume <run-id|name> [options]

options:
  --name <name>              name the run (resume it later by name)
  --model <id>               Claude model for every stage (default: Claude Code's)
  --concurrency <n>          parallel fan-out units (default 4)
  --permission-mode <mode>   ${PERMISSION_MODES.join(" | ")} (default auto)
  --plugin-dir <dir>         rpiv Claude plugin (default: rpiv-pi/hosts/claude)
  --cwd <dir>                project directory (default: current)`;

export interface CliIo {
	out: (line: string) => void;
	err: (line: string) => void;
}

/** The workflow API, injectable so tests drive the CLI without the runner. */
export interface WorkflowApi {
	loadWorkflows(cwd: string): Promise<{ workflows: readonly { name: string; description?: string }[] }>;
	runWorkflowByName(ctx: WorkflowHostContext, name: string, input: string, opts: object): Promise<RunWorkflowResult>;
	resumeWorkflowByRunId(ctx: WorkflowHostContext, ref: string, opts: object): Promise<RunWorkflowResult>;
}

async function defaultApi(cwd: string): Promise<WorkflowApi> {
	await registerRpivWorkflowSupport(cwd);
	const { loadWorkflows } = await import("@juicesharp/rpiv-workflow/registration");
	const { runWorkflowByName, resumeWorkflowByRunId } = await import("@juicesharp/rpiv-workflow/runner");
	return { loadWorkflows, runWorkflowByName, resumeWorkflowByRunId } as WorkflowApi;
}

async function defaultDeps(): Promise<ClaudeHostDeps> {
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	return { query: sdk.query, forkSession: sdk.forkSession };
}

function report(result: RunWorkflowResult, io: CliIo): number {
	const where = result.runId ? ` (run ${result.runId})` : "";
	if (result.success) {
		io.out(`completed${where}: ${result.stagesCompleted} stage(s)`);
		if (result.lastArtifact) io.out(`artifact: ${result.lastArtifact}`);
		return EXIT.ok;
	}
	io.err(`failed${where} after ${result.stagesCompleted} stage(s): ${result.error ?? "unknown error"}`);
	return EXIT.failed;
}

export async function main(
	argv: readonly string[],
	io: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
	inject: { api?: WorkflowApi; deps?: ClaudeHostDeps; signal?: AbortSignal } = {},
): Promise<number> {
	let parsed: ReturnType<typeof parseArgs<{ allowPositionals: true; options: Record<string, { type: "string" }> }>>;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				name: { type: "string" },
				model: { type: "string" },
				concurrency: { type: "string" },
				"permission-mode": { type: "string" },
				"plugin-dir": { type: "string" },
				cwd: { type: "string" },
			},
		});
	} catch (err) {
		io.err(`${(err as Error).message}\n${USAGE}`);
		return EXIT.usage;
	}
	const { values, positionals } = parsed;
	const [command, target, ...rest] = positionals;
	const cwd = resolve(values.cwd ?? process.cwd());
	const concurrency = Number(values.concurrency ?? 4);
	const mode = (values["permission-mode"] ?? "auto") as PermissionMode;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		io.err(`--concurrency must be a positive integer\n${USAGE}`);
		return EXIT.usage;
	}
	if (!PERMISSION_MODES.includes(mode)) {
		io.err(`unknown --permission-mode "${mode}"\n${USAGE}`);
		return EXIT.usage;
	}
	if (command !== "list" && (command !== "run" && command !== "resume" ? true : !target)) {
		io.err(USAGE);
		return EXIT.usage;
	}

	const api = inject.api ?? (await defaultApi(cwd));
	if (command === "list") {
		const { workflows } = await api.loadWorkflows(cwd);
		for (const w of workflows) io.out(w.description ? `${w.name}\t${w.description}` : w.name);
		return EXIT.ok;
	}

	const pluginDir = resolve(values["plugin-dir"] ?? defaultPluginDir());
	const catalog = loadSkillCatalog(pluginDir, cwd);
	if (catalog.plugin.size === 0) {
		io.err(`no skills found under ${pluginDir}/skills — run \`npm run export:hosts\` or pass --plugin-dir`);
		return EXIT.usage;
	}
	const host = new ClaudeWorkflowHost(
		{
			cwd,
			pluginDir,
			catalog,
			permissionMode: mode,
			maxConcurrency: concurrency,
			model: values.model,
			signal: inject.signal,
			notify: (m, l = "info") => io.err(`[${l}] ${m}`),
		},
		inject.deps ?? (await defaultDeps()),
	);
	const opts = {
		host: skillRegistryHost(catalog),
		signal: inject.signal,
		trigger: { kind: "programmatic", source: "rpiv-claude" },
		...(values.name ? { name: values.name } : {}),
	};
	const result =
		command === "run"
			? await api.runWorkflowByName(host, target!, rest.join(" "), opts)
			: await api.resumeWorkflowByRunId(host, target!, opts);
	if (inject.signal?.aborted) {
		io.err("interrupted");
		return EXIT.interrupted;
	}
	return report(result, io);
}
