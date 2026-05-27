/**
 * Overlay file system paths for the user and project layers.
 *
 *   user    — config `~/.config/rpiv-workflow/workflows.config.ts`
 *             packs  `~/.config/rpiv-workflow/workflows/*.ts`
 *   project — config `<cwd>/.rpiv-workflow/workflows.config.ts`
 *             packs  `<cwd>/.rpiv-workflow/workflows/*.ts`
 */

import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";

export interface OverlayPaths {
	/** Config file — the only place `default` may live. */
	configFile: string;
	/** Packs directory — alpha-sorted `*.ts` files merged before the config file. */
	packsDir: string;
}

/** Project overlay paths under `<cwd>/.rpiv-workflow/`. */
export function projectOverlayPaths(cwd: string): OverlayPaths {
	const root = join(cwd, ".rpiv-workflow");
	return { configFile: join(root, "workflows.config.ts"), packsDir: join(root, "workflows") };
}

/** User overlay paths under `~/.config/rpiv-workflow/`. */
export function userOverlayPaths(): OverlayPaths {
	return {
		configFile: configPath("rpiv-workflow", "workflows.config.ts"),
		packsDir: configPath("rpiv-workflow", "workflows"),
	};
}
