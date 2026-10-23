// Compare published package layouts in fresh Pi processes; no model calls or installs.
// node scripts/benchmark-ask-user-question-startup.mjs --baseline HEAD --runs 15
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		baseline: { type: "string", default: "HEAD" },
		pi: { type: "string", default: "pi" },
		runs: { type: "string", default: "15" },
		"with-i18n": { type: "boolean", default: false },
	},
});
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 3) throw new Error("--runs must be an integer >= 3");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = "packages/rpiv-ask-user-question";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const baseline = execFileSync("git", ["rev-parse", "--verify", `${values.baseline}^{commit}`], {
	cwd: root,
	encoding: "utf8",
}).trim();
const temporary = mkdtempSync(join(tmpdir(), "rpiv-startup-"));

function run(command, args, options = {}) {
	return execFileSync(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000, ...options });
}

function unpackPackage(source, destination) {
	mkdirSync(destination, { recursive: true });
	const [packed] = JSON.parse(
		run(npm, ["pack", "--ignore-scripts", "--workspaces=false", "--json", "--pack-destination", temporary], {
			cwd: source,
			encoding: "utf8",
		}),
	);
	run("tar", ["-xf", join(temporary, packed.filename), "--strip-components=1", "-C", destination]);
}

function summarize(samples, field) {
	const sorted = samples.map((sample) => sample[field]).sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	return { median: Number(median.toFixed(2)), min: sorted[0], max: sorted.at(-1) };
}

try {
	const snapshot = join(temporary, "snapshot");
	mkdirSync(snapshot);
	run("tar", ["-xf", "-", "-C", snapshot], {
		input: run("git", ["archive", baseline, packagePath], { cwd: root }),
	});
	const dependencies = join(temporary, "dependencies");
	unpackPackage(join(root, "packages/rpiv-config"), join(dependencies, "@juicesharp/rpiv-config"));
	if (values["with-i18n"]) {
		unpackPackage(join(root, "packages/rpiv-i18n"), join(dependencies, "@juicesharp/rpiv-i18n"));
	}
	const variants = ["baseline", "candidate"];
	for (const variant of variants) {
		const source = variant === "baseline" ? join(snapshot, packagePath) : join(root, packagePath);
		const destination = join(temporary, variant);
		unpackPackage(source, destination);
		cpSync(dependencies, join(destination, "node_modules"), { recursive: true });
	}

	// Do not discover user settings, credentials, project files, or extensions.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !/^(PI_|JITI_|NODE_OPTIONS$|NODE_PATH$)/.test(key)),
	);
	env.HOME = env.USERPROFILE = join(temporary, "home");
	env.XDG_CONFIG_HOME = join(env.HOME, ".config");
	env.PI_CODING_AGENT_DIR = join(env.HOME, ".pi/agent");
	env.PI_TIMING = "1";
	env.PI_TELEMETRY = "0";
	mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
	const samples = { baseline: [], candidate: [] };
	const warmups = 2;
	for (let round = 0; round < runs + warmups; round++) {
		// Alternate order to reduce bias from cache warming and machine drift.
		for (const variant of round % 2 ? [...variants].reverse() : variants) {
			const entry = join(temporary, variant, "index.ts");
			const start = performance.now();
			const result = spawnSync(
				values.pi,
				[
					"--offline",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-themes",
					"--no-context-files",
					"--no-prompt-templates",
					"--no-approve",
					"-e",
					entry,
					"-p",
				],
				{ cwd: temporary, env, input: "", encoding: "utf8", timeout: 30_000 },
			);
			const wallMs = performance.now() - start;
			const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
			const importMs = output.match(/index\.ts module import: (\d+)ms/);
			const factoryMs = output.match(/index\.ts factory: (\d+)ms/);
			if (
				result.error ||
				result.status !== 0 ||
				!importMs ||
				!factoryMs ||
				/Failed to load extension/.test(output)
			) {
				throw new Error(`${variant} failed: ${result.error ?? output}`);
			}
			if (round >= warmups)
				samples[variant].push({
					importMs: Number(importMs[1]),
					factoryMs: Number(factoryMs[1]),
					wallMs: Number(wallMs.toFixed(2)),
				});
		}
	}
	console.log(
		JSON.stringify(
			{
				baseline,
				pi: run(values.pi, ["--version"], { encoding: "utf8" }).trim(),
				node: process.version,
				platform: `${platform()} ${arch()}`,
				withI18n: values["with-i18n"],
				runs,
				warmups,
				summary: Object.fromEntries(
					variants.map((variant) => [
						variant,
						Object.fromEntries(
							["importMs", "factoryMs", "wallMs"].map((field) => [field, summarize(samples[variant], field)]),
						),
					]),
				),
				samples,
			},
			null,
			2,
		),
	);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
