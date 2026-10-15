// export-hosts.ts — render rpiv-pi's skills and subagents for harnesses other than Pi.
//
//   node packages/rpiv-pi/scripts/export-hosts.ts --write   regenerate packages/rpiv-pi/hosts/
//   node packages/rpiv-pi/scripts/export-hosts.ts --check   exit 1 when hosts/ drifts from skills/ + agents/
//
// SOURCE OF TRUTH
//   skills/ and agents/ stay Pi-native and are the only files anyone edits. Everything
//   under hosts/ (plus the repo-root .claude-plugin/marketplace.json) is generated and
//   committed, so a harness can install straight from git. `--check` runs in CI.
//
// HOSTS
//   claude — a Claude Code plugin named `rpiv` (skills, agents, marketplace entry).
//            rpiv-args already mirrors Claude's `$ARGUMENTS` and `!` block syntax, so the
//            rewrite is narrow: skill-dir variable, `/skill:` invocations, tool names, and
//            the plugin namespace on subagent names.
//   agents — a portable Agent Skills pack (Codex, OpenCode, Factory, Cursor, Pi, ...):
//            frontmatter cut to the spec's name + description, `!` blocks turned into
//            "run this first" steps, and a short preamble naming what a harness may lack.
//
// FAIL CLOSED
//   An unknown agent tool, an unknown `/skill:` target, or a positional `$N` placeholder
//   (1-based in rpiv-args, 0-based in Claude) throws instead of rendering something that
//   silently means a different thing.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${SKILL_DIR}-style strings here are literal shell variables, not templates.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_NAME = "rpiv";
/** Publisher of the marketplace in this repo; the plugin's author stays the package author. */
const MARKETPLACE_OWNER = "ethicalcapital";
const PLUGIN_DESCRIPTION =
	"The rpiv skill pipeline (discover → research → design → plan → implement → validate → code-review → commit, and more) and the subagents it dispatches, exported from rpiv-pi. Run /wf workflows on Claude Code with rpiv-claude.";
export type HostId = "claude" | "agents";
export const HOSTS: readonly HostId[] = ["claude", "agents"];

const SKILL_KEYS: Record<HostId, readonly string[]> = {
	claude: ["name", "description", "argument-hint", "allowed-tools", "disable-model-invocation"],
	agents: ["name", "description"],
};

/** Pi tool name → Claude Code tool name. `ls` has no Claude twin; Glob covers listing. */
const CLAUDE_TOOLS: Record<string, string> = {
	read: "Read",
	grep: "Grep",
	find: "Glob",
	ls: "Glob",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
	"ext:rpiv-web-tools/web_search": "WebSearch",
	"ext:rpiv-web-tools/web_fetch": "WebFetch",
};

const AGENTS_PREAMBLE = `> **Portable build of an rpiv skill.** \`\${SKILL_DIR}\` is the directory holding this SKILL.md; \`$ARGUMENTS\` is the text passed when the skill was invoked. Named subagents are in this pack's \`agents/\` folder; if your harness cannot dispatch subagents, do their work inline. If a tool named here is missing (\`ask_user_question\`, \`advisor\`, a todo list), ask the user in chat, skip the advisor step, or keep a checklist in your reply.`;

export interface Frontmatter {
	keys: Map<string, string>;
	body: string;
}

/** Split `---` frontmatter into raw top-level blocks (key → its lines, verbatim) and the body. */
export function splitFrontmatter(text: string): Frontmatter {
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (!match) throw new Error("missing frontmatter");
	const keys = new Map<string, string>();
	let current: string | undefined;
	for (const line of match[1].split("\n")) {
		const key = /^([A-Za-z][\w-]*):/.exec(line);
		if (key) {
			current = key[1];
			keys.set(current, line);
		} else if (current) {
			keys.set(current, `${keys.get(current)}\n${line}`);
		}
	}
	return { keys, body: text.slice(match[0].length) };
}

function joinFrontmatter(blocks: string[], body: string): string {
	return `---\n${blocks.join("\n")}\n---\n${body}`;
}

function pick(fm: Frontmatter, allowed: readonly string[]): string[] {
	return allowed.flatMap((k) => (fm.keys.has(k) ? [fm.keys.get(k)!] : []));
}

export interface Catalog {
	skills: ReadonlySet<string>;
	agents: ReadonlySet<string>;
}

