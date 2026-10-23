/**
 * Siblings loaded OUTSIDE the settings file are detected (#216) — a REAL Pi
 * session, no mocks. A kit (here: settings that list only the kit) bundles
 * siblings as extension resources, so Pi loads them by path; the settings-only
 * rule reported them missing, and /rpiv-setup then installed conflicting copies.
 * A probe extension takes the snapshot at session_start, exactly where
 * rpiv-core's startup maintenance takes it. Runs unchanged on Pi 0.80.x and 1.x.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInstalledSiblings, findMissingSiblings, type LoadedSiblingSources } from "./package-checks.ts";
import { getPiAgentSettingsPath } from "./utils.ts";

const PACKAGES = fileURLToPath(new URL("../../../", import.meta.url));
const sibling = (dir: string) => join(PACKAGES, dir);
const ARGS_MARKER = Symbol.for("@juicesharp/rpiv-args:loaded");
const PROBE_SLOT = Symbol.for("rpiv-216-probe");

describe("siblings loaded outside the settings file are found (#216)", () => {
	let cwd: string;
	let prevOffline: string | undefined;

	beforeEach(() => {
		// The marker is process-global: clear one another test file may have left.
		delete (globalThis as Record<symbol, unknown>)[ARGS_MARKER];
		cwd = mkdtempSync(join(tmpdir(), "rpiv-216-"));
		prevOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		const settings = getPiAgentSettingsPath();
		mkdirSync(dirname(settings), { recursive: true });
		writeFileSync(join(dirname(settings), "auth.json"), "{}");
		// The kit is the only declared package; its bundled siblings load by path.
		writeFileSync(settings, JSON.stringify({ packages: ["npm:frida-pi-studio"] }));
	});

	afterEach(() => {
		if (prevOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prevOffline;
		delete (globalThis as Record<symbol, unknown>)[ARGS_MARKER];
		delete (globalThis as Record<symbol, unknown>)[PROBE_SLOT];
		rmSync(cwd, { recursive: true, force: true });
	});

	async function snapshotWith(extensionPaths: string[]): Promise<LoadedSiblingSources> {
		// No model: binding extensions fires session_start, which is all the probe needs —
		// and keeps this test free of the model API that differs between Pi 0.80 and 1.x.
		const agentDir = dirname(getPiAgentSettingsPath());
		const settingsManager = SettingsManager.create(cwd, agentDir);
		// The probe is an extension FILE loaded by path (the same way as the siblings) —
		// factory objects differ between Pi 0.80 and 1.x. It hands its session_start
		// snapshot back through a globalThis slot.
		const probe = join(cwd, "probe-extension.ts");
		writeFileSync(
			probe,
			`import { readLoadedSiblingSources } from ${JSON.stringify(fileURLToPath(new URL("./loaded-siblings.ts", import.meta.url)))};
export default function (pi) {
	pi.on("session_start", () => {
		globalThis[Symbol.for("rpiv-216-probe")] = readLoadedSiblingSources(pi);
	});
}
`,
		);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [...extensionPaths, probe],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		await session.bindExtensions({});
		session.dispose();
		const snapshot = (globalThis as Record<symbol, unknown>)[PROBE_SLOT] as LoadedSiblingSources | undefined;
		if (!snapshot) throw new Error("session_start never fired");
		return snapshot;
	}

	const names = (list: { pkg: string }[]) => list.map((s) => s.pkg.replace(/^npm:/, ""));

	it("tool-, command- and marker-only siblings loaded by path are not reported missing", async () => {
		const snapshot = await snapshotWith([sibling("rpiv-todo"), sibling("rpiv-workflow"), sibling("rpiv-args")]);
		const missing = names(findMissingSiblings(snapshot));
		expect(missing).not.toContain("@juicesharp/rpiv-todo"); // tool + command
		expect(missing).not.toContain("@juicesharp/rpiv-workflow"); // command only
		expect(missing).not.toContain("@juicesharp/rpiv-args"); // event hooks only → marker
		expect(missing).toContain("@juicesharp/rpiv-advisor"); // genuinely absent
		expect(names(findInstalledSiblings(snapshot)).sort()).toEqual([
			"@juicesharp/rpiv-args",
			"@juicesharp/rpiv-todo",
			"@juicesharp/rpiv-workflow",
		]);
	});

	it("nothing bundled: the kit alone leaves every sibling missing (unchanged)", async () => {
		const snapshot = await snapshotWith([]);
		expect(names(findMissingSiblings(snapshot))).toEqual(names(findMissingSiblings()));
		expect(findInstalledSiblings(snapshot)).toEqual([]);
	});
});
