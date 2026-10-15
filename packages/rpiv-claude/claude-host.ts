/**
 * Claude Code executor host for rpiv-workflow.
 *
 * Implements the runner's executor port (`WorkflowHostContext`) over the
 * Claude Agent SDK, the way rpiv-pi's `SdkWorkflowHost` implements it over
 * Pi's `AgentSession`. Every stage or fan-out unit runs in its own Claude Code
 * session; each turn is one `query()` that resumes the session by id.
 *
 *   FRESH    — new session; the host sends the stage prompt.
 *   REATTACH — `resume` the persisted session in place; no prompt is sent.
 *   FORK     — `forkSession` copies the predecessor into a new session id; no
 *              prompt is sent, the body sends the continuation turn.
 *
 * Headless by construction: `hasUI` is false and `ui.notify` writes to stderr.
 * A tool that needs a person (AskUserQuestion) is unavailable to a headless
 * SDK run, so skills take their non-interactive paths.
 */

import { basename } from "node:path";
import type { forkSession as sdkForkSession, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
	BranchEntry,
	ModelSelection,
	WorkflowHostContext,
	WorkflowSessionContext,
} from "@juicesharp/rpiv-workflow";
import { type SkillCatalog, translateSkillPrompt } from "./skills.js";
import {
	assistantEntry,
	locateSessionFile,
	readSessionBranch,
	stampStop,
	stopReasonForResult,
	userEntry,
} from "./transcript.js";

type Options = NonNullable<Parameters<typeof sdkQuery>[0]["options"]>;
type PermissionMode = NonNullable<Options["permissionMode"]>;
type Effort = NonNullable<Options["effort"]>;
type SpawnOptions<T> = Omit<Parameters<WorkflowHostContext["spawnChild"]>[0], "withSession"> & {
	withSession: (child: WorkflowSessionContext) => Promise<T>;
};

export interface ClaudeHostDeps {
	query: typeof sdkQuery;
	forkSession: typeof sdkForkSession;
}

export interface ClaudeHostOptions {
	cwd: string;
	pluginDir: string;
	catalog: SkillCatalog;
	permissionMode: PermissionMode;
	maxConcurrency: number;
	/** Model for every stage unless the workflow's own selection names one. */
	model?: string;
	signal?: AbortSignal;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
	/** Override session-file lookup (tests). */
	locate?: (sessionId: string) => string | undefined;
}

const EFFORT: Record<NonNullable<ModelSelection["thinking"]>, Effort> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/**
 * Pi model keys are `provider/modelId`. Claude Code runs Anthropic models only,
 * so an `anthropic/` key loses its prefix, a bare id or alias passes through,
 * and any other provider fails the stage rather than silently swapping models.
 */
export function claudeModel(key: string): string {
	const slash = key.indexOf("/");
	if (slash === -1) return key;
	const provider = key.slice(0, slash);
	if (provider !== "anthropic") throw new Error(`rpiv-claude: model "${key}" is not an Anthropic model`);
	return key.slice(slash + 1);
}

/**
 * Variables that pin a Claude Code process to an EXISTING session. Set when
 * rpiv-wf itself runs inside Claude Code (an agent's Bash tool, a cloud
 * session); inherited by the SDK's child process, they make every stage resume
 * the launcher's own session instead of opening its own. Observed: two stages
 * of one run sharing the launcher's session id and transcript file.
 */
export const INHERITED_SESSION_VARS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID"] as const;

