/**
 * rpiv-workflow — ultra-thin startup-registration entry (~9ms): only the
 * lifecycle + built-in registrars a sibling wires up at extension load, with no
 * loader/DSL/runner graph. Pair `registerBuiltInsProvider` with a thunk that
 * dynamically imports your definitions so they build on first `/wf`, not startup.
 */

export { registerBuiltIns, registerBuiltInsProvider } from "./built-ins.js";
export { registerLifecycle } from "./lifecycle.js";
