import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Sibling {
	pkg: string; // e.g. @juicesharp/rpiv-advisor
	name: string; // e.g. rpiv-advisor — directory + cover-import key
	description: string; // verbatim from package.json
	homepage: string; // GitHub tree URL from package.json
	npmUrl: string; // https://www.npmjs.com/package/...
	version: string; // lockstep semver from package.json
	role: string; // hand-curated short role label (≤ 18 chars)
	peers: string[]; // external runtime peers, prefix-stripped (pi-* + typebox)
	installCmd: string; // `pi install npm:@juicesharp/rpiv-...`
}

export const SIBLING_NAMES = [
	"rpiv-advisor",
	"rpiv-args",
	"rpiv-ask-user-question",
	"rpiv-btw",
	"rpiv-i18n",
	"rpiv-todo",
	"rpiv-web-tools",
] as const;

export type SiblingName = (typeof SIBLING_NAMES)[number];

/** Hand-curated short role labels (≤ 18 chars) summarizing each sibling at a glance. */
const ROLES: Record<SiblingName, string> = {
	"rpiv-advisor": "advisor model",
	"rpiv-args": "prompt args",
	"rpiv-ask-user-question": "tui prompt",
	"rpiv-btw": "side question",
	"rpiv-i18n": "i18n foundation",
	"rpiv-todo": "live overlay",
	"rpiv-web-tools": "web search",
};

interface PkgJson {
	name: string;
	version: string;
	description: string;
	homepage: string;
	peerDependencies?: Record<string, string>;
}

function readPkg(name: SiblingName): PkgJson {
	const url = new URL(`../../../${name}/package.json`, import.meta.url);
	return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

/** Strip scopes from peer-dep names; drop internal sibling co-deps so the
 * catalog peer signature reads as "external runtime weight" only. */
function shortPeers(peers: Record<string, string> | undefined): string[] {
	if (!peers) return [];
	return Object.keys(peers)
		.map((p) => p.replace(/^@mariozechner\//, "").replace(/^@juicesharp\//, ""))
		.filter((p) => !p.startsWith("rpiv-"));
}

export function loadSiblings(): Sibling[] {
	return SIBLING_NAMES.map((name) => {
		const json = readPkg(name);
		return {
			pkg: json.name,
			name,
			description: json.description,
			homepage: json.homepage,
			npmUrl: `https://www.npmjs.com/package/${json.name}`,
			version: json.version,
			role: ROLES[name],
			peers: shortPeers(json.peerDependencies),
			installCmd: `pi install npm:${json.name}`,
		};
	});
}
