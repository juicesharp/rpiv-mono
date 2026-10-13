/**
 * Detect which SIBLINGS are installed: declared in the active Pi settings file,
 * OR actually loaded in this process (#216). Pure utility — no ExtensionAPI.
 *
 * Settings alone miss every sibling that loads some other way: bundled as a
 * resource of another Pi package (a "kit"), installed per-project (`pi install
 * -l`), or loaded with `pi -e`. Those showed a false "missing" banner, and
 * /rpiv-setup then installed duplicate copies whose tools conflict. Presence is
 * the UNION of both signals, so detection can only ever find MORE siblings than
 * the settings-only rule did — never fewer. The runtime snapshot is taken by
 * loaded-siblings.ts and passed in; omitted, every function here is exactly the
 * settings-only rule.
 */

import { SIBLINGS, type SiblingPlugin } from "./siblings.js";
import { readPiAgentSettings } from "./utils.js";

/**
 * What is loaded in this process, read once per pass by `readLoadedSiblingSources`
 * (loaded-siblings.ts): the source paths of every extension that registered a
 * tool or a slash command, plus the presence markers set by siblings that
 * register neither (rpiv-args only hooks events).
 */
export interface LoadedSiblingSources {
	readonly extensionPaths: readonly string[];
	readonly markers: ReadonlySet<string>;
}

function isLoaded(sibling: SiblingPlugin, loaded: LoadedSiblingSources | undefined): boolean {
	if (!loaded) return false;
	if (sibling.marker && loaded.markers.has(sibling.marker)) return true;
	return loaded.extensionPaths.some((path) => sibling.matches.test(path));
}

/** The settings file's string `packages` entries — `undefined` when there is no usable settings file. */
function declaredPackages(): string[] | undefined {
	const result = readPiAgentSettings();
	if (!result) return undefined;
	return result.packages.filter((e): e is string => typeof e === "string");
}

function isInstalled(sibling: SiblingPlugin, declared: string[] | undefined, loaded?: LoadedSiblingSources): boolean {
	return (declared?.some((entry) => sibling.matches.test(entry)) ?? false) || isLoaded(sibling, loaded);
}

/**
 * Return the SIBLINGS neither declared in settings nor loaded. Without
 * `loaded`, this is exactly the settings-only rule (no settings file ⇒ all
 * missing). Reads the settings file once per call — callers that need both the
 * full snapshot and the missing subset should call this once and filter.
 */
export function findMissingSiblings(loaded?: LoadedSiblingSources): SiblingPlugin[] {
	const declared = declaredPackages();
	return SIBLINGS.filter((s) => !isInstalled(s, declared, loaded));
}

/**
 * Return the SIBLINGS declared in settings or loaded — the exact complement of
 * findMissingSiblings for the same `loaded` snapshot and settings read.
 */
export function findInstalledSiblings(loaded?: LoadedSiblingSources): SiblingPlugin[] {
	const declared = declaredPackages();
	return SIBLINGS.filter((s) => isInstalled(s, declared, loaded));
}
