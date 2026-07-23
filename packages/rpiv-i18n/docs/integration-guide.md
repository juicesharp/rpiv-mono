# Localizing your Pi extension

A step-by-step walkthrough for extension authors: declare the SDK as an optional
peer, author a locale directory, register it in one call, and look strings up at
render time. For the API surface alone, see
[sdk-reference.md](./sdk-reference.md).

Three production exemplars in this monorepo follow the exact shape below —
[rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo),
[rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question),
and [rpiv-voice](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-voice).
Read one alongside this guide.

End state on disk:

```
my-extension/
├── index.ts                  ← default export + registerLocalesFromDir(...)
├── state/
│   └── i18n-bridge.ts        ← exports `t` + I18N_NAMESPACE
├── locales/
│   ├── en.json               ← canonical baseline (required)
│   ├── uk.json               ← optional additional locales
│   └── …
└── package.json              ← peerDependencies + files[] + pi.extensions
```

## 1. Declare the SDK as an optional peer dependency

```json
{
  "peerDependencies": {
    "@juicesharp/rpiv-i18n": "*",
    "@earendil-works/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {
    "@juicesharp/rpiv-i18n": { "optional": true }
  }
}
```

Use `peerDependencies`, not `dependencies`. The user's Pi session loads one copy
of the SDK; if you bundle your own, `/languages` toggles a different runtime
instance and your strings never switch.

Mark it `optional: true` so npm does not warn when someone installs your
extension standalone. Paired with the dynamic-import shim in step 3, your
extension stays online with an English-only UI when the SDK is absent and lights
up localization automatically when it is present.

## 2. Author `locales/en.json`

```json
{
  "_meta.notes": "English baseline. Any new key MUST land here first; other locales fall back to it.",

  "welcome.title": "Welcome",
  "submit.button": "Submit",
  "hint.cancel": "Esc to cancel"
}
```

Keys are flat and dotted. `_meta.*` keys are never requested by a lookup — use
them for provenance and work-in-progress notes. Full key and file conventions
live in [translating.md](./translating.md).

## 3. Add a one-file bridge

`state/i18n-bridge.ts` (or wherever your package keeps cross-cutting helpers).
Use a dynamic-import shim with top-level `await` so a missing peer degrades to
English instead of failing module load:

```ts
export const I18N_NAMESPACE = "@my-org/cool-tool";

type ScopeFn = (key: string, fallback: string) => string;
type I18nSDK = { scope: (namespace: string) => ScopeFn };

let scopeImpl: ScopeFn;
try {
  const sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;
  scopeImpl = sdk.scope(I18N_NAMESPACE);
} catch {
  // SDK not installed — every t(key, fallback) returns the fallback verbatim.
  scopeImpl = (_key, fallback) => fallback;
}

export const t: ScopeFn = scopeImpl;
```

Every render call site imports `t` from this one file. If you later switch
namespaces or add a convenience helper, you touch one place.

**Why dynamic import?** A static ESM import is hoisted and evaluated at module
load — if the SDK is not on disk, your whole extension fails to load with
`Cannot find module '@juicesharp/rpiv-i18n'`. The dynamic `await import()` inside
a try/catch lets module load proceed, and the identity-fallback closure keeps
render sites working in English. Top-level `await` is required because `t` is
consumed synchronously by downstream modules.

## 4. Register the locale directory at extension load

One call from the `/loader` subpath reads every `locales/<code>.json` your
package ships and registers them:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";

type I18nLoader = {
  registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

try {
  const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
  sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "my-extension" });
} catch {
  // SDK absent — extension still loads with English-only UI.
}

export default function (pi: ExtensionAPI): void {
  // your tool/command/hook registrations here…
}
```

Notes:

- Import `/loader`, not the package root. The subpath avoids pulling
  `i18n-ui.ts` and `@earendil-works/pi-tui` into your load graph just to
  register strings.
- `import.meta.url` anchors the lookup to **your** package's `locales/`.
- `label` only prefixes the `console.warn` emitted when a locale file fails to
  parse; it defaults to the namespace.
- Adding a new locale later needs **no** code change here — the loader iterates
  `SUPPORTED_LOCALES` from the SDK. Drop the JSON file and ship it.
- Registration runs at module top level, before Pi calls your default export, so
  every locale map is in the registry before the first lookup fires.

## 5. Use `t(key, fallback)` at the render call site

```ts
import { t } from "../state/i18n-bridge.js";

// ✓ Render-time — re-evaluated each render; live `/languages` switches apply
function renderHeader(theme) {
  return new Text(theme.bold(t("welcome.title", "Welcome")));
}

// ✗ Module-init — captured ONCE, freezes English on first load
const HEADING = t("welcome.title", "Welcome");
```

The fallback is the canonical English literal — the same one in `en.json`. Keep
it inline so the file reads end-to-end without locale lookups, and so your
extension stays usable when the SDK is not installed at all.

## 6. Ship the locale files in `package.json`

```json
{
  "files": [
    "index.ts",
    "state/i18n-bridge.ts",
    "locales/",
    "…"
  ]
}
```

The `files[]` manifest is the most common publish-time miss in this monorepo's
history. Ship it in the same commit as the locale JSONs.

## What stays English

Do **not** route these through `t(...)`:

- Tool descriptions, TypeBox `description` fields, prompt guidelines and
  snippets — they go to the LLM. Localizing them risks the model emitting
  localized option labels that bypass exact-string validation.
- Validation errors that flow back through `tool result` envelopes — same
  reason.
- Anything checked by exact-string matching (reserved labels, dispatcher
  discriminants) — keep both sides in canonical English.

The recommended pattern: keep a top-level `const X = "literal"` for the
canonical English so reserved-label checks and tests stay stable, then route the
**render call site** through `t("key", X)`. The SDK never sees `X`; the LLM never
sees `t(...)`.

## Optional: a per-namespace `displayLabel` helper

If your extension has a small enum-typed set of "kind" rows (sentinels,
statuses, modes), a one-line helper keeps render code tight:

```ts
// state/i18n-bridge.ts
import { ROW_INTENT_META, type SentinelKind } from "./row-intent.js";

export function displayLabel(kind: SentinelKind): string {
  return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
```

Render code becomes `displayLabel("next")` instead of
`t("sentinel.next", "Next")` — same lookup, but the canonical English fallback
comes from the same metadata table the rest of your code uses.

## Verify it works before publishing

The SDK only flips strings inside a real Pi session — `npm test` will not catch
a missing `files[]` entry or a wrong namespace. Smoke-test against a live shell:

```sh
# from your extension's directory
pi install ./                                  # register the package directory
pi install npm:@juicesharp/rpiv-i18n           # if not already installed
pi                                             # launch the session
> /languages                                   # pick a non-English locale
> <invoke a command from your extension>       # confirm the strings flip
```

`pi install` takes an npm spec, a git/https/ssh URL, or a local path — it never
unpacks a tarball, so `npm pack` output is not an install source. A local path is
registered in place, which means your working tree is what the session loads.

That is what makes it a runtime check, and also what it cannot check: a local
install reads your files regardless of `package.json` `files[]`. Verify the
publish manifest separately — `npm pack --dry-run` lists exactly what would ship,
and `locales/` must be in it.

The failure mode this session catches that unit tests do not is **module-init
lookup capture** — the picker switches, other extensions flip, yours does not.
Fix: move the `t(...)` call inside the render function.

To make a locale appear in the `/languages` picker itself, it must exist in
`SUPPORTED_LOCALES` in this package's `i18n.ts` — open a PR, or an issue if your
extension lives outside this repo.
