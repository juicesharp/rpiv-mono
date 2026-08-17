/**
 * claude-code — optional Claude Code subscription backend for advisor().
 *
 * A hand-edited modelKey of `claude-code/claude-opus-5` or
 * `claude-code/claude-fable-5` bypasses Pi's model registry and AuthStorage.
 * Each advisor() call starts a fresh Agent SDK query with tools disabled.
 * The /advisor picker and completeSimple path are unchanged.
 */

import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { Api, Message, Model, StopReason, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";

/** Synthetic provider id for the Claude Code subscription backend. */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** Claude Code model ids accepted as an advisor assignment. */
export const CLAUDE_CODE_MODELS = ["claude-opus-5", "claude-fable-5"] as const;

export type ClaudeCodeModelId = (typeof CLAUDE_CODE_MODELS)[number];

const CLAUDE_CODE_MODEL_SET = new Set<string>(CLAUDE_CODE_MODELS);
const SANITIZED_CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const FALLBACK_CLAUDE_EXECUTABLE = join(homedir(), ".local", "bin", "claude");

export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

export interface ClaudeCodeRuntimeStatus {
	loggedIn: boolean;
	authMethod: string;
	apiProvider: string;
	version: string;
}

export interface ClaudeCodeQueryResult {
	type: "result";
	subtype: string;
	result?: string;
	stop_reason?: string | null;
	errors?: string[];
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	total_cost_usd?: number;
}

export interface ClaudeCodeQueryMessage {
	type: string;
	subtype?: string;
	error?: string;
	original_model?: string;
	fallback_model?: string;
}

export interface ClaudeCodeQuery extends AsyncIterable<ClaudeCodeQueryMessage | ClaudeCodeQueryResult> {
	close(): void;
}

export type ClaudeCodeQueryFactory = (params: {
	prompt: string;
	options: Record<string, unknown>;
}) => ClaudeCodeQuery | Promise<ClaudeCodeQuery>;

export type ClaudeCodeRuntimeInspector = (executable: string) => Promise<ClaudeCodeRuntimeStatus>;

export interface ClaudeCodeConsultDeps {
	queryFactory?: ClaudeCodeQueryFactory;
	runtimeInspector?: ClaudeCodeRuntimeInspector;
	executable?: string;
}

export interface ClaudeCodeAdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

/**
 * True when provider/modelId names an allowed Claude Code advisor assignment.
 * Unknown model ids under the claude-code prefix stay on the registry path.
 */
export function isClaudeCodeAdvisorKey(provider: string, modelId: string): boolean {
	return provider === CLAUDE_CODE_PROVIDER && CLAUDE_CODE_MODEL_SET.has(modelId);
}

/**
 * Maps a persisted advisor effort onto an Agent SDK effort value.
 * Pi's `minimal` level has no SDK equivalent, so it becomes `low`.
 * An unset effort is left unset so Claude Code uses its own default.
 */
export function mapClaudeCodeEffort(effort: ThinkingLevel | undefined): ClaudeCodeEffort | undefined {
	if (effort === undefined) return undefined;
	if (effort === "minimal") return "low";
	return effort;
}

/** Resolves the Claude Code CLI from PATH, then `~/.local/bin/claude`. */
export async function resolveClaudeCodeExecutable(): Promise<string> {
	const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const name of names) {
			const candidate = join(directory, name);
			if (await isExecutable(candidate)) return candidate;
		}
	}
	if (await isExecutable(FALLBACK_CLAUDE_EXECUTABLE)) return FALLBACK_CLAUDE_EXECUTABLE;
	throw new Error("Claude Code advisor requires a `claude` executable on PATH. Install Claude Code and retry.");
}

/**
 * Synthetic Model used so existing advisor state, blocklist, and result
 * labels keep working. It is never looked up in Pi's registry and never
 * passed to completeSimple.
 */