/** The child process environment: the launcher's, minus its session identity. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "rpiv-claude" };
	for (const name of INHERITED_SESSION_VARS) delete out[name];
	return out;
}

function emptySessionManager() {
	return { getBranch: () => [], getSessionId: () => "", getSessionFile: () => undefined };
}

export class ClaudeWorkflowHost implements WorkflowHostContext {
	readonly cwd: string;
	readonly hasUI = false;
	readonly maxConcurrency: number;
	readonly signal?: AbortSignal;
	readonly ui: WorkflowHostContext["ui"];
	readonly sessionManager = emptySessionManager();

	constructor(
		private readonly opts: ClaudeHostOptions,
		private readonly deps: ClaudeHostDeps,
	) {
		this.cwd = opts.cwd;
		this.maxConcurrency = opts.maxConcurrency;
		this.signal = opts.signal;
		const notify = opts.notify ?? ((m: string, l = "info") => process.stderr.write(`[rpiv-wf ${l}] ${m}\n`));
		this.ui = { notify };
	}

	async waitForIdle(): Promise<void> {}

	async spawnChild<T>(options: SpawnOptions<T>): Promise<T> {
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		for (const s of [options.signal, this.signal]) {
			if (s?.aborted) abort.abort();
			s?.addEventListener("abort", onAbort, { once: true });
		}
		const child = new ClaudeChildSession(this, this.opts, this.deps, options.model, abort);
		try {
			if (options.reattach) {
				const file = options.reattach.sessionFile;
				child.adopt(basename(file, ".jsonl"), file, file);
			} else if (options.fork) {
				const source = basename(options.fork.sessionFile, ".jsonl");
				const { sessionId } = await this.deps.forkSession(source, { dir: this.cwd });
				// The fork's prefix is the source transcript; its own file is located by
				// id, never assumed to be the source's (that would point resume at the predecessor).
				child.adopt(sessionId, options.fork.sessionFile, this.locate(sessionId));
			} else {
				await child.sendUserMessage(options.prompt);
			}
			return await options.withSession(child);
		} finally {
			for (const s of [options.signal, this.signal]) s?.removeEventListener("abort", onAbort);
		}
	}

	locate(sessionId: string): string | undefined {
		return this.opts.locate ? this.opts.locate(sessionId) : locateSessionFile(sessionId, undefined, this.cwd);
	}
}

class ClaudeChildSession implements WorkflowSessionContext {
	readonly cwd: string;
	readonly hasUI = false;
	readonly maxConcurrency: number;
	readonly ui: WorkflowHostContext["ui"];
	readonly signal: AbortSignal;
	readonly sessionManager: WorkflowHostContext["sessionManager"];
	private sessionId: string | undefined;
	private sessionFile: string | undefined;
	private readonly branch: BranchEntry[] = [];
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly parent: ClaudeWorkflowHost,
		private readonly opts: ClaudeHostOptions,
		private readonly deps: ClaudeHostDeps,
		private readonly model: ModelSelection | undefined,
		private readonly abort: AbortController,
	) {
		this.cwd = parent.cwd;
		this.maxConcurrency = parent.maxConcurrency;
		this.ui = parent.ui;
		this.signal = abort.signal;
		this.sessionManager = {
			getBranch: () => this.branch,
			getSessionId: () => this.sessionId ?? "",
			getSessionFile: () => {
				if (!this.sessionFile && this.sessionId) this.sessionFile = this.parent.locate(this.sessionId);
				return this.sessionFile;
			},
		};
	}

	/**
	 * Bind to an existing persisted session and load `transcript` as the branch
	 * prefix. Reattach owns that file; a fork passes its own file (or undefined,
	 * resolved lazily by id) separately.
	 */
	adopt(sessionId: string, transcript: string, ownFile: string | undefined): void {
		this.sessionId = sessionId;
		this.sessionFile = ownFile;
		this.branch.push(...(readSessionBranch(transcript) ?? []));
	}

	spawnChild<T>(options: SpawnOptions<T>): Promise<T> {
		return this.parent.spawnChild(options);
	}

	/** Queue a turn; `waitForIdle` settles it. Never rejects: failures land in the branch as a stop reason. */
	async sendUserMessage(content: string): Promise<void> {
		this.queue = this.queue.then(() => this.turn(content));
	}

	async waitForIdle(): Promise<void> {
		let current: Promise<void>;
		do {
			current = this.queue;
			await current;
		} while (current !== this.queue);
	}

	private options(): Options {
		const selected = this.model?.model ?? this.opts.model;
		return {
			cwd: this.cwd,
			env: childEnv(),
			abortController: this.abort,
			plugins: [{ type: "local", path: this.opts.pluginDir }],
			settingSources: ["user", "project", "local"],
			permissionMode: this.opts.permissionMode,
			...(this.opts.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
			...(selected ? { model: claudeModel(selected) } : {}),
			...(this.model?.thinking ? { effort: EFFORT[this.model.thinking] } : {}),
			...(this.sessionId ? { resume: this.sessionId } : {}),
		};
	}

	private async turn(prompt: string): Promise<void> {
		const start = this.branch.length;
		this.branch.push(userEntry(prompt));
		if (this.abort.signal.aborted) {
			stampStop(this.branch, "aborted", start);
			return;
		}
		try {
			const options = this.options();
			const run = this.deps.query({ prompt: translateSkillPrompt(prompt, this.opts.catalog), options });
			for await (const msg of run) {
				if ("session_id" in msg && typeof msg.session_id === "string" && msg.session_id) {
					if (msg.session_id !== this.sessionId) this.sessionFile = undefined;
					this.sessionId = msg.session_id;
				}
				if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
					this.branch.push(assistantEntry(msg.message.content));
				} else if (msg.type === "result") {
					stampStop(this.branch, stopReasonForResult(msg), start);
					if (msg.subtype !== "success") this.ui.notify(`stage turn ended: ${msg.subtype}`, "warning");
				}
			}
			if (this.abort.signal.aborted) stampStop(this.branch, "aborted", start);
		} catch (err) {
			const aborted = this.abort.signal.aborted;
			if (!aborted) this.ui.notify(`Claude session error: ${String(err)}`, "error");
			stampStop(this.branch, aborted ? "aborted" : "error", start);
		}
	}
}
