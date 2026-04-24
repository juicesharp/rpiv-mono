import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "rpiv-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
	return {
		...actual,
		completeSimple: vi.fn(),
		supportsXhigh: vi.fn(() => false),
	};
});

const ADVISOR_SYMBOL = Symbol.for("rpiv-advisor");
const BTW_SYMBOL = Symbol.for("rpiv-btw");

beforeEach(async () => {
	const todo = await import("../packages/rpiv-todo/todo.js");
	todo.__resetState();

	const subagentWidget = await import("../packages/rpiv-pi/extensions/subagent-widget/run-tracker.js");
	subagentWidget.__resetState();

	const advisor = await import("../packages/rpiv-advisor/advisor.js");
	advisor.setAdvisorModel(undefined);
	advisor.setAdvisorEffort(undefined);

	const args = await import("../packages/rpiv-args/args.js");
	args.invalidateSkillIndex();

	const guidance = await import("../packages/rpiv-pi/extensions/rpiv-core/guidance.js");
	guidance.clearInjectionState();
	const gitContext = await import("../packages/rpiv-pi/extensions/rpiv-core/git-context.js");
	gitContext.clearGitContextCache();
	gitContext.resetInjectedMarker();

	delete (globalThis as Record<symbol, unknown>)[ADVISOR_SYMBOL];
	delete (globalThis as Record<symbol, unknown>)[BTW_SYMBOL];

	const piAgentSettings = join(process.env.HOME!, ".pi", "agent", "settings.json");
	const advisorConfig = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
	const subagentConfig = join(process.env.HOME!, ".pi", "agent", "extensions", "subagent", "config.json");
	rmSync(piAgentSettings, { force: true });
	rmSync(advisorConfig, { force: true });
	rmSync(subagentConfig, { force: true });
});