export function claudeCodeAdvisorModel(modelId: ClaudeCodeModelId): Model<Api> {
	return {
		id: modelId,
		name: modelId,
		api: "anthropic-messages",
		provider: CLAUDE_CODE_PROVIDER,
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

/** Runs one isolated Claude Code advisor turn and maps it onto the advisor result envelope. */
export async function consultClaudeCodeAdvisor(input: {
	advisor: Model<Api>;
	effort: ThinkingLevel | undefined;
	messages: Message[];
	cwd: string;
	signal?: AbortSignal;
	deps?: ClaudeCodeConsultDeps;
}): Promise<AgentToolResult<ClaudeCodeAdvisorDetails>> {
	const advisorLabel = `${input.advisor.provider}:${input.advisor.id}`;
	try {
		const result = await runClaudeCodeQuery({
			model: input.advisor.id,
			effort: input.effort,
			messages: input.messages,
			cwd: input.cwd,
			signal: input.signal,
			deps: input.deps,
		});
		const usage = mapClaudeCodeUsage(result);
		if (result.subtype !== "success") {
			const message = result.errors?.join("; ") || result.subtype;
			return buildClaudeCodeResult({
				text: `Advisor call failed: ${message}`,
				effort: input.effort,
				advisorLabel,
				usage,
				stopReason: "error",
				errorMessage: message,
			});
		}
		const text = result.result?.trim() ?? "";
		if (!text) {
			return buildClaudeCodeResult({
				text: "Advisor returned no text content.",
				effort: input.effort,
				advisorLabel,
				usage,
				stopReason: mapClaudeCodeStopReason(result.stop_reason),
				errorMessage: "empty response",
			});
		}
		return buildClaudeCodeResult({
			text,
			effort: input.effort,
			advisorLabel,
			usage,
			stopReason: mapClaudeCodeStopReason(result.stop_reason),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (input.signal?.aborted) {
			return buildClaudeCodeResult({
				text: "Advisor call was cancelled before it completed.",
				effort: input.effort,
				advisorLabel,
				stopReason: "aborted",
				errorMessage: message || "aborted",
			});
		}
		return buildClaudeCodeResult({
			text: `Advisor call threw: ${message}`,
			effort: input.effort,
			advisorLabel,
			errorMessage: message,
		});
	}
}

export function buildClaudeCodeSdkOptions(input: {
	model: string;
	effort: ThinkingLevel | undefined;
	cwd: string;
	executable: string;
	abortController: AbortController;
}): Record<string, unknown> {
	return {
		abortController: input.abortController,
		cwd: input.cwd,
		effort: mapClaudeCodeEffort(input.effort),
		env: sanitizedChildEnvironment(),
		extraArgs: { "disable-slash-commands": null },
		model: input.model,
		pathToClaudeCodeExecutable: input.executable,
		persistSession: false,
		settingSources: [],
		settings: { disableBundledSkills: true, fallbackModel: [] },
		skills: [],
		strictMcpConfig: true,
		systemPrompt: ADVISOR_SYSTEM_PROMPT,
		tools: [],
	};
}

export function validateClaudeCodeRuntime(status: ClaudeCodeRuntimeStatus): void {
	if (!status.loggedIn || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
		throw new Error(
			"Advisor requires an active Claude subscription login. Run `claude auth login --claudeai`, complete browser sign-in, then retry.",
		);
	}
}

export function formatClaudeCodePrompt(messages: Message[]): string {
	return messages.map(formatClaudeCodeMessage).join("\n\n");
}

async function runClaudeCodeQuery(input: {
	model: string;
	effort: ThinkingLevel | undefined;
	messages: Message[];
	cwd: string;
	signal?: AbortSignal;
	deps?: ClaudeCodeConsultDeps;
}): Promise<ClaudeCodeQueryResult> {
	const executable = input.deps?.executable ?? (await resolveClaudeCodeExecutable());
	const inspect = input.deps?.runtimeInspector ?? inspectClaudeCodeRuntime;
	const runtime = await inspect(executable);
	validateClaudeCodeRuntime(runtime);

	const abortController = new AbortController();
	const onAbort = () => abortController.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) abortController.abort();

	let query: ClaudeCodeQuery | undefined;
	try {
		const queryFactory = input.deps?.queryFactory ?? defaultClaudeCodeQueryFactory;
		query = await queryFactory({
			prompt: formatClaudeCodePrompt(input.messages),
			options: buildClaudeCodeSdkOptions({
				model: input.model,
				effort: input.effort,
				cwd: input.cwd,
				executable,
				abortController,
			}),
		});
		for await (const message of query) {
			if (message.type === "system" && message.subtype === "model_refusal_fallback") {
				throw new Error(
					`Advisor attempted model fallback from ${message.original_model} to ${message.fallback_model}`,
				);
			}
			if (message.type === "assistant" && "error" in message && message.error) {
				throw new Error(`Advisor model failed: ${message.error}`);
			}
			if (message.type === "result") return message as ClaudeCodeQueryResult;
		}
		throw new Error("Advisor SDK process exited unexpectedly");
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
		query?.close();
		abortController.abort();
	}
}

async function defaultClaudeCodeQueryFactory(params: {
	prompt: string;
	options: Record<string, unknown>;
}): Promise<ClaudeCodeQuery> {
	const sdk = await loadClaudeAgentSdk();
	return sdk.query(params);
}

async function loadClaudeAgentSdk(): Promise<{
	query: (params: { prompt: string; options: Record<string, unknown> }) => ClaudeCodeQuery;
}> {
	try {
		const specifier = "@anthropic-ai/claude-agent-sdk";
		return (await import(specifier)) as {
			query: (params: { prompt: string; options: Record<string, unknown> }) => ClaudeCodeQuery;
		};
	} catch {
		throw new Error(
			"Claude Code advisor requires the optional @anthropic-ai/claude-agent-sdk dependency. Install it in the same Node environment as rpiv-advisor.",
		);
	}
}

export async function inspectClaudeCodeRuntime(executable: string): Promise<ClaudeCodeRuntimeStatus> {
	const env = sanitizedChildEnvironment();
	const execFileAsync = await loadExecFileAsync();
	const [{ stdout: versionOutput }, auth] = await Promise.all([
		execFileAsync(executable, ["--version"], { env }),
		inspectClaudeAuthStatus(executable, env, execFileAsync),
	]);
	return {
		loggedIn: auth.loggedIn === true,
		authMethod: typeof auth.authMethod === "string" ? auth.authMethod : "",
		apiProvider: typeof auth.apiProvider === "string" ? auth.apiProvider : "",
		version: versionOutput.trim().split(" ")[0] ?? "",
	};
}

type ExecFileAsync = (
	file: string,
	args: readonly string[],
	opts: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

async function loadExecFileAsync(): Promise<ExecFileAsync> {
	const { execFile } = await import("node:child_process");
	return promisify(execFile) as ExecFileAsync;
}

async function inspectClaudeAuthStatus(
	executable: string,
	env: NodeJS.ProcessEnv,
	execFileAsync: ExecFileAsync,
): Promise<Record<string, unknown>> {
	try {
		const { stdout } = await execFileAsync(executable, ["auth", "status", "--json"], { env });
		return JSON.parse(stdout) as Record<string, unknown>;
	} catch (error) {
		const auth = parseLoggedOutClaudeAuthStatus(error);
		if (auth) return auth;
		throw error;
	}
}

function parseLoggedOutClaudeAuthStatus(error: unknown): Record<string, unknown> | undefined {
	if (!isRecord(error) || typeof error.stdout !== "string") return undefined;
	try {
		const auth: unknown = JSON.parse(error.stdout);
		if (
			!isRecord(auth) ||
			auth.loggedIn !== false ||
			typeof auth.authMethod !== "string" ||
			typeof auth.apiProvider !== "string"
		) {
			return undefined;
		}
		return auth;
	} catch {
		return undefined;
	}
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of SANITIZED_CREDENTIALS) delete env[name];
	return env;
}

function formatClaudeCodeMessage(message: Message): string {
	if (message.role === "user") {
		const text = typeof message.content === "string" ? message.content : serializeContent(message.content);
		return `User:\n${text}`;
	}
	if (message.role === "toolResult") {
		return `Tool result (${message.toolName}):\n${serializeContent(message.content)}`;
	}
	return `Assistant:\n${serializeContent(message.content)}`;
}

function serializeContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content);
	return content
		.map((block) => {
			if (!isRecord(block)) return JSON.stringify(block);
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			if (block.type === "toolCall") return `toolCall ${String(block.name)} ${JSON.stringify(block.arguments)}`;
			if (block.type === "image") return `[image ${String(block.mimeType)}]`;
			return JSON.stringify(block);
		})
		.join("\n");
}

function mapClaudeCodeUsage(result: ClaudeCodeQueryResult): Usage | undefined {
	if (!result.usage) return undefined;
	const input = result.usage.input_tokens ?? 0;
	const output = result.usage.output_tokens ?? 0;
	const cacheRead = result.usage.cache_read_input_tokens ?? 0;
	const cacheWrite = result.usage.cache_creation_input_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.total_cost_usd ?? 0 },
	};
}

function mapClaudeCodeStopReason(stopReason: string | null | undefined): StopReason | undefined {
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	if (stopReason === "toolUse" || stopReason === "tool_use") return "toolUse";
	if (stopReason === "length" || stopReason === "max_tokens") return "length";
	if (stopReason == null) return undefined;
	return "stop";
}

function buildClaudeCodeResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<ClaudeCodeAdvisorDetails> {
	const details: ClaudeCodeAdvisorDetails = { advisorModel: opts.advisorLabel, effort: opts.effort };
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}
