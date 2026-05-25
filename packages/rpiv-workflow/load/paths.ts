/**
 * Overlay file system paths for the user and project layers.
 *
 *   user    — canonical `~/.config/rpiv-workflow/workflows.config.ts`
 *             drop-ins  `~/.config/rpiv-workflow/workflows/*.ts`
 *   project — canonical `<cwd>/.rpiv-workflow/workflows.config.ts`
 *             drop-ins  `<cwd>/.rpiv-workflow/workflows/*.ts`
 */

import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";

export interface OverlayPaths {
	/** Canonical file — the only place `default` may live. */
	canonical: string;
	/** Drop-in directory — alpha-sorted `*.ts` files merged before canonical. */
	dropInDir: string;
}

/** Project overlay paths under `<cwd>/.rpiv-workflow/`. */
export function projectOverlayPaths(cwd: string): OverlayPaths {
	const root = join(cwd, ".rpiv-workflow");
	return { canonical: join(root, "workflows.config.ts"), dropInDir: join(root, "workflows") };
}

/** User overlay paths under `~/.config/rpiv-workflow/`. */
export function userOverlayPaths(): OverlayPaths {
	return {
		canonical: configPath("rpiv-workflow", "workflows.config.ts"),
		dropInDir: configPath("rpiv-workflow", "workflows"),
	};
}
