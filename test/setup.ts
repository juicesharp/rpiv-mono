import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { beforeEach, vi } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "rpiv-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: vi.fn(),
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

const ADVISOR_SYMBOL = Symbol.for("rpiv-advisor");
const BTW_SYMBOL = Symbol.for("rpiv-btw");
const I18N_SYMBOL = Symbol.for("rpiv-i18n");
const VOICE_SYMBOL = Symbol.for("rpiv-voice");

// Package modules are imported dynamically inside beforeEach (NOT statically at
// the top of this file) by deliberate design — DO NOT "optimize" by hoisting.
//
// Two failure modes that hoisting re-introduces:
//
// 1. Real-homedir leak: ES module spec hoists `import` statements above all
//    other top-level statements. If these imports were static here they would
//    execute BEFORE `process.env.HOME = TEST_HOME` above, so production
//    modules' `homedir()` captures would resolve to the developer's REAL
//    $HOME — silently reading/writing actual ~/.config/* files during tests.
//
// 2. vi.mock bypass: many test files register `vi.mock("node:fs")` (or other
//    transitive mocks) and rely on being the FIRST loader of the package
//    under test. If setup.ts statically imports those packages first, the
//    package's bindings are sealed against unmocked deps and the test's
//    vi.mock never reaches the cached module.
//
// Cost: cold-cache resolution of the 9 dynamic imports below can exceed
// vitest's default 10s hookTimeout on the very first test of a worker. The
// hookTimeout is therefore raised in vitest.config.ts. The cost is paid once
// per worker; subsequent tests reuse the module cache and beforeEach is fast.
beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;

	const todo = await import("../packages/rpiv-todo/todo.js");
	todo.__resetState();

	const advisor = await import("../packages/rpiv-advisor/advisor/index.js");
	advisor.setAdvisorModel(undefined);
	advisor.setAdvisorEffort(undefined);
	advisor.setDisabledForModels([]);
	advisor.__resetAdvisorAnnounced();

	const args = await import("../packages/rpiv-args/args.js");
	args.invalidateSkillIndex();

	const workflowInternal = await import("@juicesharp/rpiv-workflow/internal");
	workflowInternal.__resetBuiltIns();
	workflowInternal.__resetLoadCache();
	workflowInternal.__resetLifecycleRegistry();
	workflowInternal.__resetSkillContracts();
	workflowInternal.__resetWorkflowExecutionHost();

	const guidance = await import("../packages/rpiv-pi/extensions/rpiv-core/guidance.js");
	guidance.clearInjectionState();
	const gitContext = await import("../packages/rpiv-pi/extensions/rpiv-core/git-context.js");
	gitContext.clearGitContextCache();
	gitContext.resetInjectedMarker();
	const sessionHooks = await import("../packages/rpiv-pi/extensions/rpiv-core/session-hooks.js");
	sessionHooks.__resetSessionHooksAnnounced();
	const sessionCapture = await import("../packages/rpiv-pi/extensions/rpiv-core/session-capture.js");
	sessionCapture.__resetSessionCaptureState();
	const runLaneRegistry = await import("../packages/rpiv-pi/extensions/rpiv-core/run-lane-registry.js");
	runLaneRegistry.__resetRunLaneRegistry();
	const laneSwitcher = await import("../packages/rpiv-pi/extensions/rpiv-core/lane-switcher.js");
	laneSwitcher.__resetLaneSwitcher();
	const laneProgress = await import("../packages/rpiv-pi/extensions/rpiv-core/lane-progress.js");
	laneProgress.__resetLaneProgress();
	const skillBracket = await import("../packages/rpiv-pi/extensions/rpiv-core/skill-bracket.js");
	skillBracket.__resetSkillBracketState();
	const modelsConfigModule = await import("../packages/rpiv-pi/extensions/rpiv-core/models-config.js");
	modelsConfigModule.invalidateModelsConfigCache();
	const modelsConfigValidate = await import("../packages/rpiv-pi/extensions/rpiv-core/models-config-validate.js");
	modelsConfigValidate.__resetModelsConfigValidation();

	const titleSpinner = await import("../packages/rpiv-warp/title-spinner.js");
	titleSpinner.__resetState();

	const warpIndex = await import("../packages/rpiv-warp/index.js");
	warpIndex.__resetState();

	const telemetry = await import("../packages/rpiv-telemetry/instrumentation/index.js");
	telemetry.teardownTelemetry();

	const i18n = await import("../packages/rpiv-i18n/i18n.js");
	i18n.__resetState();

	const voice = await import("../packages/rpiv-voice/config/voice-config.js");
	voice.__resetState();

	const webToolsInterceptors = await import("../packages/rpiv-web-tools/providers/interceptors/index.js");
	webToolsInterceptors.__resetWebToolsInterceptors();

	delete (globalThis as Record<symbol, unknown>)[ADVISOR_SYMBOL];
	delete (globalThis as Record<symbol, unknown>)[BTW_SYMBOL];
	delete (globalThis as Record<symbol, unknown>)[I18N_SYMBOL];
	delete (globalThis as Record<symbol, unknown>)[VOICE_SYMBOL];

	const piAgentSettings = join(process.env.HOME!, ".pi", "agent", "settings.json");
	const xdgPiAgentDir = join(process.env.HOME!, ".config", "pi", "agent");
	const advisorConfig = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
	const i18nConfig = join(process.env.HOME!, ".config", "rpiv-i18n", "locale.json");
	const voiceConfig = join(process.env.HOME!, ".config", "rpiv-voice", "voice.json");
	const voiceErrorsLog = join(process.env.HOME!, ".config", "rpiv-voice", "errors.log");
	const todoConfig = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");
	const askUserQuestionConfig = join(process.env.HOME!, ".config", "rpiv-ask-user-question", "config.json");
	const webToolsConfig = configPath("rpiv-web-tools");
	const modelsConfig = configPath("rpiv-pi", "models.json");
	rmSync(piAgentSettings, { force: true });
	rmSync(xdgPiAgentDir, { recursive: true, force: true });
	rmSync(advisorConfig, { force: true });
	rmSync(i18nConfig, { force: true });
	rmSync(voiceConfig, { force: true });
	rmSync(voiceErrorsLog, { force: true });
	rmSync(todoConfig, { force: true });
	rmSync(askUserQuestionConfig, { force: true });
	rmSync(webToolsConfig, { force: true });
	rmSync(modelsConfig, { force: true, recursive: true });

	const telemetryConfig = join(process.env.HOME!, ".config", "rpiv-telemetry", "config.json");
	rmSync(telemetryConfig, { force: true });

	// User overlay for `/wf` workflows: canonical file at
	// `~/.config/rpiv-workflow/workflows.config.ts` plus a drop-in directory
	// at `~/.config/rpiv-workflow/workflows/`. Tests that exercise the
	// project overlay by writing under `<cwd>/.rpiv-workflow/` MUST clean it
	// themselves in their own afterEach — the project root is per-cwd and
	// not knowable here.
	const workflowUserRoot = join(process.env.HOME!, ".config", "rpiv-workflow");
	rmSync(workflowUserRoot, { recursive: true, force: true });

	// Clean global agent dir parent (`~/.pi/agent/`) — not just `~/.pi/agent/agents/` —
	// so tests that place a regular file at `~/.pi/agent` can write into a
	// clean slot, and so no test inherits an empty-dir residue from a prior worker run.
	const globalAgentDir = join(process.env.HOME!, ".pi", "agent");
	rmSync(globalAgentDir, { recursive: true, force: true });
});
