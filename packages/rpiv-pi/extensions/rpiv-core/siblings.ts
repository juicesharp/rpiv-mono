/**
 * Declarative registry of rpiv-pi's sibling Pi plugins.
 *
 * Single source of truth for: presence detection (package-checks.ts),
 * session_start "missing plugins" warning (session-hooks.ts), and
 * /rpiv-setup installer (setup-command.ts). Add a sibling here and every
 * consumer picks it up automatically.
 *
 * Detection is filesystem-based via a regex over ~/.pi/agent/settings.json
 * — no runtime import of sibling packages (keeps rpiv-core pure-orchestrator).
 */

export interface SiblingPlugin {
	/** Install spec passed to `pi install`. Prefixed with `npm:` for Pi's installer. */
	readonly pkg: string;
	/** Case-insensitive regex that matches the package in ~/.pi/agent/settings.json. */
	readonly matches: RegExp;
	/** What the sibling provides — shown in /rpiv-setup confirmation and reports. */
	readonly provides: string;
}

export const SIBLINGS: readonly SiblingPlugin[] = [
	{
		pkg: "npm:@tintinweb/pi-subagents",
		matches: /@tintinweb\/pi-subagents/i,
		provides: "Agent / get_subagent_result / steer_subagent tools",
	},
	{
		pkg: "npm:@juicesharp/rpiv-ask-user-question",
		matches: /rpiv-ask-user-question/i,
		provides: "ask_user_question tool",
	},
	{
		pkg: "npm:@juicesharp/rpiv-todo",
		matches: /rpiv-todo/i,
		provides: "todo tool + /todos command + overlay widget",
	},
	{
		pkg: "npm:@juicesharp/rpiv-advisor",
		matches: /rpiv-advisor/i,
		provides: "advisor tool + /advisor command",
	},
	{
		pkg: "npm:@juicesharp/rpiv-btw",
		matches: /rpiv-btw/i,
		provides: "/btw side-question command",
	},
	{
		pkg: "npm:@juicesharp/rpiv-web-tools",
		matches: /rpiv-web-tools/i,
		provides: "web_search + web_fetch tools + /web-search-config",
	},
	{
		pkg: "npm:@juicesharp/rpiv-args",
		matches: /rpiv-args(?![-\w])/i,
		provides: "skill-argument resolver — substitutes $N/$ARGUMENTS in skill bodies",
	},
];

/**
 * Deprecated sibling packages that `/rpiv-setup` actively prunes from
 * ~/.pi/agent/settings.json (so upgraders don't end up with superseded
 * libraries loaded alongside their replacements). Single source of truth
 * for `prune-legacy-siblings.ts`.
 */
export interface LegacyPackage {
	/** Human-readable label used in the prune notify message. */
	readonly label: string;
	/** Case-insensitive regex matched against settings.json `packages[]` entries. */
	readonly matches: RegExp;
	/** Short reason — useful when debugging; not user-facing. */
	readonly reason: string;
}

export const LEGACY_SIBLINGS: readonly LegacyPackage[] = [
	{
		// nicobailon's pi-subagents fork was the SIBLINGS[0] package between
		// rpiv-pi 0.12.0 and 0.13.x. Reverted to @tintinweb/pi-subagents in
		// rpiv-pi 1.0.0 once tintinweb resumed active maintenance and shipped
		// 0.6.x against pi-coding-agent ^0.70.5.
		label: "pi-subagents",
		matches: /(^|[^\w/-])pi-subagents(?![-\w])/i,
		reason: "superseded by @tintinweb/pi-subagents (resumed maintenance) in rpiv-pi 1.0.0",
	},
];