/** Rewrites shared by skill and agent bodies. */
export function transformBody(body: string, host: HostId, catalog: Catalog, label: string): string {
	if (host === "claude" && /\$(\d|\{@)/.test(body)) {
		throw new Error(`${label}: positional placeholder has different numbering in Claude Code; use $ARGUMENTS`);
	}
	let out = body.replace(/\/skill:([a-z0-9-]+)/g, (_m, name: string) => {
		if (!catalog.skills.has(name)) throw new Error(`${label}: /skill:${name} names no skill`);
		return host === "claude" ? `/${PLUGIN_NAME}:${name}` : `/${name}`;
	});
	out = out
		.replaceAll("${CWD}", "$PWD")
		.replaceAll("node scripts/migrate.js", 'node "${PACK_ROOT}/scripts/migrate.js"');
	if (host === "claude") {
		out = out
			.replaceAll("${SKILL_DIR}", "${CLAUDE_SKILL_DIR}")
			.replaceAll("${PACK_ROOT}", "${CLAUDE_PLUGIN_ROOT}")
			.replaceAll("ask_user_question", "AskUserQuestion")
			.replace(/(`|subagent_type: ")([a-z0-9-]+)(`|")/g, (m, open: string, name: string, close: string) =>
				catalog.agents.has(name) ? `${open}${PLUGIN_NAME}:${name}${close}` : m,
			);
	} else {
		out = out
			.replaceAll("${PACK_ROOT}", "${SKILL_DIR}/../..")
			.replace(/^```!\n/gm, "Run these commands first and use their output as the context below:\n\n```bash\n");
	}
	return out;
}

/**
 * Claude Code permission-checks every command in a ```! block before the skill loads, and a
 * denied one aborts the skill. Grant each `node` helper line exactly; read-only commands
 * (echo, git log) pass the check on their own.
 */
export function bangGrants(body: string): string[] {
	const grants = new Set<string>();
	for (const block of body.matchAll(/^```!\n([\s\S]*?)^```/gm)) {
		for (const line of block[1].split("\n")) {
			if (line.startsWith("node ")) grants.add(`Bash(${line.trim()})`);
		}
	}
	return [...grants];
}

export function transformSkill(text: string, host: HostId, catalog: Catalog, label: string): string {
	const fm = splitFrontmatter(text);
	let body = transformBody(fm.body, host, catalog, label);
	if (host === "agents") body = `\n${AGENTS_PREAMBLE}\n${body}`;
	const blocks = pick(fm, SKILL_KEYS[host]);
	const grants = host === "claude" ? bangGrants(body) : [];
	if (grants.length > 0) {
		const i = blocks.findIndex((b) => b.startsWith("allowed-tools:"));
		if (i === -1) blocks.push(`allowed-tools: ${grants.join(", ")}`);
		else blocks[i] = `${blocks[i]}, ${grants.join(", ")}`;
	}
	return joinFrontmatter(blocks, body);
}

export function transformAgent(text: string, host: HostId, catalog: Catalog, label: string): string {
	const fm = splitFrontmatter(text);
	const blocks = pick(fm, ["name", "description"]);
	let body = transformBody(fm.body, host, catalog, label);
	if (host === "claude") {
		const raw = fm.keys.get("tools")?.replace(/^tools:/, "") ?? "";
		const tools = raw
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => {
				const mapped = CLAUDE_TOOLS[t];
				if (!mapped) throw new Error(`${label}: no Claude Code tool for "${t}"`);
				return mapped;
			});
		if (tools.length > 0) blocks.push(`tools: ${[...new Set(tools)].join(", ")}`);
		body = body.replace(/`(read|grep|find|ls|bash|edit|write)`/g, (_m, t: string) => `\`${CLAUDE_TOOLS[t]}\``);
	}
	return joinFrontmatter(blocks, body);
}

/** Every file under `dir`, as posix paths relative to it, test files excluded. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir).sort()) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) {
			for (const child of walk(abs)) out.push(`${entry}/${child}`);
		} else if (!entry.endsWith(".test.ts")) {
			out.push(entry);
		}
	}
	return out;
}

export interface Paths {
	repoRoot: string;
	pkgRoot: string;
}

export function defaultPaths(): Paths {
	const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	return { pkgRoot, repoRoot: dirname(dirname(pkgRoot)) };
}

const HOSTS_DIR = "hosts";
const MARKETPLACE = ".claude-plugin/marketplace.json";

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/** Render every generated file: repo-root-relative posix path → content. */
export function render(paths: Paths): Map<string, string> {
	const { pkgRoot, repoRoot } = paths;
	const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
	const skillDirs = readdirSync(join(pkgRoot, "skills"))
		.filter((d) => existsSync(join(pkgRoot, "skills", d, "SKILL.md")))
		.sort();
	const agentFiles = readdirSync(join(pkgRoot, "agents"))
		.filter((f) => f.endsWith(".md"))
		.sort();
	const catalog: Catalog = {
		skills: new Set(skillDirs),
		agents: new Set(agentFiles.map((f) => f.replace(/\.md$/, ""))),
	};
	const pkgRel = relative(repoRoot, pkgRoot).split(sep).join("/");
	const files = new Map<string, string>();

	for (const host of HOSTS) {
		const base = `${pkgRel}/${HOSTS_DIR}/${host}`;
		for (const rel of walk(join(pkgRoot, "skills"))) {
			const src = readFileSync(join(pkgRoot, "skills", rel), "utf8");
			const isSkill = rel.endsWith("/SKILL.md") && catalog.skills.has(rel.split("/")[0]);
			files.set(`${base}/skills/${rel}`, isSkill ? transformSkill(src, host, catalog, `skills/${rel}`) : src);
		}
		for (const file of agentFiles) {
			const src = readFileSync(join(pkgRoot, "agents", file), "utf8");
			files.set(`${base}/agents/${file}`, transformAgent(src, host, catalog, `agents/${file}`));
		}
		files.set(`${base}/scripts/migrate.js`, readFileSync(join(pkgRoot, "scripts", "migrate.js"), "utf8"));
	}

	files.set(
		`${pkgRel}/${HOSTS_DIR}/claude/.claude-plugin/plugin.json`,
		json({
			name: PLUGIN_NAME,
			version: pkg.version,
			description: PLUGIN_DESCRIPTION,
			author: { name: pkg.author },
			license: pkg.license,
			repository: pkg.repository?.url,
		}),
	);
	files.set(
		MARKETPLACE,
		json({
			name: PLUGIN_NAME,
			owner: { name: MARKETPLACE_OWNER },
			description: "rpiv skills and subagents for Claude Code.",
			plugins: [{ name: PLUGIN_NAME, source: `./${pkgRel}/${HOSTS_DIR}/claude`, description: PLUGIN_DESCRIPTION }],
		}),
	);
	return files;
}

/** Paths that differ between the render and disk, including stale files under hosts/. */
export function diff(paths: Paths, files: Map<string, string>): string[] {
	const drift: string[] = [];
	for (const [rel, content] of files) {
		const abs = join(paths.repoRoot, rel);
		if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) drift.push(rel);
	}
	const hostsRoot = join(paths.pkgRoot, HOSTS_DIR);
	if (existsSync(hostsRoot)) {
		const pkgRel = relative(paths.repoRoot, paths.pkgRoot).split(sep).join("/");
		for (const rel of walkAll(hostsRoot)) {
			const key = `${pkgRel}/${HOSTS_DIR}/${rel}`;
			if (!files.has(key)) drift.push(`${key} (stale)`);
		}
	}
	return drift;
}

function walkAll(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const abs = join(dir, entry);
		return statSync(abs).isDirectory() ? walkAll(abs).map((c) => `${entry}/${c}`) : [entry];
	});
}

export function write(paths: Paths, files: Map<string, string>): void {
	rmSync(join(paths.pkgRoot, HOSTS_DIR), { recursive: true, force: true });
	for (const [rel, content] of files) {
		const abs = join(paths.repoRoot, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
}

export function run(argv: readonly string[], paths: Paths = defaultPaths(), log = console.error): number {
	const mode = argv[0];
	if (mode !== "--write" && mode !== "--check") {
		log("usage: export-hosts.ts --write | --check");
		return 2;
	}
	const files = render(paths);
	if (mode === "--write") {
		write(paths, files);
		log(`export-hosts: wrote ${files.size} files for ${HOSTS.join(", ")}`);
		return 0;
	}
	const drift = diff(paths, files);
	if (drift.length === 0) return 0;
	log(`export-hosts: ${drift.length} generated file(s) out of date:`);
	for (const d of drift) log(`  ${d}`);
	log("Edit skills/ or agents/, then run: npm run export:hosts");
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(run(process.argv.slice(2)));
}
