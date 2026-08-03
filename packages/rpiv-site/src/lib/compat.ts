import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PI_PKG = "@earendil-works/pi-coding-agent";

export interface Compat {
	rpivPiVersion: string; // e.g. "2.3.1" — from packages/rpiv-pi/package.json
	/**
	 * The exact `@earendil-works/pi-coding-agent` version the monorepo is built and
	 * tested against — from the root package.json dev pin. Every package declares
	 * `peerDependencies["@earendil-works/pi-coding-agent"]: "*"`, so there is no
	 * published floor to report; the dev pin is the only real compatibility anchor.
	 */
	piCodingAgentFloor: string; // e.g. "0.80.5"
}

export function loadCompat(): Compat {
	const pkgUrl = new URL("../../../rpiv-pi/package.json", import.meta.url);
	const rootPkgUrl = new URL("../../../../package.json", import.meta.url);
	const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8"));
	const rootPkg = JSON.parse(readFileSync(fileURLToPath(rootPkgUrl), "utf8"));
	const tested: unknown = rootPkg.devDependencies?.[PI_PKG];
	if (typeof tested !== "string" || tested.length === 0) {
		throw new Error(`compat: could not read devDependencies["${PI_PKG}"] from root package.json`);
	}
	return {
		rpivPiVersion: pkg.version,
		piCodingAgentFloor: tested,
	};
}
